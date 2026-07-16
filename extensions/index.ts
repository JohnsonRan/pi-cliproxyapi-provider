/**
 * CLIProxyAPI dynamic model provider for pi.
 *
 * Supports login-style setup via `/login` and a dedicated command:
 * 1. Provider is registered as OAuth-only so `/login CLIProxyAPI` / `/login cliproxyapi`
 *    skip the API-key vs account selector and go straight to multi-field prompts
 *    (pi only supports multi-field prompts on the account/OAuth path).
 * 2. Preferred shortcuts: `/login CLIProxyAPI`, `/login cliproxyapi`,
 *    or the dedicated `/cliproxyapi` command (hidden after successful /login).
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

/** Show/hide /cliproxyapi in the slash-command menu. */
interface SetupCommandsController {
	show(): void;
	hide(): void;
	isVisible(): boolean;
	/** Hide when /login credentials exist; show otherwise. */
	syncFromAuth(): void;
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
	/**
	 * When true, register a configured API key for ambient request auth.
	 * Only used by `/cliproxyapi` (no auth.json write). `/login` must leave this
	 * false so the provider stays OAuth-only and `/login <provider>` skips the
	 * API-key vs account selector.
	 */
	registerConfiguredApiKey?: boolean;
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
		registerConfiguredApiKey = false,
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
		apiKey: registerConfiguredApiKey ? apiKey : undefined,
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

					// /login succeeded — dedicated setup is unnecessary until logout.
					setupCommands.hide();
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
		// (config file / env / `/cliproxyapi`). Never pass both for /login flows.
		oauth,
		...(apiKey ? { apiKey } : {}),
		...(models && models.length > 0 ? { models } : {}),
	});
}

/**
 * Register /cliproxyapi and allow hiding it after /login.
 *
 * pi has registerCommand but no unregisterCommand, so hide() removes the entry
 * from the extension's internal commands Map captured during first registration.
 */
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

	// Self-referential controller so handlers can hide/show after validation.
	const setupCommands: SetupCommandsController = {
		show() {
			/* replaced below */
		},
		hide() {
			/* replaced below */
		},
		isVisible() {
			return false;
		},
		syncFromAuth() {
			/* replaced below */
		},
	};

	let visible = false;
	// Captured extension.commands Map (pi has no public unregisterCommand API).
	let commandMap: Map<string, unknown> | null = null;

	const handler = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`Interactive UI unavailable. Use /login ${providerName}, set ${CONFIG_FILE_NAME}, or CLIPROXYAPI_* env vars.`,
				"error",
			);
			return;
		}

		if (loadAuthConnection(agentDir, providerId)?.apiKey) {
			// Still authenticated via /login — hide the dedicated command and redirect.
			setupCommands.hide();
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
					// Dedicated command does not write auth.json; keep ambient apiKey
					// so requests work in the current session.
					registerConfiguredApiKey: true,
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

		if (!commandMap) {
			// Capture the extension.commands Map during first registration.
			const originalSet = Map.prototype.set;
			Map.prototype.set = function setWithCapture(this: Map<unknown, unknown>, key: unknown, value: unknown) {
				if (
					key === "cliproxyapi" &&
					value &&
					typeof value === "object" &&
					"handler" in (value as Record<string, unknown>)
				) {
					commandMap = this as Map<string, unknown>;
				}
				return originalSet.call(this, key, value);
			} as typeof Map.prototype.set;
			try {
				registerCommand();
			} finally {
				Map.prototype.set = originalSet;
			}
			if (!commandMap) {
				logWarn("could not capture command map; /cliproxyapi cannot be hidden after login");
			}
		} else {
			registerCommand();
		}

		visible = true;
		logInfo("setup command shown: /cliproxyapi");
	};

	setupCommands.hide = (): void => {
		if (!visible) {
			return;
		}
		if (!commandMap) {
			logWarn("setup command remains visible (no command map capture for unregister)");
			return;
		}
		commandMap.delete("cliproxyapi");
		visible = false;
		logInfo("setup command hidden (CLIProxyAPI already authenticated via /login)");
	};

	setupCommands.isVisible = (): boolean => visible;

	setupCommands.syncFromAuth = (): void => {
		if (loadAuthConnection(agentDir, providerId)?.apiKey) {
			setupCommands.hide();
		} else {
			setupCommands.show();
		}
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

	// Reconcile visibility after /logout (auth.json removed) or when credentials reappear.
	// pi has no logout extension event, so re-check on session lifecycle and submitted input.
	pi.on("session_start", () => {
		setupCommands.syncFromAuth();
	});
	pi.on("input", () => {
		setupCommands.syncFromAuth();
	});

	// Initial visibility: hide when already logged in via /login.
	setupCommands.syncFromAuth();

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
		setupCommands.syncFromAuth();
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
		// Prefer OAuth-only registration when /login already stored credentials so
		// `/login <provider>` jumps straight into the multi-field flow. Fall back to
		// ambient apiKey only for config-file / env setups without auth.json.
		const hasStoredLogin = Boolean(loadAuthConnection(agentDir, identity.providerId)?.apiKey);
		registerProvider(pi, {
			providerId: identity.providerId,
			providerName: identity.providerName,
			baseUrlInput: connection.baseUrlInput,
			apiKey: hasStoredLogin ? undefined : connection.apiKey,
			models: loaded.models,
			defaultBaseUrl,
			agentDir,
			streamSimple,
			setupCommands,
			fastMode,
		});
		// Keep /cliproxyapi hidden when authenticated via /login; show for config-only setups.
		setupCommands.syncFromAuth();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isUnauthorizedModelsError(error)) {
			// 401 → prefer /login when auth.json still has a credential; otherwise show setup.
			setupCommands.syncFromAuth();
			logWarn(
				`models request unauthorized (${message}). ` +
					(setupCommands.isVisible()
						? "Setup command available: /cliproxyapi."
						: `Use /login ${identity.providerName} or /logout then /cliproxyapi.`),
			);
		} else {
			// Other failures (network, etc.): still offer setup when not logged in via /login.
			setupCommands.syncFromAuth();
			logWarn(
				`failed to load models (${message}). Provider remains available via ` +
					(setupCommands.isVisible() ? "/cliproxyapi or " : "") +
					`/login for reconfiguration.`,
			);
		}
	}
}
