/**
 * CLIProxyAPI dynamic model provider for pi.
 *
 * Supports login-style setup via `/login`:
 * 1. Provider is registered as OAuth-only so `/login CLIProxyAPI` / `/login cliproxyapi`
 *    skip the API-key vs account selector and go straight to multi-field prompts
 *    (pi only supports multi-field prompts on the account/OAuth path).
 * 2. Preferred shortcuts: `/login CLIProxyAPI` or `/login cliproxyapi`.
 * 3. Setup prompts for baseUrl + apiKey.
 * 4. Final login step validates credentials via /v1/models?client_version=pi
 *    (HTTP 200 = success even if the catalog is empty; otherwise re-prompt).
 * 5. On success, models/credentials are saved and registered immediately.
 * 6. `/fast` globally controls catalog-driven priority service tier injection.
 *
 * Uses a patched openai-codex-responses implementation that does not require
 * extracting chatgpt_account_id from the API key (plain CPA keys work).
 *
 * Non-interactive setup still works via env vars or ~/.pi/agent/cliproxyapi.json.
 */

import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CLIPROXYAPI_CODEX_API, type CliproxyCodexStreamSimple, loadCliproxyCodexStreams } from "./codex-stream.ts";
import { FastModeController } from "./fast.ts";
import { FastFooterController } from "./fast-footer.ts";
import {
	CONFIG_FILE_NAME,
	CREDENTIAL_TTL_MS,
	DEFAULT_BASE_URL,
	decodeRefreshMeta,
	encodeRefreshMeta,
	firstNonEmpty,
	isUnauthorizedModelsError,
	loadAuthConnection,
	loadConfigFile,
	type ModelsCacheFile,
	type PiProviderModel,
	resolveConnection,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	resolveMappedModels,
	saveConfigFile,
} from "./lib.ts";

