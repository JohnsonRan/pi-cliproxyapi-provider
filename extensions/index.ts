/**
 * CLIProxyAPI dynamic model provider for pi.
 *
 * Supports login-style setup via `/login` and dedicated commands:
 * 1. Provider always appears under "Use a subscription" as CLIProxyAPI
 *    (pi only supports multi-field prompts on the oauth/subscription path).
 * 2. Preferred shortcuts: `/login CLIProxyAPI`, `/login cliproxyapi`,
 *    or dedicated commands `/cliproxyapi` / `/cpa` (shown only when not authenticated).
 * 3. Setup prompts for baseUrl + apiKey.
 * 4. Final login step validates credentials via /v1/models?client_version=pi
 *    (HTTP 200 = success even if the catalog is empty; otherwise re-prompt).
 * 5. On success, models/credentials are saved and `/cliproxyapi` `/cpa` are hidden.
 * 6. Setup commands reappear after `/logout` or when a models request returns HTTP 401.
 *
 * Uses a patched openai-codex-responses implementation that does not require
 * extracting chatgpt_account_id from the API key (plain CPA keys work).
 *
 * Non-interactive setup still works via env vars or ~/.pi/agent/cliproxyapi.json.
 */

import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	CLIPROXYAPI_CODEX_API,
	type CliproxyCodexStreamSimple,
	loadCliproxyCodexStreams,
} from "./codex-stream.ts";
import {
	CONFIG_FILE_NAME,
	CREDENTIAL_TTL_MS,
	DEFAULT_BASE_URL,
	type PiProviderModel,
	decodeRefreshMeta,
	encodeRefreshMeta,
	firstNonEmpty,
	isUnauthorizedModelsError,
	loadAuthConnection,
	loadConfigFile,
	loadMappedModels,
	resolveConnection,
	resolveEndpoints,
	resolveIdentity,
	saveConfigFile,
} from "./lib.ts";

/** Controls visibility of /cliproxyapi and /cpa in the slash-command menu. */
interface SetupCommandsController {
	show(): void;
	hide(): void;
	isVisible(): boolean;
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

	return firstNonEmpty(
		process.env.CLIPROXYAPI_BASE_URL,
		fileBaseUrl,
		authBaseUrl,
		DEFAULT_BASE_URL,
	)!;
}

async function promptConnection(
	callbacks: OAuthLoginCallbacks,
	defaults: { baseUrl: string },
): Promise<{ baseUrlInput: string; apiKey: string }> {
	callbacks.onProgress?.(
		"Configure CLIProxyAPI. Preferred baseUrl form: host:port (e.g. http://127.0.0.1:8317).",
	);

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
	} = options;

	const loaded = await loadMappedModels(baseUrlInput, apiKey);

	saveConfigFile(agentDir, {
		baseUrl: baseUrlInput,
		apiKey,
		providerId,
		providerName,
	});

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
	});

	// Login succeeded — hide dedicated setup commands from the slash menu.
	setupCommands.hide();

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
}) {
	const { pi, agentDir, providerId, providerName, defaultBaseUrl, streamSimple, setupCommands } =
		options;

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
					});

					logInfo(
						`login ok: registered ${result.modelCount} models from ${result.modelsUrl}`,
					);
					return buildOAuthCredentials(baseUrlInput, apiKey);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logWarn(`login validation failed: ${message}`);
					// Auth failures should keep setup commands available for reconfiguration.
					if (isUnauthorizedModelsError(error)) {
						setupCommands.show();
					}
					callbacks.onProgress?.(
						`Login validation failed: ${message}\nPlease re-enter base URL and API key.`,
					);
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

		modifyModels(models, credentials) {
			const meta = decodeRefreshMeta(credentials.refresh);
			if (!meta?.baseUrl) {
				return models;
			}
			try {
				const { inferenceBaseUrl } = resolveEndpoints(meta.baseUrl);
				return models.map((model) =>
					model.provider === providerId
						? { ...model, baseUrl: inferenceBaseUrl }
						: model,
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

const SETUP_COMMAND_NAMES = ["cliproxyapi", "cpa"] as const;

/** Avoid double-wrapping the same AuthStorage instance across session reloads. */
const logoutWatchedStorages = new WeakSet<object>();

/**
 * pi has no logout extension event. Wrap authStorage.logout so we can re-show
 * setup commands when this provider is removed via /logout.
 */
function watchProviderLogout(
	authStorage: { logout(provider: string): void },
	providerId: string,
	onLogout: () => void,
): void {
	if (logoutWatchedStorages.has(authStorage as object)) {
		return;
	}
	logoutWatchedStorages.add(authStorage as object);

	const originalLogout = authStorage.logout.bind(authStorage);
	authStorage.logout = (provider: string): void => {
		originalLogout(provider);
		if (provider === providerId) {
			onLogout();
		}
	};
}

/**
 * Show/hide /cliproxyapi and /cpa.
 *
 * pi has registerCommand but no unregisterCommand, so hide() removes entries from the
 * extension's internal commands Map captured during the first registration.
 */
function createSetupCommandsController(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
}): SetupCommandsController {
	const { pi, agentDir, providerId, providerName, defaultBaseUrl, streamSimple } = options;

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

		const promptDefaultBaseUrl = resolveDefaultBaseUrl(agentDir, providerId) || defaultBaseUrl;

		const baseUrlRaw = await ctx.ui.input(
			`CLIProxyAPI base URL [${promptDefaultBaseUrl}]:`,
			promptDefaultBaseUrl,
		);
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
				});

				// Persist only after successful validation; keep AuthStorage in-memory too.
				ctx.modelRegistry.authStorage.set(providerId, {
					type: "oauth",
					...buildOAuthCredentials(currentBaseUrl, currentApiKey),
				});

				logInfo(
					`command setup ok: registered ${result.modelCount} models from ${result.modelsUrl}`,
				);
				ctx.ui.notify(
					`CLIProxyAPI configured: ${result.modelCount} models from ${result.modelsUrl}`,
					"info",
				);
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logWarn(`command setup failed: ${message}`);
				if (isUnauthorizedModelsError(error)) {
					setupCommands.show();
				}
				ctx.ui.notify(
					`CLIProxyAPI validation failed: ${message}. Please re-enter base URL and API key.`,
					"error",
				);
			}

			// Collect replacement credentials before retrying validation.
			while (true) {
				const retryBaseUrlRaw = await ctx.ui.input(
					`CLIProxyAPI base URL [${currentBaseUrl}]:`,
					currentBaseUrl,
				);
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

	const commandSpecs: Array<{ name: (typeof SETUP_COMMAND_NAMES)[number]; description: string }> =
		[
			{
				name: "cliproxyapi",
				description:
					"Configure CLIProxyAPI (baseUrl + API key) and load models. Prefer this or /login CLIProxyAPI.",
			},
			{
				name: "cpa",
				description: "Alias for /cliproxyapi — configure CLIProxyAPI and load models.",
			},
		];

	const registerAll = (): void => {
		for (const spec of commandSpecs) {
			pi.registerCommand(spec.name, {
				description: spec.description,
				handler,
			});
		}
	};

	setupCommands.show = (): void => {
		if (visible) {
			return;
		}

		if (!commandMap) {
			// Capture the extension.commands Map during first registration.
			const originalSet = Map.prototype.set;
			Map.prototype.set = function setWithCapture(
				this: Map<unknown, unknown>,
				key: unknown,
				value: unknown,
			) {
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
				registerAll();
			} finally {
				Map.prototype.set = originalSet;
			}
			if (!commandMap) {
				logWarn(
					"could not capture command map; /cliproxyapi and /cpa cannot be hidden after login",
				);
			}
		} else {
			registerAll();
		}

		visible = true;
		logInfo("setup commands shown: /cliproxyapi, /cpa");
	};

	setupCommands.hide = (): void => {
		if (!visible) {
			return;
		}
		if (!commandMap) {
			logWarn("setup commands remain visible (no command map capture for unregister)");
			return;
		}
		for (const name of SETUP_COMMAND_NAMES) {
			commandMap.delete(name);
		}
		visible = false;
		logInfo("setup commands hidden (CLIProxyAPI already authenticated)");
	};

	setupCommands.isVisible = (): boolean => visible;

	return setupCommands;
}

