/**
 * CLIProxyAPI dynamic model provider for pi.
 *
 * Supports login-style setup via `/login` and a dedicated command:
 * 1. Provider always appears under "Sign in with an account" as CLIProxyAPI
 *    (pi only supports multi-field prompts on the account/OAuth path).
 * 2. Preferred shortcuts: `/login CLIProxyAPI`, `/login cliproxyapi`,
 *    or the dedicated `/cliproxyapi` command.
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
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
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
	loadMappedModels,
	type PiProviderModel,
	resolveConnection,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	saveConfigFile,
} from "./lib.ts";

/** Registers /cliproxyapi in the slash-command menu. */
interface SetupCommandsController {
	show(): void;
}

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
	setupCommands: SetupCommandsController;
	fastMode: FastModeController;
}): Promise<{ modelCount: number; modelsUrl: string }> {
	const {
		pi,
		agentDir,
		providerId,
		providerName,
		baseUrlInput,
		apiKey,
		defaultBaseUrl,
		streamSimple,
		setupCommands,
		fastMode,
	} = options;

	const loaded = await loadMappedModels(baseUrlInput, apiKey);

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

	registerProvider(pi, {
		providerId,
		providerName,
		baseUrlInput,
		apiKey,
		models: loaded.models,
		defaultBaseUrl: baseUrlInput || defaultBaseUrl,
		agentDir,
		streamSimple,
		setupCommands,
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
	setupCommands: SetupCommandsController;
	fastMode: FastModeController;
}) {
	const { pi, agentDir, providerId, providerName, defaultBaseUrl, streamSimple, setupCommands, fastMode } = options;

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
						setupCommands,
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
					// Auth failures should keep the setup command available for reconfiguration.
					if (isUnauthorizedModelsError(error)) {
						setupCommands.show();
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
		setupCommands: SetupCommandsController;
		fastMode: FastModeController;
	},
): void {
	const {
		providerId,
		providerName,
		baseUrlInput,
		apiKey,
		models,
		defaultBaseUrl,
		agentDir,
		streamSimple,
		setupCommands,
		fastMode,
	} = options;

	const endpoints = resolveEndpoints(baseUrlInput);
	const oauth = createOAuthHandlers({
		pi,
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
		streamSimple,
		setupCommands,
		fastMode,
	});

	pi.registerProvider(providerId, {
		name: providerName,
		baseUrl: endpoints.inferenceBaseUrl,
		api: CLIPROXYAPI_CODEX_API,
		streamSimple,
		// Keep oauth always registered so /login lists this provider even before models exist.
		oauth,
		// apiKey is optional when oauth is present; include it when known for direct use.
		...(apiKey ? { apiKey } : {}),
		...(models && models.length > 0 ? { models } : {}),
	});
}

/** Register the always-available /cliproxyapi setup command. */
function createSetupCommandsController(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
	fastMode: FastModeController;
}): SetupCommandsController {
	const { pi, agentDir, providerId, providerName, defaultBaseUrl, streamSimple, fastMode } = options;

	// Self-referential controller so validation failures can ensure commands are registered.
	const setupCommands: SetupCommandsController = {
		show() {
			/* replaced below */
		},
	};

	let visible = false;

	const handler = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`Interactive UI unavailable. Use /login ${providerName}, set ${CONFIG_FILE_NAME}, or CLIPROXYAPI_* env vars.`,
				"error",
			);
			return;
		}

		if (loadAuthConnection(agentDir, providerId)?.apiKey) {
			ctx.ui.notify(
				`CLIProxyAPI credentials are already stored by /login. Use /login ${providerName} to replace them, or run /logout before /cliproxyapi.`,
				"error",
			);
			return;
		}

		const promptDefaultBaseUrl = resolveDefaultBaseUrl(agentDir, providerId) || defaultBaseUrl;

		const baseUrlRaw = await ctx.ui.input(`CLIProxyAPI base URL [${promptDefaultBaseUrl}]:`, promptDefaultBaseUrl);
		if (baseUrlRaw === undefined) {
			ctx.ui.notify("CLIProxyAPI setup cancelled.", "info");
			return;
		}
		const baseUrlInput = firstNonEmpty(baseUrlRaw, promptDefaultBaseUrl)!;

		try {
			resolveEndpoints(baseUrlInput);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Invalid base URL: ${message}`, "error");
			return;
		}

		const apiKeyRaw = await ctx.ui.input("CLIProxyAPI API key:", "sk-...");
		if (apiKeyRaw === undefined) {
			ctx.ui.notify("CLIProxyAPI setup cancelled.", "info");
			return;
		}
		const apiKey = apiKeyRaw.trim();
		if (!apiKey) {
			ctx.ui.notify("API key cannot be empty.", "error");
			return;
		}

		// Final setup step: validate by calling /v1/models.
		// HTTP 200 (even with an empty catalog) means success; otherwise re-prompt.
		let currentBaseUrl = baseUrlInput;
		let currentApiKey = apiKey;
		while (true) {
			try {
				const result = await configureAndRegister({
					pi,
					agentDir,
					providerId,
					providerName,
					baseUrlInput: currentBaseUrl,
					apiKey: currentApiKey,
					defaultBaseUrl,
					streamSimple,
					setupCommands,
					fastMode,
				});

				logInfo(`command setup ok: registered ${result.modelCount} models from ${result.modelsUrl}`);
				ctx.ui.notify(`CLIProxyAPI configured: ${result.modelCount} models from ${result.modelsUrl}`, "info");
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logWarn(`command setup failed: ${message}`);
				if (error instanceof ConfigPersistenceError) {
					ctx.ui.notify(message, "error");
					return;
				}
				if (isUnauthorizedModelsError(error)) {
					setupCommands.show();
				}
				ctx.ui.notify(`CLIProxyAPI validation failed: ${message}. Please re-enter base URL and API key.`, "error");
			}

			// Collect replacement credentials before retrying validation.
			while (true) {
				const retryBaseUrlRaw = await ctx.ui.input(`CLIProxyAPI base URL [${currentBaseUrl}]:`, currentBaseUrl);
				if (retryBaseUrlRaw === undefined) {
					ctx.ui.notify("CLIProxyAPI setup cancelled.", "info");
					return;
				}
				const retryBaseUrl = firstNonEmpty(retryBaseUrlRaw, currentBaseUrl)!;
				try {
					resolveEndpoints(retryBaseUrl);
				} catch (urlError) {
					const urlMessage = urlError instanceof Error ? urlError.message : String(urlError);
					ctx.ui.notify(`Invalid base URL: ${urlMessage}`, "error");
					continue;
				}

				const retryApiKeyRaw = await ctx.ui.input("CLIProxyAPI API key:", "sk-...");
				if (retryApiKeyRaw === undefined) {
					ctx.ui.notify("CLIProxyAPI setup cancelled.", "info");
					return;
				}
				const retryApiKey = retryApiKeyRaw.trim();
				if (!retryApiKey) {
					ctx.ui.notify("API key cannot be empty.", "error");
					continue;
				}

				currentBaseUrl = retryBaseUrl;
				currentApiKey = retryApiKey;
				break;
			}
		}
	};

	const registerCommand = (): void => {
		pi.registerCommand("cliproxyapi", {
			description: "Configure CLIProxyAPI (baseUrl + API key) and load models. Prefer this or /login CLIProxyAPI.",
			handler,
		});
	};

	setupCommands.show = (): void => {
		if (visible) {
			return;
		}
		registerCommand();
		visible = true;
		logInfo("setup command registered: /cliproxyapi");
	};

	return setupCommands;
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
	fastFooter.register(pi);

	const setupCommands = createSetupCommandsController({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		defaultBaseUrl,
		streamSimple,
		fastMode,
	});

	setupCommands.show();

	// Always register oauth so the provider is visible in /login immediately after install.
	registerProvider(pi, {
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: defaultBaseUrl,
		defaultBaseUrl,
		agentDir,
		streamSimple,
		setupCommands,
		fastMode,
	});

	const connection = resolveConnection(agentDir, identity.providerId);
	if (!connection) {
		setupCommands.show();
		logInfo(
			`not configured yet. Prefer /cliproxyapi or /login ${identity.providerName}. ` +
				`Menu path: /login → Sign in with an account → ${identity.providerName}. ` +
				`Or set ${CONFIG_FILE_NAME} / CLIPROXYAPI_API_KEY.`,
		);
		return;
	}

	try {
		const loaded = await loadMappedModels(connection.baseUrlInput, connection.apiKey);
		fastMode.setSupportedModelIds(loaded.fastModelIds);
		registerProvider(pi, {
			providerId: identity.providerId,
			providerName: identity.providerName,
			baseUrlInput: connection.baseUrlInput,
			apiKey: connection.apiKey,
			models: loaded.models,
			defaultBaseUrl,
			agentDir,
			streamSimple,
			setupCommands,
			fastMode,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isUnauthorizedModelsError(error)) {
			// 401 → credentials rejected; keep the setup command available for reconfiguration.
			setupCommands.show();
			logWarn(`models request unauthorized (${message}). Setup command remains available: /cliproxyapi.`);
		} else {
			// Other failures (network, etc.): still offer setup so the user can fix baseUrl/key.
			setupCommands.show();
			logWarn(
				`failed to load models (${message}). Provider remains available via /cliproxyapi or /login for reconfiguration.`,
			);
		}
	}
}