class ConfigPersistenceError extends Error {
	constructor(cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to save ${CONFIG_FILE_NAME}: ${message}`, { cause });
		this.name = "ConfigPersistenceError";
	}
}

function logWarn(message: string): void {
	console.warn(`[pi-cliproxyapi-provider] ${message}`);
}

function logInfo(message: string): void {
	console.info(`[pi-cliproxyapi-provider] ${message}`);
}

function hasLoginCredential(agentDir: string, providerId: string): boolean {
	try {
		return Boolean(loadAuthConnection(agentDir, providerId)?.apiKey);
	} catch {
		return false;
	}
}

function buildOAuthCredentials(baseUrlInput: string, apiKey: string): OAuthCredentials {
	return {
		refresh: encodeRefreshMeta(baseUrlInput),
		access: apiKey,
		expires: Date.now() + CREDENTIAL_TTL_MS,
	};
}

function resolveDefaultBaseUrl(agentDir: string, providerId: string): string {
	let fileBaseUrl: string | undefined;
	try {
		fileBaseUrl = loadConfigFile(agentDir).baseUrl;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			logWarn(`failed to read ${CONFIG_FILE_NAME}: ${err.message}`);
		}
	}

	let authBaseUrl: string | undefined;
	try {
		authBaseUrl = loadAuthConnection(agentDir, providerId)?.baseUrl;
	} catch (error) {
		const err = error as Error;
		logWarn(`failed to read auth.json: ${err.message}`);
	}

	return firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, fileBaseUrl, authBaseUrl, DEFAULT_BASE_URL)!;
}

async function promptConnection(
	callbacks: OAuthLoginCallbacks,
	defaults: { baseUrl: string },
): Promise<{ baseUrlInput: string; apiKey: string }> {
	callbacks.onProgress?.("Configure CLIProxyAPI. Preferred baseUrl form: host:port (e.g. http://127.0.0.1:8317).");

	const baseUrlRaw = await callbacks.onPrompt({
		message: `CLIProxyAPI base URL [${defaults.baseUrl}]:`,
		placeholder: defaults.baseUrl,
		allowEmpty: true,
	});
	const baseUrlInput = firstNonEmpty(baseUrlRaw, defaults.baseUrl)!;

	// Validate early so users get a clear error before typing the API key.
	resolveEndpoints(baseUrlInput);

	const apiKey = (
		await callbacks.onPrompt({
			message: "CLIProxyAPI API key:",
			placeholder: "sk-...",
			allowEmpty: false,
		})
	).trim();

	if (!apiKey) {
		throw new Error("API key cannot be empty.");
	}

	return { baseUrlInput, apiKey };
}

async function configureAndRegister(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	baseUrlInput: string;
	apiKey: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
	fastMode: FastModeController;
}): Promise<{ modelCount: number; modelsUrl: string }> {
	const { pi, agentDir, providerId, providerName, baseUrlInput, apiKey, defaultBaseUrl, streamSimple, fastMode } =
		options;

	const { loaded } = await resolveMappedModels(agentDir, baseUrlInput, apiKey, { forceRefresh: true });

	try {
		saveConfigFile(agentDir, {
			baseUrl: baseUrlInput,
			apiKey,
			providerId,
			providerName,
		});
	} catch (error) {
		throw new ConfigPersistenceError(error);
	}

	// /login stores oauth credentials itself; keep the provider OAuth-only so
	// `/login <provider>` skips the API-key vs account selector.
	registerProvider(pi, {
		providerId,
		providerName,
		baseUrlInput,
		models: loaded.models,
		defaultBaseUrl: baseUrlInput || defaultBaseUrl,
		agentDir,
		streamSimple,
		fastMode,
	});
	fastMode.setSupportedModelIds(loaded.fastModelIds);

	return { modelCount: loaded.models.length, modelsUrl: loaded.modelsUrl };
}

function createOAuthHandlers(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
	fastMode: FastModeController;
}) {
	const { pi, agentDir, providerId, providerName, defaultBaseUrl, streamSimple, fastMode } = options;

	return {
		name: providerName,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			let promptDefaultBaseUrl = resolveDefaultBaseUrl(agentDir, providerId) || defaultBaseUrl;

			// Final login step: validate by calling /v1/models.
			// HTTP 200 (even with an empty catalog) means success; otherwise re-prompt.
			while (true) {
				const { baseUrlInput, apiKey } = await promptConnection(callbacks, {
					baseUrl: promptDefaultBaseUrl,
				});

				callbacks.onProgress?.("Validating credentials via models endpoint...");
				try {
					const result = await configureAndRegister({
						pi,
						agentDir,
						providerId,
						providerName,
						baseUrlInput,
						apiKey,
						defaultBaseUrl,
						streamSimple,
						fastMode,
					});

					logInfo(`login ok: registered ${result.modelCount} models from ${result.modelsUrl}`);
					return buildOAuthCredentials(baseUrlInput, apiKey);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logWarn(`login validation failed: ${message}`);
					if (error instanceof ConfigPersistenceError) {
						callbacks.onProgress?.(message);
						throw error;
					}
					callbacks.onProgress?.(`Login validation failed: ${message}\nPlease re-enter base URL and API key.`);
					// Keep last baseUrl as the next default so retyping is easier.
					promptDefaultBaseUrl = baseUrlInput || promptDefaultBaseUrl;
				}
			}
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			// API keys do not expire; keep the stored payload as-is.
			return {
				...credentials,
				expires: Date.now() + CREDENTIAL_TTL_MS,
			};
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},

		modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
			const meta = decodeRefreshMeta(credentials.refresh);
			if (!meta?.baseUrl) {
				return models;
			}
			try {
				const { inferenceBaseUrl } = resolveEndpoints(meta.baseUrl);
				return models.map((model) =>
					model.provider === providerId ? { ...model, baseUrl: inferenceBaseUrl } : model,
				);
			} catch {
				return models;
			}
		},
	};
}

function registerProvider(
	pi: ExtensionAPI,
	options: {
		providerId: string;
		providerName: string;
		baseUrlInput: string;
		apiKey?: string;
		models?: PiProviderModel[];
		defaultBaseUrl: string;
		agentDir: string;
		streamSimple: CliproxyCodexStreamSimple;
		fastMode: FastModeController;
	},
): void {
	const { providerId, providerName, baseUrlInput, apiKey, models, defaultBaseUrl, agentDir, streamSimple, fastMode } =
		options;

	const endpoints = resolveEndpoints(baseUrlInput);
	const oauth = createOAuthHandlers({
		pi,
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
	});

	// Replace any previous registration so an earlier ambient apiKey does not linger
	// via registerProvider merge semantics and reintroduce the auth-type selector.
	pi.unregisterProvider(providerId);

	pi.registerProvider(providerId, {
		name: providerName,
		baseUrl: endpoints.inferenceBaseUrl,
		api: CLIPROXYAPI_CODEX_API,
		streamSimple,
		// OAuth-only keeps `/login <provider>` on the multi-field account path.
		// Pass apiKey only for ambient request auth when no /login credential exists
		// (config file / env). Never pass both for /login flows.
		oauth,
		...(apiKey ? { apiKey } : {}),
		...(models && models.length > 0 ? { models } : {}),
	});
}

export function registerFastCommand(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	fastMode: FastModeController;
	onStatusChange?: (ctx: ExtensionContext) => void;
}): void {
	const { pi, agentDir, providerId, fastMode, onStatusChange } = options;

	pi.registerCommand("fast", {
		description: "Toggle CLIProxyAPI Fast mode globally.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /fast", "error");
				return;
			}

			const enabled = !fastMode.isEnabled();
			try {
				saveConfigFile(agentDir, { fast: enabled });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to save Fast mode: ${message}`, "error");
				return;
			}
			fastMode.setEnabled(enabled);
			onStatusChange?.(ctx);

			const currentModel = ctx.model;
			if (!currentModel || currentModel.provider !== providerId || !fastMode.isModelSupported(currentModel.id)) {
				if (enabled) {
					ctx.ui.notify("Fast mode is enabled globally, but the current model does not support it.", "warning");
				} else {
					ctx.ui.notify("Fast mode is disabled globally.", "info");
				}
			}
		},
	});
}

