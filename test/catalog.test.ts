import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type ModelsStore } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import providerExtension, { STARTUP_CATALOG_TIMEOUT_MS } from "../extensions/index.ts";
import {
	AUTH_FILE_NAME,
	CONFIG_FILE_NAME,
	fetchCodexModels,
	loadMappedModels,
	MODELS_REQUEST_TIMEOUT_MS,
} from "../extensions/lib.ts";

const CLIPROXYAPI_ENV_NAMES = [
	"CLIPROXYAPI_API_KEY",
	"CLIPROXYAPI_BASE_URL",
	"CLIPROXYAPI_FAST",
	"CLIPROXYAPI_WEB_SEARCH",
	"CLIPROXYAPI_PARENT_SESSION_ID",
	"CLIPROXYAPI_PROVIDER_ID",
	"CLIPROXYAPI_PROVIDER_NAME",
	"CLIPROXYAPI_TRANSPORT",
	"CLIPROXYAPI_USE_MAX_CONTEXT_WINDOW",
] as const;

const MODELS_URL = "http://127.0.0.1:8317/v1/models?client_version=cpa";
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

const tempPaths: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (tempPaths.length > 0) {
		const path = tempPaths.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

function writeConfig(agentDir: string, config: Record<string, unknown>): void {
	writeFileSync(join(agentDir, CONFIG_FILE_NAME), JSON.stringify(config, null, 2), "utf8");
}

async function withTempAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-catalog-test-"));
	tempPaths.push(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousEnv = new Map(CLIPROXYAPI_ENV_NAMES.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of CLIPROXYAPI_ENV_NAMES) delete process.env[name];
	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const [name, value] of previousEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** Load the extension into a real Pi ModelRuntime, as one Pi process would. */
async function startPi(agentDir: string, store: ModelsStore) {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, AUTH_FILE_NAME),
		modelsPath: null,
		modelsStore: store,
		refreshOnCreate: false,
	});
	const commands = new Map<string, Command>();
	const pi = {
		registerCommand: (name: string, options: Command) => commands.set(name, options),
		registerTool: vi.fn(),
		on: vi.fn(),
		registerProvider: (provider: Parameters<ModelRuntime["registerNativeProvider"]>[0]) =>
			runtime.registerNativeProvider(provider),
		unregisterProvider: (id: string) => runtime.unregisterProvider(id),
	} as unknown as ExtensionAPI;
	await providerExtension(pi);
	const notify = vi.fn();
	const ctx = (modelId?: string) =>
		({
			model: modelId ? runtime.getModel("cliproxyapi", modelId) : undefined,
			modelRegistry: {
				getProviderAuth: (id: string) => runtime.getAuth(id),
				refresh: (options: Parameters<ModelRuntime["refresh"]>[0]) => runtime.refresh(options),
				getAll: () => runtime.getModels(),
			},
			ui: { notify },
		}) as unknown as ExtensionCommandContext;
	const ids = () => runtime.getModels("cliproxyapi").map((model) => model.id);
	return { runtime, commands, ctx, notify, ids };
}

function catalogResponse(models: unknown[]): Response {
	return new Response(JSON.stringify({ models }), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Serve the CPA catalog; everything else (models.dev) returns an empty object. */
function mockCatalog(models: () => unknown[] | Error) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		if (String(input) !== MODELS_URL) return new Response("{}");
		const result = models();
		if (result instanceof Error) throw result;
		return catalogResponse(result);
	});
}

