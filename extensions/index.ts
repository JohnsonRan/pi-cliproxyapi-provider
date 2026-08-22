/**
 * CLIProxyAPI dynamic model provider for pi.
 *
 * Supports native API-key setup via `/login`:
 * 1. Preferred shortcuts: `/login CLIProxyAPI` or `/login cliproxyapi`.
 * 2. Setup prompts for baseUrl + apiKey.
 * 3. Final login step validates credentials via /v1/models?client_version=pi
 *    (HTTP 200 = success even if the catalog is empty; otherwise re-prompt).
 * 4. Pi stores the API key and base URL together in auth.json.
 * 5. `/fast` globally controls catalog-driven priority service tier injection.
 *
 * Uses a patched openai-codex-responses implementation that does not require
 * extracting chatgpt_account_id from the API key (plain CPA keys work).
 *
 * Non-interactive setup still works via env vars or ~/.pi/agent/cliproxyapi.json.
 */

import type {
	Api,
	ApiKeyCredential,
	AuthInteraction,
	Model,
	Provider,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ProactiveCompactionController } from "./auto-compact.ts";
import {
	CLIPROXYAPI_CODEX_API,
	type CliproxyCodexStream,
	type CliproxyCodexStreamSimple,
	loadCliproxyCodexStreams,
} from "./codex-stream.ts";
import { FastModeController } from "./fast.ts";
import { FastFooterController } from "./fast-footer.ts";
import {
	CONFIG_FILE_NAME,
	DEFAULT_BASE_URL,
	firstNonEmpty,
	isUnauthorizedModelsError,
	loadAuthConnection,
	loadConfigFile,
	type PiProviderModel,
	resolveConnection,
	resolveConnectionSources,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	resolveMappedModels,
	resolvePauseDefault,
	resolveTransportDefault,
	resolveUseMaxContextWindow,
	saveConfigFile,
} from "./lib.ts";
import type { PauseController } from "./pause.ts";
import { pauseController, waitForPauseToEnd } from "./pause.ts";
import { registerTransientNetworkErrorRetry } from "./retry.ts";

interface RefreshResult {
	modelCount: number;
	modelsUrl: string;
}

class ModelRefreshCoordinator {
	private generation = 0;
	private activeController: AbortController | undefined;

	begin(): { generation: number; signal: AbortSignal } {
		this.activeController?.abort();
		const controller = new AbortController();
		this.activeController = controller;
		this.generation += 1;
		return { generation: this.generation, signal: controller.signal };
	}

	isCurrent(generation: number): boolean {
		return this.generation === generation;
	}
}

function logWarn(message: string): void {
	console.warn(`[pi-cliproxyapi-provider] ${message}`);
}

function logInfo(message: string): void {
	console.info(`[pi-cliproxyapi-provider] ${message}`);
}

function setFastModelIds(fastMode: FastModeController, modelIds: string[]): void {
	fastMode.setSupportedModelIds(modelIds);
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

	return firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, authBaseUrl, fileBaseUrl, DEFAULT_BASE_URL)!;
}