export function registerRefreshCommand(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
	fastMode: FastModeController;
}): void {
	const { pi, agentDir, providerId, providerName, defaultBaseUrl, streamSimple, fastMode } = options;

	pi.registerCommand("cliproxyapi-refresh", {
		description: "Force refresh CLIProxyAPI models from the remote catalog.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /cliproxyapi-refresh", "error");
				return;
			}

			const connection = resolveConnection(agentDir, providerId);
			if (!connection) {
				ctx.ui.notify(
					`CLIProxyAPI is not configured. Use /login ${providerName} or /login ${providerId}.`,
					"error",
				);
				return;
			}

			try {
				const { loaded } = await resolveMappedModels(agentDir, connection.baseUrlInput, connection.apiKey, {
					forceRefresh: true,
				});
				fastMode.setSupportedModelIds(loaded.fastModelIds);

				const hasStoredLogin = hasLoginCredential(agentDir, providerId);
				registerProvider(pi, {
					providerId,
					providerName,
					baseUrlInput: connection.baseUrlInput,
					apiKey: hasStoredLogin ? undefined : connection.apiKey,
					models: loaded.models,
					defaultBaseUrl,
					agentDir,
					streamSimple,
					fastMode,
				});

				ctx.ui.notify(`Refreshed ${loaded.models.length} CLIProxyAPI models from ${loaded.modelsUrl}.`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to refresh CLIProxyAPI models: ${message}`, "error");
			}
		},
	});
}

export { CLIPROXYAPI_CODEX_API } from "./codex-stream.ts";
export { resolveEndpoints, toPiModel } from "./lib.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const identity = resolveIdentity(agentDir);
	const defaultBaseUrl = resolveDefaultBaseUrl(agentDir, identity.providerId);

	let fastEnabled = false;
	try {
		fastEnabled = resolveFastDefault(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid Fast configuration (${message}); using fast=false`);
	}
	const fastMode = new FastModeController(fastEnabled);

	let streamSimple: CliproxyCodexStreamSimple;
	try {
		const streams = await loadCliproxyCodexStreams([identity.providerId, "cliproxyapi"], {
			shouldUseFast: (model) => model.provider === identity.providerId && fastMode.isEffectiveFor(model.id),
		});
		streamSimple = streams.streamSimple;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`failed to load patched codex protocol: ${message}`);
		return;
	}

	const fastFooter = new FastFooterController(identity.providerId, fastMode);
	registerFastCommand({
		pi,
		agentDir,
		providerId: identity.providerId,
		fastMode,
		onStatusChange: (ctx) => fastFooter.refresh(ctx),
	});
	registerRefreshCommand({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
	});
	fastFooter.register(pi);

	// Always register oauth so the provider is visible in /login immediately after install.
	registerProvider(pi, {
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: defaultBaseUrl,
		defaultBaseUrl,
		agentDir,
		streamSimple,
		fastMode,
	});

	const connection = resolveConnection(agentDir, identity.providerId);
	if (!connection) {
		logInfo(
			`not configured yet. Use /login ${identity.providerName} or /login ${identity.providerId}. ` +
				`Menu path: /login → Sign in with an account → ${identity.providerName}. ` +
				`Or set ${CONFIG_FILE_NAME} / CLIPROXYAPI_API_KEY.`,
		);
		return;
	}

	try {
		const { loaded, fromCache, stale } = await resolveMappedModels(
			agentDir,
			connection.baseUrlInput,
			connection.apiKey,
		);
		fastMode.setSupportedModelIds(loaded.fastModelIds);

		if (fromCache && stale) {
			const fetchedAt = (loaded as ModelsCacheFile).fetchedAt;
			logWarn(
				`using stale model cache from ${new Date(fetchedAt).toISOString()}; ` +
					`use /cliproxyapi-refresh to update.`,
			);
		}

		// Prefer OAuth-only registration when /login already stored credentials so
		// `/login <provider>` jumps straight into the multi-field flow. Fall back to
		// ambient apiKey only for config-file / env setups without auth.json.
		const hasStoredLogin = hasLoginCredential(agentDir, identity.providerId);
		registerProvider(pi, {
			providerId: identity.providerId,
			providerName: identity.providerName,
			baseUrlInput: connection.baseUrlInput,
			apiKey: hasStoredLogin ? undefined : connection.apiKey,
			models: loaded.models,
			defaultBaseUrl,
			agentDir,
			streamSimple,
			fastMode,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isUnauthorizedModelsError(error)) {
			logWarn(`models request unauthorized (${message}). Use /login ${identity.providerName} to reconfigure.`);
		} else {
			logWarn(
				`failed to load models (${message}). Use /login ${identity.providerName} or check ${CONFIG_FILE_NAME} / CLIPROXYAPI_* env vars.`,
			);
		}
	}
}