export { CLIPROXYAPI_CODEX_API } from "./codex-stream.ts";
export { resolveEndpoints, toPiModel } from "./lib.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const identity = resolveIdentity(agentDir);
	const defaultBaseUrl = resolveDefaultBaseUrl(agentDir, identity.providerId);

	let streamSimple: CliproxyCodexStreamSimple;
	try {
		const streams = await loadCliproxyCodexStreams([identity.providerId, "cliproxyapi"]);
		streamSimple = streams.streamSimple;
		logInfo(`using patched protocol api=${streams.api}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`failed to load patched codex protocol: ${message}`);
		return;
	}

	const setupCommands = createSetupCommandsController({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		defaultBaseUrl,
		streamSimple,
	});

	// Re-show setup commands when the user /logout this provider.
	// Installed on session_start because AuthStorage is only available via ctx then.
	pi.on("session_start", (_event, ctx) => {
		watchProviderLogout(ctx.modelRegistry.authStorage, identity.providerId, () => {
			setupCommands.show();
			logInfo(
				`logout detected for ${identity.providerId}: setup commands restored: /cliproxyapi, /cpa`,
			);
		});
	});

	// Always register oauth so the provider is visible in /login immediately after install.
	registerProvider(pi, {
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: defaultBaseUrl,
		defaultBaseUrl,
		agentDir,
		streamSimple,
		setupCommands,
	});

	const connection = resolveConnection(agentDir, identity.providerId);
	if (!connection) {
		setupCommands.show();
		logInfo(
			`not configured yet. Prefer /cliproxyapi (or /cpa), or /login ${identity.providerName}. ` +
				`Menu path: /login → Use a subscription → ${identity.providerName}. ` +
				`Or set ${CONFIG_FILE_NAME} / CLIPROXYAPI_API_KEY.`,
		);
		return;
	}

	try {
		const loaded = await loadMappedModels(connection.baseUrlInput, connection.apiKey);
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
		});
		// Already authenticated — keep /cliproxyapi and /cpa hidden.
		setupCommands.hide();
		logInfo(`loaded ${loaded.models.length} models from ${loaded.modelsUrl}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isUnauthorizedModelsError(error)) {
			// 401 → credentials rejected; re-show setup commands for reconfiguration.
			setupCommands.show();
			logWarn(
				`models request unauthorized (${message}). Setup commands restored: /cliproxyapi, /cpa.`,
			);
		} else {
			// Other failures (network, etc.): still offer setup so the user can fix baseUrl/key.
			setupCommands.show();
			logWarn(
				`failed to load models (${message}). Provider remains available via /cliproxyapi or /login for reconfiguration.`,
			);
		}
	}
}
