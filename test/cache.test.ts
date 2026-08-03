import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import providerExtension from "../extensions/index.ts";
import {
	CONFIG_FILE_NAME,
	fetchCodexModels,
	isModelsCacheFresh,
	loadMappedModels,
	loadModelsCache,
	type MappedModels,
	MODELS_CACHE_FILE_NAME,
	MODELS_CACHE_TTL_MS,
	MODELS_REQUEST_TIMEOUT_MS,
	type PiProviderModel,
	resolveEndpoints,
	resolveMappedModels,
	saveModelsCache,
} from "../extensions/lib.ts";

const CLIPROXYAPI_ENV_NAMES = [
	"CLIPROXYAPI_API_KEY",
	"CLIPROXYAPI_BASE_URL",
	"CLIPROXYAPI_FAST",
	"CLIPROXYAPI_PROVIDER_ID",
	"CLIPROXYAPI_PROVIDER_NAME",
] as const;

function createModel(id: string): PiProviderModel {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function createCodexModel(id: string, fast = false) {
	return {
		slug: id,
		display_name: id,
		input_modalities: ["text"],
		...(fast ? { service_tiers: [{ id: "priority", name: "Fast" }] } : {}),
	};
}

function createMappedModels(options: { models?: PiProviderModel[]; fastModelIds?: string[] } = {}): MappedModels {
	const endpoints = resolveEndpoints("http://127.0.0.1:8317");
	return {
		models: options.models ?? [],
		fastModelIds: options.fastModelIds ?? [],
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
	};
}

const tempPaths: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-cache-test-"));
	tempPaths.push(dir);
	return dir;
}

function writeConfig(agentDir: string, config: { baseUrl?: string; apiKey?: string }): void {
	writeFileSync(join(agentDir, CONFIG_FILE_NAME), JSON.stringify(config, null, 2), "utf8");
}

async function withTempAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = tempAgentDir();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousEnv = new Map(CLIPROXYAPI_ENV_NAMES.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of CLIPROXYAPI_ENV_NAMES) delete process.env[name];

	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		for (const [name, value] of previousEnv) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}
}

function createPiMock(commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>()): {
	pi: ExtensionAPI;
	commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>;
} {
	const pi = {
		registerCommand: vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			commands.set(name, options);
		}),
		unregisterProvider: vi.fn(),
		registerProvider: vi.fn(),
		on: vi.fn(),
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

