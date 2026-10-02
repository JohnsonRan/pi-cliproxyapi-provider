/**
 * CLIProxyAPI dynamic model provider for pi.
 *
 * Supports native API-key setup via `/login`:
 * 1. Preferred shortcuts: `/login CLIProxyAPI` or `/login cliproxyapi`.
 * 2. Setup prompts for baseUrl + apiKey.
 * 3. Final login step validates credentials via /v1/models?client_version=cpa
 *    (HTTP 200 = success even if the catalog is empty; otherwise re-prompt).
 * 4. Pi stores the API key and base URL together in auth.json.
 * 5. `/fast` globally requests the priority service tier for catalog-supported models.
 *
 * The model catalog follows Pi's native provider lifecycle: Pi restores the stored
 * catalog offline, refreshes it from the network, and persists what we publish.
 *
 * Uses Pi's stock openai-codex-responses implementation. Inference adapts the
 * plain CPA key into X-Api-Key plus a non-secret synthetic Codex JWT.
 *
 * Non-interactive setup still works via env vars or ~/.pi/agent/cliproxyapi.json.
 */

import { join } from "node:path";
import {
	type Api,
	type ApiKeyCredential,
	type AuthInteraction,
	isModelType,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import { CompactionController } from "./auto-compact.ts";
import {
	CLIPROXYAPI_CODEX_API,
	type CliproxyCodexStream,
	type CliproxyCodexStreamSimple,
	loadCliproxyCodexStreams,
} from "./codex-stream.ts";
import { FastModeController } from "./fast.ts";
import { generateImages, parseImageModelIds, toImageModel } from "./images.ts";
import {
	AUTH_FILE_NAME,
	CONFIG_FILE_NAME,
	type CpaCapabilities,
	DEFAULT_BASE_URL,
	fetchCodexModels,
	firstNonEmpty,
	loadConfigFile,
	loadMappedModels,
	MODELS_REQUEST_TIMEOUT_MS,
	type PiProviderModel,
	resolveConnectionSources,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	resolvePauseDefault,
	resolveUseMaxContextWindow,
	resolveWebSearchDefault,
	saveConfigFile,
} from "./lib.ts";
import type { PauseController } from "./pause.ts";
import { pauseController, waitForPauseToEnd } from "./pause.ts";
import { registerTransientNetworkErrorRetry } from "./retry.ts";
import { registerNativeSearch } from "./search.ts";
import { SessionHierarchy } from "./session.ts";
import { ProviderStatusController } from "./status.ts";

/** Bound on the startup catalog fetch; Pi waits for the extension factory. */
export const STARTUP_CATALOG_TIMEOUT_MS = 5_000;
/** A network refresh this soon after the startup fetch reuses its result. */
const STARTUP_CATALOG_REUSE_MS = 60_000;

function logWarn(message: string): void {
	console.warn(`[pi-cliproxyapi-provider] ${message}`);
}

function logInfo(message: string): void {
	console.info(`[pi-cliproxyapi-provider] ${message}`);
}

/** Catalog-derived per-model capabilities shared by streams, tools, and commands. */
interface ModelCapabilities {
	webSearch: Set<string>;
	sse: Set<string>;
	/** Called after a catalog update so Fast status reflects new support. */
	changed?: () => void;
}

function capabilityIds(models: readonly Model<Api>[], key: keyof CpaCapabilities): string[] {
	return models.filter((model) => (model as { cpa?: CpaCapabilities }).cpa?.[key] === true).map((model) => model.id);
}

function setModelCapabilities(
	fastMode: FastModeController,
	capabilities: ModelCapabilities,
	models: readonly Model<Api>[],
): void {
	fastMode.setSupportedModelIds(capabilityIds(models, "fast"));
	capabilities.webSearch = new Set(capabilityIds(models, "webSearch"));
	capabilities.sse = new Set(capabilityIds(models, "sse"));
	capabilities.changed?.();
}

function useMaxContextWindow(agentDir: string): boolean {
	try {
		return resolveUseMaxContextWindow(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid maximum context configuration (${message}); using standard context windows`);
		return false;
	}
}

/** Default for the /login prompt and the provider endpoint: env > stored login > config > default. */
function resolveDefaultBaseUrl(agentDir: string, providerId: string): string {
	let fileBaseUrl: string | undefined;
	try {
		fileBaseUrl = loadConfigFile(agentDir).baseUrl;
	} catch (error) {
		logWarn(`failed to read ${CONFIG_FILE_NAME}: ${(error as Error).message}`);
	}

	let authBaseUrl: string | undefined;
	try {
		const credential = readStoredCredential(providerId, join(agentDir, AUTH_FILE_NAME));
		authBaseUrl = credential?.type === "api_key" ? credential.env?.CLIPROXYAPI_BASE_URL : undefined;
	} catch (error) {
		logWarn(`failed to read ${AUTH_FILE_NAME}: ${(error as Error).message}`);
	}

	return firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, authBaseUrl, fileBaseUrl, DEFAULT_BASE_URL)!;
}

function registerProvider(
	pi: ExtensionAPI,
	options: {
		providerId: string;
		providerName: string;
		agentDir: string;
		stream: CliproxyCodexStream;
		streamSimple: CliproxyCodexStreamSimple;
		fastMode: FastModeController;
		capabilities: ModelCapabilities;
	},
): { loadStartupCatalog: () => Promise<void> } {
	const { providerId, providerName, agentDir, stream, streamSimple, fastMode, capabilities } = options;
	const baseUrlInput = resolveDefaultBaseUrl(agentDir, providerId);
	let imageModelIds: string[] = [];
	try {
		imageModelIds = parseImageModelIds(loadConfigFile(agentDir).imageModels);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid image model configuration (${message}); image generation is disabled`);
	}
	const imageModels = imageModelIds.map((id) =>
		toImageModel(id, providerId, resolveEndpoints(baseUrlInput).inferenceBaseUrl),
	);
	const bindModels = (entries: PiProviderModel[], inferenceBaseUrl: string): Model<Api>[] =>
		entries.map((model) => ({
			...model,
			provider: providerId,
			api: CLIPROXYAPI_CODEX_API,
			baseUrl: inferenceBaseUrl,
		}));
	let currentModels: readonly Model<Api>[] = [];
	const setModels = (models: readonly Model<Api>[]): void => {
		currentModels = models;
		setModelCapabilities(fastMode, capabilities, models);
	};
	let pendingConfigCleanup: ApiKeyCredential | undefined;
	/** Catalog fetched while the factory ran, before Pi's first refresh. */
	let startup: { baseUrl: string; models: Model<Api>[]; at: number } | undefined;

	const credentialConnection = (credential?: ApiKeyCredential) => {
		let file = {} as ReturnType<typeof loadConfigFile>;
		try {
			file = loadConfigFile(agentDir);
		} catch {
			// A malformed optional config must not hide valid native credentials.
		}
		const connection = resolveConnectionSources({
			envBaseUrl: process.env.CLIPROXYAPI_BASE_URL,
			envApiKey: process.env.CLIPROXYAPI_API_KEY,
			credentialBaseUrl: credential?.env?.CLIPROXYAPI_BASE_URL,
			credentialApiKey: credential?.key,
			fileBaseUrl: file.baseUrl,
			fileApiKey: file.apiKey,
			defaultBaseUrl: baseUrlInput,
		});
		return connection ? { apiKey: connection.apiKey, baseUrl: connection.baseUrlInput } : undefined;
	};

	const cleanupMigratedConfigCredentials = (credential?: ApiKeyCredential): void => {
		const pending = pendingConfigCleanup;
		if (!pending || !credential || credential.key !== pending.key) return;
		if (credential.env?.CLIPROXYAPI_BASE_URL !== pending.env?.CLIPROXYAPI_BASE_URL) return;
		try {
			saveConfigFile(agentDir, { baseUrl: undefined, apiKey: undefined });
			pendingConfigCleanup = undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logWarn(`failed to remove migrated credentials from ${CONFIG_FILE_NAME}: ${message}`);
		}
	};

	/** Validation only: Pi refreshes the catalog through refreshModels after storing the credential. */
	const login = async (interaction: AuthInteraction): Promise<ApiKeyCredential> => {
		let defaultBaseUrl = resolveDefaultBaseUrl(agentDir, providerId);
		while (true) {
			interaction.notify({
				type: "info",
				message: "Configure CLIProxyAPI. Preferred baseUrl form: host:port (e.g. http://127.0.0.1:8317).",
			});
			const baseUrl = firstNonEmpty(
				await interaction.prompt({
					type: "text",
					message: `CLIProxyAPI base URL [${defaultBaseUrl}]:`,
					placeholder: defaultBaseUrl,
				}),
				defaultBaseUrl,
			)!;
			let modelsUrl: string;
			try {
				modelsUrl = resolveEndpoints(baseUrl).modelsUrl;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				interaction.notify({ type: "info", message: `Invalid base URL (${message}). Please re-enter it.` });
				continue;
			}
			const apiKey = (
				await interaction.prompt({ type: "secret", message: "CLIProxyAPI API key:", placeholder: "sk-..." })
			).trim();
			if (!apiKey) throw new Error("API key cannot be empty.");

			interaction.notify({ type: "progress", message: "Validating credentials via models endpoint..." });
			try {
				const models = await fetchCodexModels(modelsUrl, apiKey, MODELS_REQUEST_TIMEOUT_MS, interaction.signal);
				const credential: ApiKeyCredential = {
					type: "api_key",
					key: apiKey,
					env: { CLIPROXYAPI_BASE_URL: baseUrl },
				};
				pendingConfigCleanup = credential;
				logInfo(`login ok: ${models.length} catalog entries at ${modelsUrl}`);
				return credential;
			} catch (error) {
				if (interaction.signal?.aborted) throw error;
				const message = error instanceof Error ? error.message : String(error);
				logWarn(`login validation failed: ${message}`);
				interaction.notify({
					type: "info",
					message: `Login validation failed: ${message}\nPlease re-enter base URL and API key.`,
				});
				defaultBaseUrl = baseUrl;
			}
		}
	};

	const provider: Provider = {
		id: providerId,
		name: providerName,
		baseUrl: resolveEndpoints(baseUrlInput).inferenceBaseUrl,
		auth: {
			apiKey: {
				name: `${providerName} API key`,
				login,
				resolve: async ({ ctx, credential }) => {
					cleanupMigratedConfigCredentials(credential);
					let file = {} as ReturnType<typeof loadConfigFile>;
					try {
						file = loadConfigFile(agentDir);
					} catch {
						// Native credentials and environment overrides remain usable without the optional config.
					}
					const envKey = firstNonEmpty(await ctx.env("CLIPROXYAPI_API_KEY"));
					const envBaseUrl = firstNonEmpty(await ctx.env("CLIPROXYAPI_BASE_URL"));
					const storedKey = firstNonEmpty(credential?.key);
					const connection = resolveConnectionSources({
						envBaseUrl,
						envApiKey: envKey,
						credentialBaseUrl: credential?.env?.CLIPROXYAPI_BASE_URL,
						credentialApiKey: storedKey,
						fileBaseUrl: file.baseUrl,
						fileApiKey: file.apiKey,
					});
					if (!connection) return undefined;
					return {
						auth: {
							apiKey: connection.apiKey,
							baseUrl: resolveEndpoints(connection.baseUrlInput).inferenceBaseUrl,
						},
						env: { CLIPROXYAPI_BASE_URL: connection.baseUrlInput },
						source: envKey ? "CLIPROXYAPI_API_KEY" : storedKey ? "stored" : CONFIG_FILE_NAME,
					};
				},
			},
		},
		getModels: () => currentModels,
		getAllModels: () => [...currentModels, ...imageModels],
		generateImages,
		refreshModels: async (context) => {
			const credential = context.credential?.type === "api_key" ? context.credential : undefined;
			cleanupMigratedConfigCredentials(credential);
			const connection = credentialConnection(credential);
			if (!connection) return;
			const inferenceBaseUrl = resolveEndpoints(connection.baseUrl).inferenceBaseUrl;
			const stored = (context.stored?.models ?? []).filter(
				(model): model is Model<Api> =>
					isModelType(model, "chat") && model.provider === providerId && model.baseUrl === inferenceBaseUrl,
			);
			const fresh = startup?.baseUrl === inferenceBaseUrl ? startup : undefined;
			const publish = async (models: Model<Api>[]): Promise<void> => {
				// ponytail: an empty 200 never clobbers a populated catalog. Delete this provider's
				// models-store.json entry to accept a proxy that really has no models.
				if (models.length === 0 && stored.length > 0) {
					logWarn(`ignored empty model catalog; keeping ${stored.length} stored models`);
					return;
				}
				await context.publish({ persist: { models, checkedAt: Date.now() }, update: () => setModels(models) });
			};

			if (!context.allowNetwork) {
				// Offline phase: prefer this process's startup fetch, else Pi's stored catalog for this proxy.
				if (fresh) await publish(fresh.models);
				else await context.publish({ update: () => setModels(stored) });
				return;
			}
			// The first network phase consumes the startup fetch; afterwards Pi's store is current.
			startup = undefined;
			if (fresh && !context.force && Date.now() - fresh.at < STARTUP_CATALOG_REUSE_MS) {
				await publish(fresh.models);
				return;
			}
			const loaded = await loadMappedModels(connection.baseUrl, connection.apiKey, {
				agentDir,
				signal: context.signal,
				useMaxContextWindow: useMaxContextWindow(agentDir),
			});
			if (context.signal.aborted) return;
			await publish(bindModels(loaded.models, inferenceBaseUrl));
		},
		stream,
		streamSimple,
	};

	pi.registerProvider(provider);

	/**
	 * Pi resolves `--model` right after its startup refreshes, which never go online in print/JSON
	 * mode and can supersede each other. The factory is the one step Pi reliably awaits, so fetch
	 * the catalog here (bounded) and hand it to refreshModels instead of racing Pi's refreshes.
	 * On failure, refreshModels falls back to Pi's stored catalog.
	 */
	const loadStartupCatalog = async (): Promise<void> => {
		let credential: ApiKeyCredential | undefined;
		try {
			const stored = readStoredCredential(providerId, join(agentDir, AUTH_FILE_NAME));
			credential = stored?.type === "api_key" ? stored : undefined;
		} catch {
			// Env and cliproxyapi.json credentials remain usable.
		}
		const connection = credentialConnection(credential);
		if (!connection) return;
		try {
			const loaded = await loadMappedModels(connection.baseUrl, connection.apiKey, {
				agentDir,
				signal: AbortSignal.timeout(STARTUP_CATALOG_TIMEOUT_MS),
				useMaxContextWindow: useMaxContextWindow(agentDir),
			});
			const baseUrl = resolveEndpoints(connection.baseUrl).inferenceBaseUrl;
			startup = { baseUrl, models: bindModels(loaded.models, baseUrl), at: Date.now() };
			setModels(startup.models);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logWarn(`failed to load models at startup (${message}); using Pi's stored catalog if available.`);
		}
	};
	return { loadStartupCatalog };
}

export function registerPauseCommands(options: {
	pi: ExtensionAPI;
	agentDir: string;
	pauseMode: PauseController;
}): void {
	const { pi, agentDir, pauseMode } = options;

	const setPause = async (
		enabled: boolean,
		commandName: string,
		args: string,
		ctx: ExtensionContext,
	): Promise<void> => {
		if (args.trim()) {
			ctx.ui.notify(`Usage: /${commandName}`, "error");
			return;
		}

		try {
			saveConfigFile(agentDir, { pause: enabled });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Failed to save pause mode: ${message}`, "error");
			return;
		}

		pauseMode.setEnabled(enabled);
		ctx.ui.notify(enabled ? "Requests are paused." : "Requests are continued.", "info");
	};

	pi.registerCommand("pause", {
		description: "Pause provider requests until /continue is used.",
		handler: async (args, ctx) => setPause(true, "pause", args, ctx),
	});

	pi.registerCommand("continue", {
		description: "Continue provider requests paused by /pause.",
		handler: async (args, ctx) => setPause(false, "continue", args, ctx),
	});
}

export function registerPauseGuard(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	pauseMode: PauseController;
}): void {
	const { pi, agentDir, providerId, pauseMode } = options;
	pi.on("before_provider_request", async (_event, ctx) => {
		// This event fires for every provider; only gate CLIProxyAPI requests.
		if (ctx.model?.provider !== providerId) return;
		try {
			await waitForPauseToEnd(agentDir, pauseMode, ctx.signal);
		} catch (error) {
			// Esc while paused aborts the request itself; do not surface it as an extension error.
			if (ctx.signal?.aborted) return;
			throw error;
		}
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

export function registerRefreshCommand(options: { pi: ExtensionAPI; providerId: string; providerName: string }): void {
	const { pi, providerId, providerName } = options;

	pi.registerCommand("cliproxyapi-refresh", {
		description: "Force refresh CLIProxyAPI models from the remote catalog.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /cliproxyapi-refresh", "error");
				return;
			}

			try {
				if (!(await ctx.modelRegistry.getProviderAuth(providerId))) {
					ctx.ui.notify(
						`CLIProxyAPI is not configured. Use /login ${providerName} or /login ${providerId}.`,
						"error",
					);
					return;
				}
				const result = await ctx.modelRegistry.refresh({ providers: [providerId], force: true });
				const error = result.errors.get(providerId);
				if (error) throw error;
				if (result.aborted) throw new Error("refresh was cancelled");
				const count = ctx.modelRegistry.getAll().filter((model) => model.provider === providerId).length;
				ctx.ui.notify(`Refreshed ${count} CLIProxyAPI models.`, "info");
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

	let pauseEnabled = false;
	try {
		pauseEnabled = resolvePauseDefault(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid pause configuration (${message}); using pause=false`);
	}
	pauseController.setEnabled(pauseEnabled);
	registerPauseCommands({ pi, agentDir, pauseMode: pauseController });
	registerPauseGuard({ pi, agentDir, providerId: identity.providerId, pauseMode: pauseController });

	const hierarchy = new SessionHierarchy();
	hierarchy.register(pi);
	new CompactionController().register(pi);

	let fastEnabled = false;
	try {
		fastEnabled = resolveFastDefault(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid Fast configuration (${message}); using fast=false`);
	}
	const fastMode = new FastModeController(fastEnabled);
	const capabilities: ModelCapabilities = { webSearch: new Set(), sse: new Set() };
	let webSearchEnabled = false;
	try {
		webSearchEnabled = resolveWebSearchDefault(agentDir);
	} catch (error) {
		logWarn(
			`invalid native search configuration (${error instanceof Error ? error.message : String(error)}); using webSearch=false`,
		);
	}

	try {
		if (process.env.CLIPROXYAPI_TRANSPORT || (loadConfigFile(agentDir) as { transport?: unknown }).transport) {
			logWarn(
				`CLIPROXYAPI_TRANSPORT and ${CONFIG_FILE_NAME} "transport" are ignored; set Pi's "transport" in settings.json instead.`,
			);
		}
	} catch {
		// Config errors are reported where the config is actually used.
	}

	let stream: CliproxyCodexStream;
	let streamSimple: CliproxyCodexStreamSimple;
	try {
		const streams = loadCliproxyCodexStreams({
			shouldUseFast: (model) => model.provider === identity.providerId && fastMode.isEffectiveFor(model.id),
			getSessionHeaders: (options) => hierarchy.headers(options),
			prefersSse: (model) => model.provider === identity.providerId && capabilities.sse.has(model.id),
		});
		stream = streams.stream;
		streamSimple = streams.streamSimple;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`failed to load Codex protocol: ${message}`);
		return;
	}

	registerNativeSearch({
		pi,
		agentDir,
		providerId: identity.providerId,
		enabled: webSearchEnabled,
		isSupported: (id) => capabilities.webSearch.has(id),
		shouldUseFast: (id) => fastMode.isEffectiveFor(id),
		hierarchy,
	});

	const status = new ProviderStatusController(identity.providerId, fastMode);
	status.register(pi);
	capabilities.changed = () => status.refresh();
	registerFastCommand({
		pi,
		agentDir,
		providerId: identity.providerId,
		fastMode,
		onStatusChange: (ctx) => status.refresh(ctx),
	});

	// Always register native auth so the provider is visible in /login immediately after install.
	// Pi restores, persists, and refreshes the catalog through refreshModels.
	const provider = registerProvider(pi, {
		providerId: identity.providerId,
		providerName: identity.providerName,
		agentDir,
		stream,
		streamSimple,
		fastMode,
		capabilities,
	});
	registerTransientNetworkErrorRetry(pi, identity.providerId);
	registerRefreshCommand({ pi, providerId: identity.providerId, providerName: identity.providerName });
	await provider.loadStartupCatalog();
}