function registerProvider(
	pi: ExtensionAPI,
	options: {
		providerId: string;
		providerName: string;
		baseUrlInput: string;
		models?: PiProviderModel[];
		agentDir: string;
		stream: CliproxyCodexStream;
		streamSimple: CliproxyCodexStreamSimple;
		fastMode: FastModeController;
		refreshCoordinator: ModelRefreshCoordinator;
	},
): void {
	const {
		providerId,
		providerName,
		baseUrlInput,
		models,
		agentDir,
		stream,
		streamSimple,
		fastMode,
		refreshCoordinator,
	} = options;
	const inferenceBaseUrl = resolveEndpoints(baseUrlInput).inferenceBaseUrl;
	const api: Api = CLIPROXYAPI_CODEX_API;
	const bindModels = (entries: PiProviderModel[], inferenceBaseUrl: string): Model<Api>[] =>
		entries.map((model) => ({
			...model,
			provider: providerId,
			api,
			baseUrl: inferenceBaseUrl,
		}));
	let currentModels = bindModels(models ?? [], inferenceBaseUrl);
	let pendingConfigCleanup: ApiKeyCredential | undefined;

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
			resolveEndpoints(baseUrl);
			const apiKey = (
				await interaction.prompt({ type: "secret", message: "CLIProxyAPI API key:", placeholder: "sk-..." })
			).trim();
			if (!apiKey) throw new Error("API key cannot be empty.");

			interaction.notify({ type: "progress", message: "Validating credentials via models endpoint..." });
			try {
				const refresh = refreshCoordinator.begin();
				const signal = interaction.signal ? AbortSignal.any([interaction.signal, refresh.signal]) : refresh.signal;
				const { loaded } = await resolveMappedModels(agentDir, baseUrl, apiKey, {
					forceRefresh: true,
					fastMode: fastMode.isEnabled(),
					useMaxContextWindow: useMaxContextWindow(agentDir),
					signal,
					shouldCommit: () => refreshCoordinator.isCurrent(refresh.generation),
				});
				if (!refreshCoordinator.isCurrent(refresh.generation)) {
					throw new Error("Model refresh was superseded by a newer request.");
				}
				currentModels = bindModels(loaded.models, resolveEndpoints(baseUrl).inferenceBaseUrl);
				setFastModelIds(fastMode, loaded.fastModelIds);
				const credential: ApiKeyCredential = {
					type: "api_key",
					key: apiKey,
					env: { CLIPROXYAPI_BASE_URL: baseUrl },
				};
				pendingConfigCleanup = credential;
				logInfo(`login ok: registered ${loaded.models.length} models from ${loaded.modelsUrl}`);
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
		baseUrl: inferenceBaseUrl,
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
		refreshModels: async (context: RefreshModelsContext) => {
			const credential = context.credential?.type === "api_key" ? context.credential : undefined;
			cleanupMigratedConfigCredentials(credential);
			if (!context.allowNetwork) return;
			const connection = credentialConnection(
				context.credential?.type === "api_key" ? context.credential : undefined,
			);
			if (!connection) return;
			const refresh = refreshCoordinator.begin();
			const signal = context.signal ? AbortSignal.any([context.signal, refresh.signal]) : refresh.signal;
			const { loaded } = await resolveMappedModels(agentDir, connection.baseUrl, connection.apiKey, {
				forceRefresh: true,
				fastMode: fastMode.isEnabled(),
				useMaxContextWindow: useMaxContextWindow(agentDir),
				signal,
				shouldCommit: () => refreshCoordinator.isCurrent(refresh.generation),
			});
			if (!refreshCoordinator.isCurrent(refresh.generation)) return;
			currentModels = bindModels(loaded.models, resolveEndpoints(connection.baseUrl).inferenceBaseUrl);
			setFastModelIds(fastMode, loaded.fastModelIds);
		},
		stream,
		streamSimple,
	};

	pi.unregisterProvider(providerId);
	pi.registerProvider(provider);
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

export function registerPauseGuard(options: { pi: ExtensionAPI; agentDir: string; pauseMode: PauseController }): void {
	const { pi, agentDir, pauseMode } = options;
	pi.on("before_provider_request", async () => {
		await waitForPauseToEnd(agentDir, pauseMode);
	});
}

export function registerFastCommand(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	fastMode: FastModeController;
	onStatusChange?: (ctx: ExtensionContext) => void;
	onModeChange?: (enabled: boolean, ctx: ExtensionContext) => Promise<void>;
}): void {
	const { pi, agentDir, providerId, fastMode, onStatusChange, onModeChange } = options;
	let modeChangeInProgress = false;

	pi.registerCommand("fast", {
		description: "Toggle CLIProxyAPI Fast mode globally.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /fast", "error");
				return;
			}
			if (modeChangeInProgress) {
				ctx.ui.notify("Fast mode is already being refreshed. Try again when it finishes.", "warning");
				return;
			}

			modeChangeInProgress = true;
			try {
				const previousEnabled = fastMode.isEnabled();
				const enabled = !previousEnabled;
				try {
					saveConfigFile(agentDir, { fast: enabled });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to save Fast mode: ${message}`, "error");
					return;
				}
				fastMode.setEnabled(enabled);
				try {
					await onModeChange?.(enabled, ctx);
				} catch (error) {
					// Restore all three views of the mode after a partial refresh:
					// in-memory request behavior, persisted preference, and model metadata.
					fastMode.setEnabled(previousEnabled);
					const rollbackErrors: string[] = [];
					try {
						saveConfigFile(agentDir, { fast: previousEnabled });
					} catch (rollbackError) {
						rollbackErrors.push(
							`config rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
						);
					}
					try {
						await onModeChange?.(previousEnabled, ctx);
					} catch (rollbackError) {
						rollbackErrors.push(
							`pricing rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
						);
					}
					const message = error instanceof Error ? error.message : String(error);
					const rollbackSuffix = rollbackErrors.length > 0 ? ` (${rollbackErrors.join("; ")})` : "";
					ctx.ui.notify(`Failed to refresh model pricing: ${message}${rollbackSuffix}`, "warning");
					onStatusChange?.(ctx);
					return;
				}
				onStatusChange?.(ctx);

				const currentModel = ctx.model;
				if (!currentModel || currentModel.provider !== providerId || !fastMode.isModelSupported(currentModel.id)) {
					if (enabled) {
						ctx.ui.notify("Fast mode is enabled globally, but the current model does not support it.", "warning");
					} else {
						ctx.ui.notify("Fast mode is disabled globally.", "info");
					}
				}
			} finally {
				modeChangeInProgress = false;
			}
		},
	});
}

export function registerRefreshCommand(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	onRefresh: (connection: NonNullable<ReturnType<typeof resolveConnection>>) => Promise<RefreshResult | undefined>;
}): void {
	const { pi, agentDir, providerId, providerName, onRefresh } = options;

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
				const result = await onRefresh(connection);
				if (!result) return;
				ctx.ui.notify(`Refreshed ${result.modelCount} CLIProxyAPI models from ${result.modelsUrl}.`, "info");
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

	let pauseEnabled = false;
	try {
		pauseEnabled = resolvePauseDefault(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid pause configuration (${message}); using pause=false`);
	}
	pauseController.setEnabled(pauseEnabled);
	registerPauseCommands({ pi, agentDir, pauseMode: pauseController });
	registerPauseGuard({ pi, agentDir, pauseMode: pauseController });

	const proactiveCompaction = new ProactiveCompactionController(agentDir, identity.providerId);
	proactiveCompaction.register(pi);

	let fastEnabled = false;
	try {
		fastEnabled = resolveFastDefault(agentDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`invalid Fast configuration (${message}); using fast=false`);
	}
	const fastMode = new FastModeController(fastEnabled);
	const modelRefreshCoordinator = new ModelRefreshCoordinator();

	let stream: CliproxyCodexStream;
	let streamSimple: CliproxyCodexStreamSimple;
	try {
		let transport: ReturnType<typeof resolveTransportDefault>;
		try {
			transport = resolveTransportDefault(agentDir);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logWarn(`invalid transport configuration (${message}); using websocket`);
			transport = "websocket";
		}
		const streams = await loadCliproxyCodexStreams([identity.providerId, "cliproxyapi"], {
			shouldUseFast: (model) => model.provider === identity.providerId && fastMode.isEffectiveFor(model.id),
			transport,
		});
		proactiveCompaction.setCloseWebSocketSessions(streams.closeOpenAICodexWebSocketSessions);
		stream = streams.stream;
		streamSimple = proactiveCompaction.wrapStreamSimple(streams.streamSimple);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logWarn(`failed to load Codex protocol: ${message}`);
		return;
	}

	const fastFooter = new FastFooterController(identity.providerId, fastMode, () =>
		proactiveCompaction.getCompactionSettings(),
	);
	let refreshModelsForFast: ((ctx: ExtensionContext) => Promise<void>) | undefined;
	const onFastModeChange = async (_enabled: boolean, ctx: ExtensionContext): Promise<void> => {
		await refreshModelsForFast?.(ctx);
	};
	registerFastCommand({
		pi,
		agentDir,
		providerId: identity.providerId,
		fastMode,
		onStatusChange: (ctx) => fastFooter.refresh(ctx),
		onModeChange: onFastModeChange,
	});
	fastFooter.register(pi);

	// Always register native auth so provider is visible in /login immediately after install.
	registerProvider(pi, {
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: defaultBaseUrl,
		agentDir,
		stream,
		streamSimple,
		fastMode,
		refreshCoordinator: modelRefreshCoordinator,
	});
	registerTransientNetworkErrorRetry(pi, identity.providerId);

	const connection = resolveConnection(agentDir, identity.providerId);
	const registerConfiguredProvider = async (
		currentConnection: NonNullable<ReturnType<typeof resolveConnection>>,
		options: { forceRefresh?: boolean } = {},
	): Promise<RefreshResult | undefined> => {
		const refresh = modelRefreshCoordinator.begin();
		try {
			const { loaded, fromCache } = await resolveMappedModels(
				agentDir,
				currentConnection.baseUrlInput,
				currentConnection.apiKey,
				{
					forceRefresh: options.forceRefresh,
					fastMode: fastMode.isEnabled(),
					useMaxContextWindow: useMaxContextWindow(agentDir),
					signal: refresh.signal,
					shouldCommit: () => modelRefreshCoordinator.isCurrent(refresh.generation),
				},
			);
			if (!modelRefreshCoordinator.isCurrent(refresh.generation)) return undefined;

			setFastModelIds(fastMode, loaded.fastModelIds);

			registerProvider(pi, {
				providerId: identity.providerId,
				providerName: identity.providerName,
				baseUrlInput: currentConnection.baseUrlInput,
				models: loaded.models,
				agentDir,
				stream,
				streamSimple,
				fastMode,
				refreshCoordinator: modelRefreshCoordinator,
			});

			if (fromCache && !options.forceRefresh) {
				void registerConfiguredProvider(currentConnection, { forceRefresh: true }).catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					logWarn(`failed to refresh cached models (${message}); keeping the cached model list.`);
				});
			}

			return { modelCount: loaded.models.length, modelsUrl: loaded.modelsUrl };
		} catch (error) {
			if (!modelRefreshCoordinator.isCurrent(refresh.generation)) return undefined;
			throw error;
		}
	};
	refreshModelsForFast = async (ctx: ExtensionContext): Promise<void> => {
		const currentConnection = resolveConnection(agentDir, identity.providerId);
		if (!currentConnection) return;

		const refreshed = await registerConfiguredProvider(currentConnection, { forceRefresh: true });
		if (!refreshed) return;
		const currentModel = ctx.model;
		if (!currentModel || currentModel.provider !== identity.providerId) return;

		const refreshedModel = ctx.modelRegistry.find(identity.providerId, currentModel.id);
		if (!refreshedModel) {
			throw new Error(`Refreshed model ${identity.providerId}/${currentModel.id} is unavailable`);
		}
		if (JSON.stringify(refreshedModel.cost) === JSON.stringify(currentModel.cost)) return;
		if (!(await pi.setModel(refreshedModel))) {
			throw new Error(`Unable to activate refreshed model ${identity.providerId}/${currentModel.id}`);
		}
	};
	registerRefreshCommand({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		onRefresh: (currentConnection) => registerConfiguredProvider(currentConnection, { forceRefresh: true }),
	});

	if (!connection) {
		logInfo(
			`not configured yet. Use /login ${identity.providerName} or /login ${identity.providerId}. ` +
				`Menu path: /login → Sign in with an account → ${identity.providerName}. ` +
				`Or set ${CONFIG_FILE_NAME} / CLIPROXYAPI_API_KEY.`,
		);
		return;
	}

	try {
		await registerConfiguredProvider(connection);
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