afterEach(() => {
	while (tempPaths.length > 0) {
		const path = tempPaths.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

describe("models cache helpers", () => {
	it("save and load round-trip cache when endpoints match", () => {
		const agentDir = tempAgentDir();
		const loaded = createMappedModels({
			models: [createModel("cached-model")],
			fastModelIds: ["fast-model"],
		});
		const fetchedAt = Date.now() - 60 * 60 * 1000;

		saveModelsCache(agentDir, loaded, fetchedAt);
		const cache = loadModelsCache(agentDir, "http://127.0.0.1:8317");

		expect(cache).toEqual({ ...loaded, fetchedAt });
		expect(isModelsCacheFresh(cache!)).toBe(true);
	});

	it("returns null when the cache file is missing", () => {
		const agentDir = tempAgentDir();
		expect(loadModelsCache(agentDir, "http://127.0.0.1:8317")).toBeNull();
	});

	it("returns null when the cached endpoint URLs do not match", () => {
		const agentDir = tempAgentDir();
		const loaded = createMappedModels({ models: [createModel("m1")] });
		saveModelsCache(agentDir, loaded, Date.now());

		expect(loadModelsCache(agentDir, "http://127.0.0.1:9999")).toBeNull();
	});

	it("matches cache across equivalent baseUrl forms", () => {
		const agentDir = tempAgentDir();
		const loaded = createMappedModels({ models: [createModel("m1")] });
		const fetchedAt = Date.now();
		saveModelsCache(agentDir, loaded, fetchedAt);

		expect(loadModelsCache(agentDir, "127.0.0.1:8317")).toEqual({ ...loaded, fetchedAt });
		expect(loadModelsCache(agentDir, "http://127.0.0.1:8317/")).toEqual({ ...loaded, fetchedAt });
		expect(loadModelsCache(agentDir, "http://127.0.0.1:8317/v1")).toEqual({ ...loaded, fetchedAt });
	});

	it("writes pretty-printed JSON to disk", () => {
		const agentDir = tempAgentDir();
		const loaded = createMappedModels({ models: [createModel("m1")] });
		saveModelsCache(agentDir, loaded, 12345);

		const raw = readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(JSON.parse(raw)).toEqual({ ...loaded, fetchedAt: 12345 });
	});
});

describe("fresh/stale cache detection", () => {
	const now = 1_700_000_000_000;

	it("is fresh when age is strictly less than 24h", () => {
		const cache = { ...createMappedModels(), fetchedAt: now - MODELS_CACHE_TTL_MS + 1 };
		expect(isModelsCacheFresh(cache, now)).toBe(true);
	});

	it("is stale at exactly 24h", () => {
		const cache = { ...createMappedModels(), fetchedAt: now - MODELS_CACHE_TTL_MS };
		expect(isModelsCacheFresh(cache, now)).toBe(false);
	});

	it("is stale beyond 24h", () => {
		const cache = { ...createMappedModels(), fetchedAt: now - MODELS_CACHE_TTL_MS - 1 };
		expect(isModelsCacheFresh(cache, now)).toBe(false);
	});
});

describe("models request timeout wiring", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses a 3s timeout by default", async () => {
		const timeoutSpy = vi.spyOn(globalThis.AbortSignal, "timeout");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));

		try {
			await loadMappedModels("http://127.0.0.1:8317", "key");
			expect(MODELS_REQUEST_TIMEOUT_MS).toBe(3000);
			expect(timeoutSpy).toHaveBeenCalledWith(3000);
			expect(timeoutSpy).toHaveBeenCalledTimes(1);
		} finally {
			fetchMock.mockRestore();
			timeoutSpy.mockRestore();
		}
	});

	it("allows the caller to override the timeout", async () => {
		const timeoutSpy = vi.spyOn(globalThis.AbortSignal, "timeout");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));

		try {
			await loadMappedModels("http://127.0.0.1:8317", "key", 750);
			expect(timeoutSpy).toHaveBeenCalledWith(750);
			expect(timeoutSpy).toHaveBeenCalledTimes(1);
		} finally {
			fetchMock.mockRestore();
			timeoutSpy.mockRestore();
		}
	});

	it("propagates a custom timeout through fetchCodexModels", async () => {
		const timeoutSpy = vi.spyOn(globalThis.AbortSignal, "timeout");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));

		try {
			await fetchCodexModels("http://127.0.0.1:8317/v1/models?client_version=pi", "key", 500);
			expect(timeoutSpy).toHaveBeenCalledWith(500);
		} finally {
			fetchMock.mockRestore();
			timeoutSpy.mockRestore();
		}
	});
});

