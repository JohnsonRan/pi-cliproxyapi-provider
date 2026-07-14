/**
 * CLIProxyAPI dynamic model provider for pi.
 *
 * Supports login-style setup via `/login` and dedicated commands:
 * 1. Provider always appears under "Use a subscription" as CLIProxyAPI
 *    (pi only supports multi-field prompts on the oauth/subscription path).
 * 2. Preferred shortcuts: `/login CLIProxyAPI`, `/login cliproxyapi`,
 *    or dedicated commands `/cliproxyapi` / `/cpa`.
 * 3. Setup prompts for baseUrl + apiKey.
 * 4. Models are fetched from /v1/models?client_version=pi and registered.
 * 5. Credentials are stored in auth.json; baseUrl/apiKey also written to cliproxyapi.json.
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
	loadAuthConnection,
	loadConfigFile,
	loadMappedModels,
	resolveConnection,
	resolveEndpoints,
	resolveIdentity,
	saveConfigFile,
} from "./lib.ts";

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
	});

	return { modelCount: loaded.models.length, modelsUrl: loaded.modelsUrl };
}

function createOAuthHandlers(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
}) {
	const { pi, agentDir, providerId, providerName, defaultBaseUrl, streamSimple } = options;

	return {
		name: providerName,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const promptDefaultBaseUrl = resolveDefaultBaseUrl(agentDir, providerId) || defaultBaseUrl;
			const { baseUrlInput, apiKey } = await promptConnection(callbacks, {
				baseUrl: promptDefaultBaseUrl,
			});

			callbacks.onProgress?.("Fetching model list from CLIProxyAPI...");
			const result = await configureAndRegister({
				pi,
				agentDir,
				providerId,
				providerName,
				baseUrlInput,
				apiKey,
				defaultBaseUrl,
				streamSimple,
			});

			logInfo(`login ok: registered ${result.modelCount} models from ${result.modelsUrl}`);
			return buildOAuthCredentials(baseUrlInput, apiKey);
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
	} = options;

	const endpoints = resolveEndpoints(baseUrlInput);
	const oauth = createOAuthHandlers({
		pi,
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
		streamSimple,
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

function registerSetupCommands(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
	streamSimple: CliproxyCodexStreamSimple;
}): void {
	const { pi, agentDir, providerId, providerName, defaultBaseUrl, streamSimple } = options;

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
			});

			// Persist only after a successful model fetch; keep AuthStorage in-memory too.
			ctx.modelRegistry.authStorage.set(providerId, {
				type: "oauth",
				...buildOAuthCredentials(baseUrlInput, apiKey),
			});

			logInfo(`command setup ok: registered ${result.modelCount} models from ${result.modelsUrl}`);
			ctx.ui.notify(
				`CLIProxyAPI configured: ${result.modelCount} models from ${result.modelsUrl}`,
				"info",
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logWarn(`command setup failed: ${message}`);
			ctx.ui.notify(`CLIProxyAPI setup failed: ${message}`, "error");
		}
	};

	const description =
		"Configure CLIProxyAPI (baseUrl + API key) and load models. Prefer this or /login CLIProxyAPI.";

	pi.registerCommand("cliproxyapi", {
		description,
		handler,
	});

	// Short alias; pi keeps both command names.
	pi.registerCommand("cpa", {
		description: "Alias for /cliproxyapi — configure CLIProxyAPI and load models.",
		handler,
	});
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

	// Always register oauth so the provider is visible in /login immediately after install.
	registerProvider(pi, {
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: defaultBaseUrl,
		defaultBaseUrl,
		agentDir,
		streamSimple,
	});

	registerSetupCommands({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		defaultBaseUrl,
		streamSimple,
	});

	const connection = resolveConnection(agentDir, identity.providerId);
	if (!connection) {
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
		});
		logInfo(`loaded ${loaded.models.length} models from ${loaded.modelsUrl}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(
			`failed to load models (${message}). Provider remains available via /cliproxyapi or /login for reconfiguration.`,
		);
	}
}