describe("models request helpers", () => {
	it("uses the 60-second default timeout for catalog requests", async () => {
		const timeoutSpy = vi.spyOn(globalThis.AbortSignal, "timeout");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(catalogResponse([]));

		await loadMappedModels("http://127.0.0.1:8317", "key");
		expect(MODELS_REQUEST_TIMEOUT_MS).toBe(60_000);
		expect(timeoutSpy).toHaveBeenCalledWith(MODELS_REQUEST_TIMEOUT_MS);
		expect(fetchMock.mock.calls[0]?.[1]).toHaveProperty("signal");
	});

	it("rejects a 200 that is not a model list", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		fetchMock.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
		await expect(fetchCodexModels(MODELS_URL, "key")).rejects.toThrow(/invalid JSON/);

		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ models: null }), { status: 200 }));
		await expect(fetchCodexModels(MODELS_URL, "key")).rejects.toThrow(/missing model list/);
	});

	it("records CPA capabilities on visible models only", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			catalogResponse([
				{ slug: "search", cpa_capabilities: { web_search: true } },
				{ slug: "no", cpa_capabilities: { web_search: false } },
				{ slug: "malformed", cpa_capabilities: { web_search: "true" } },
				{ slug: "claude", prefer_websockets: false },
				{ slug: "codex", prefer_websockets: true, service_tiers: [{ id: "priority" }] },
				{ slug: "hidden", visibility: "hide", cpa_capabilities: { web_search: true } },
			]),
		);
		const loaded = await loadMappedModels("http://127.0.0.1:8317", "key");
		expect(loaded.models.map((model) => [model.id, model.cpa])).toEqual([
			["search", { webSearch: true }],
			["no", undefined],
			["malformed", undefined],
			["claude", { sse: true }],
			["codex", { fast: true }],
		]);
	});
});

describe("native catalog lifecycle", () => {
	it("loads the catalog while the extension loads so print mode can resolve --model", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const store = new InMemoryModelsStore();
			const fetchMock = mockCatalog(() => [{ slug: "m" }]);
			const { runtime, ids } = await startPi(agentDir, store);
			// Pi's offline startup refresh publishes and persists the startup fetch.
			await runtime.refresh({ allowNetwork: false });
			expect(ids()).toEqual(["m"]);
			expect((await store.read("cliproxyapi"))?.models.map((model) => model.id)).toEqual(["m"]);

			// Interactive Pi's network refresh right after startup reuses it instead of fetching again.
			fetchMock.mockClear();
			await runtime.refresh({ providers: ["cliproxyapi"] });
			expect(fetchMock.mock.calls.filter(([url]) => String(url) === MODELS_URL)).toEqual([]);
			expect(ids()).toEqual(["m"]);
		});
	});

	it("bounds the startup fetch so an unreachable proxy cannot stall Pi", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const timeoutSpy = vi.spyOn(globalThis.AbortSignal, "timeout");
			mockCatalog(() => [{ slug: "m" }]);
			await startPi(agentDir, new InMemoryModelsStore());
			expect(timeoutSpy).toHaveBeenCalledWith(STARTUP_CATALOG_TIMEOUT_MS);
			expect(STARTUP_CATALOG_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
		});
	});

	it("keeps a failed startup fetch from breaking Pi's refreshes", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			let catalog: unknown[] | Error = new Error("proxy down");
			mockCatalog(() => catalog);
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const { runtime, ids } = await startPi(agentDir, new InMemoryModelsStore());
			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("failed to load models at startup"));
			const offline = await runtime.refresh({ allowNetwork: false });
			expect(offline.errors.size).toBe(0);
			expect(ids()).toEqual([]);

			catalog = [{ slug: "m" }];
			await runtime.refresh({ providers: ["cliproxyapi"], force: true });
			expect(ids()).toEqual(["m"]);
		});
	});

	it("persists refreshed models in Pi's store and restores them with capabilities after restart", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const store = new InMemoryModelsStore();
			let catalog: unknown[] | Error = [{ slug: "gpt-5.4", service_tiers: [{ id: "priority" }] }];
			mockCatalog(() => catalog);

			const first = await startPi(agentDir, store);
			const result = await first.runtime.refresh({ providers: ["cliproxyapi"] });
			expect(result.errors.size).toBe(0);
			expect(first.ids()).toEqual(["gpt-5.4"]);
			expect((await store.read("cliproxyapi"))?.models.map((model) => model.id)).toEqual(["gpt-5.4"]);

			// Restart while CPA is down: Pi restores the stored catalog offline.
			catalog = new Error("network down");
			const second = await startPi(agentDir, store);
			await second.runtime.refresh({ providers: ["cliproxyapi"], allowNetwork: false });
			expect(second.ids()).toEqual(["gpt-5.4"]);
			const restored = second.runtime.getModel("cliproxyapi", "gpt-5.4");
			expect(restored).toMatchObject({
				api: "openai-codex-responses",
				baseUrl: "http://127.0.0.1:8317/backend-api/",
			});

			// Fast support was restored too: enabling Fast does not warn for this model.
			await second.commands.get("fast")?.handler("", second.ctx("gpt-5.4"));
			expect(second.notify).not.toHaveBeenCalled();
		});
	});

	it("keeps the previous models when a network refresh fails", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			let catalog: unknown[] | Error = [{ slug: "kept" }];
			mockCatalog(() => catalog);
			const { runtime, ids } = await startPi(agentDir, new InMemoryModelsStore());
			await runtime.refresh({ providers: ["cliproxyapi"] });

			catalog = new Error("network down");
			const result = await runtime.refresh({ providers: ["cliproxyapi"], force: true });
			expect(result.errors.get("cliproxyapi")?.message).toContain("network down");
			expect(ids()).toEqual(["kept"]);
		});
	});

	it("drops removed models but ignores an empty catalog while models are stored", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			let catalog: unknown[] = [{ slug: "kept" }, { slug: "gone" }];
			mockCatalog(() => catalog);
			const { runtime, ids } = await startPi(agentDir, new InMemoryModelsStore());
			await runtime.refresh({ providers: ["cliproxyapi"] });
			expect(ids()).toEqual(["kept", "gone"]);

			catalog = [{ slug: "kept" }];
			await runtime.refresh({ providers: ["cliproxyapi"], force: true });
			expect(ids()).toEqual(["kept"]);

			catalog = [];
			vi.spyOn(console, "warn").mockImplementation(() => {});
			await runtime.refresh({ providers: ["cliproxyapi"], force: true });
			expect(ids()).toEqual(["kept"]);
		});
	});

	it("does not restore a catalog stored for another base URL", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const store = new InMemoryModelsStore();
			mockCatalog(() => [{ slug: "old-proxy-model" }]);
			await (await startPi(agentDir, store)).runtime.refresh({ providers: ["cliproxyapi"] });

			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:9999", apiKey: "key" });
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const { runtime, ids } = await startPi(agentDir, store);
			await runtime.refresh({ providers: ["cliproxyapi"], allowNetwork: false });
			expect(ids()).toEqual([]);
		});
	});
});