describe("resolveMappedModels cache behavior", () => {
	it("returns fresh cache without fetching", async () => {
		const agentDir = tempAgentDir();
		const cached = createMappedModels({ models: [createModel("cached")], fastModelIds: ["fast-cached"] });
		saveModelsCache(agentDir, cached, Date.now() - 60 * 60 * 1000);

		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not fetch"));

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key");
			expect(fetchMock).not.toHaveBeenCalled();
			expect(result.fromCache).toBe(true);
			expect(result.stale).toBeUndefined();
			expect(result.loaded.models).toEqual(cached.models);
			expect(result.loaded.fastModelIds).toEqual(["fast-cached"]);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("fetches remotely when no cache exists", async () => {
		const agentDir = tempAgentDir();
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [createCodexModel("remote")] }), { status: 200 }));

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.fromCache).toBe(false);
			expect(result.loaded.models.map((model) => model.id)).toEqual(["remote"]);
			const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
			expect(diskCache?.models[0].id).toBe("remote");
			expect(isModelsCacheFresh(diskCache!)).toBe(true);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("forceRefresh bypasses even a fresh cache", async () => {
		const agentDir = tempAgentDir();
		const cached = createMappedModels({ models: [createModel("cached")] });
		saveModelsCache(agentDir, cached, Date.now());

		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [createCodexModel("forced")] }), { status: 200 }));

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key", {
				forceRefresh: true,
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.fromCache).toBe(false);
			expect(result.loaded.models[0].id).toBe("forced");
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("refreshes a stale cache when the remote call succeeds", async () => {
		const agentDir = tempAgentDir();
		const stale = createMappedModels({ models: [createModel("stale")] });
		saveModelsCache(agentDir, stale, Date.now() - MODELS_CACHE_TTL_MS - 1000);

		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ models: [createCodexModel("fresh")] }), { status: 200 }));

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.fromCache).toBe(false);
			expect(result.loaded.models[0].id).toBe("fresh");
			const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
			expect(diskCache?.models[0].id).toBe("fresh");
			expect(isModelsCacheFresh(diskCache!)).toBe(true);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("falls back to a stale cache when the remote call fails", async () => {
		const agentDir = tempAgentDir();
		const stale = createMappedModels({ models: [createModel("stale-fallback")] });
		saveModelsCache(agentDir, stale, Date.now() - MODELS_CACHE_TTL_MS - 1000);

		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

		try {
			const result = await resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.fromCache).toBe(true);
			expect(result.stale).toBe(true);
			expect(result.loaded.models[0].id).toBe("stale-fallback");
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("does not fall back when forceRefresh is requested and the remote call fails", async () => {
		const agentDir = tempAgentDir();
		const stale = createMappedModels({ models: [createModel("stale")] });
		saveModelsCache(agentDir, stale, Date.now() - MODELS_CACHE_TTL_MS - 1000);

		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

		try {
			await expect(
				resolveMappedModels(agentDir, "http://127.0.0.1:8317", "key", { forceRefresh: true }),
			).rejects.toThrow("network down");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			fetchMock.mockRestore();
		}
	});
});

describe("provider startup cache behavior", () => {
	it("uses a fresh cache on startup and does not fetch", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const cached = createMappedModels({
				models: [createModel("startup-cached")],
				fastModelIds: ["startup-fast"],
			});
			saveModelsCache(agentDir, cached, Date.now() - 60 * 60 * 1000);

			const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should not fetch"));
			const { pi, commands } = createPiMock();

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(fetchMock).not.toHaveBeenCalled();
				expect(commands.has("cliproxyapi-refresh")).toBe(true);

				const callsWithModels = (
					(pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls as Array<
						[string, { models?: PiProviderModel[] }]
					>
				).filter(([, config]) => config.models && config.models.length > 0);
				expect(callsWithModels.length).toBeGreaterThan(0);
				expect(callsWithModels[0]?.[1].models?.map((model: PiProviderModel) => model.id)).toEqual([
					"startup-cached",
				]);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("refreshes a stale cache on startup and registers the new models", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const stale = createMappedModels({ models: [createModel("stale-startup")] });
			saveModelsCache(agentDir, stale, Date.now() - MODELS_CACHE_TTL_MS - 1000);

			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response(JSON.stringify({ models: [createCodexModel("fresh-startup", true)] }), { status: 200 }),
				);
			const { pi } = createPiMock();

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(fetchMock).toHaveBeenCalledTimes(1);

				const callsWithModels = (
					(pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls as Array<
						[string, { models?: PiProviderModel[] }]
					>
				).filter(([, config]) => config.models && config.models.length > 0);
				expect(callsWithModels[0]?.[1].models?.[0].id).toBe("fresh-startup");

				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCache?.models[0].id).toBe("fresh-startup");
				expect(diskCache?.fastModelIds).toEqual(["fresh-startup"]);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("falls back to a stale cache when the startup fetch fails", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const stale = createMappedModels({ models: [createModel("stale-fallback-startup")] });
			saveModelsCache(agentDir, stale, Date.now() - MODELS_CACHE_TTL_MS - 1000);

			const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
			const { pi } = createPiMock();

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(fetchMock).toHaveBeenCalledTimes(1);

				const callsWithModels = (
					(pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls as Array<
						[string, { models?: PiProviderModel[] }]
					>
				).filter(([, config]) => config.models && config.models.length > 0);
				expect(callsWithModels[0]?.[1].models?.[0].id).toBe("stale-fallback-startup");
			} finally {
				fetchMock.mockRestore();
			}
		});
	});
});

describe("/cliproxyapi-refresh command", () => {
	it("is registered by the provider extension", async () => {
		await withTempAgentDir(async () => {
			const { pi, commands } = createPiMock();
			await expect(providerExtension(pi)).resolves.toBeUndefined();
			const refresh = commands.get("cliproxyapi-refresh");
			expect(refresh).toBeDefined();
			expect(refresh?.description).toContain("refresh");
		});
	});

	it("refuses arguments and notifies usage", async () => {
		await withTempAgentDir(async () => {
			const { pi, commands } = createPiMock();
			await providerExtension(pi);
			const refresh = commands.get("cliproxyapi-refresh")!;
			const notify = vi.fn();
			const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;

			await refresh.handler("now", ctx);
			expect(notify).toHaveBeenCalledWith("Usage: /cliproxyapi-refresh", "error");
		});
	});

	it("notifies an error when the provider is not configured", async () => {
		await withTempAgentDir(async () => {
			const { pi, commands } = createPiMock();
			await providerExtension(pi);
			const refresh = commands.get("cliproxyapi-refresh")!;
			const notify = vi.fn();
			const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;

			await refresh.handler("", ctx);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("not configured"), "error");
		});
	});

	it("force-refreshes models, updates the cache, and updates fast model ids", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });
			const stale = createMappedModels({ models: [createModel("stale-refresh")] });
			saveModelsCache(agentDir, stale, Date.now() - MODELS_CACHE_TTL_MS - 1000);

			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(() =>
					Promise.resolve(
						new Response(JSON.stringify({ models: [createCodexModel("refreshed", true)] }), { status: 200 }),
					),
				);
			const { pi, commands } = createPiMock();

			try {
				await providerExtension(pi);
				const refresh = commands.get("cliproxyapi-refresh")!;
				const notify = vi.fn();
				const model = { id: "refreshed", provider: "cliproxyapi" } as Model<Api>;
				const ctx = { model, ui: { notify } } as unknown as ExtensionCommandContext;

				await refresh.handler("", ctx);

				expect(fetchMock).toHaveBeenCalledTimes(2);
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("Refreshed 1 CLIProxyAPI models"), "info");

				const diskCache = loadModelsCache(agentDir, "http://127.0.0.1:8317");
				expect(diskCache?.models[0].id).toBe("refreshed");
				expect(diskCache?.fastModelIds).toEqual(["refreshed"]);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("notifies an error when the remote refresh fails", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeConfig(agentDir, { baseUrl: "http://127.0.0.1:8317", apiKey: "key" });

			const fetchMock = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
			const { pi, commands } = createPiMock();

			try {
				await providerExtension(pi);
				const refresh = commands.get("cliproxyapi-refresh")!;
				const notify = vi.fn();
				const model = { id: "any", provider: "cliproxyapi" } as Model<Api>;
				const ctx = { model, ui: { notify } } as unknown as ExtensionCommandContext;

				await refresh.handler("", ctx);

				expect(notify).toHaveBeenCalledWith(
					expect.stringContaining("Failed to refresh CLIProxyAPI models"),
					"error",
				);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});
});