describe("/cliproxyapi-refresh command", () => {
	it("refuses arguments", async () => {
		await withTempAgentDir(async (agentDir) => {
			const { commands, ctx, notify } = await startPi(agentDir, new InMemoryModelsStore());
			await commands.get("cliproxyapi-refresh")?.handler("now", ctx());
			expect(notify).toHaveBeenCalledWith("Usage: /cliproxyapi-refresh", "error");
		});
	});

	it("reports an unconfigured provider", async () => {
		await withTempAgentDir(async (agentDir) => {
			const fetchMock = mockCatalog(() => []);
			const { commands, ctx, notify } = await startPi(agentDir, new InMemoryModelsStore());
			await commands.get("cliproxyapi-refresh")?.handler("", ctx());
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("CLIProxyAPI is not configured"), "error");
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	it("force-refreshes through Pi's model registry and reports the model count", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			mockCatalog(() => [{ slug: "a" }, { slug: "b" }]);
			const { commands, ctx, notify, ids } = await startPi(agentDir, new InMemoryModelsStore());
			await commands.get("cliproxyapi-refresh")?.handler("", ctx());
			expect(ids()).toEqual(["a", "b"]);
			expect(notify).toHaveBeenCalledWith("Refreshed 2 CLIProxyAPI models.", "info");
		});
	});

	it("reports refresh failures", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			mockCatalog(() => new Error("network down"));
			const { commands, ctx, notify } = await startPi(agentDir, new InMemoryModelsStore());
			await commands.get("cliproxyapi-refresh")?.handler("", ctx());
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("network down"), "error");
		});
	});
});
