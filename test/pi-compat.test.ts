import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import providerExtension from "../extensions/index.ts";
import { AUTH_FILE_NAME } from "../extensions/lib.ts";

const CLIPROXYAPI_ENV_NAMES = [
	"CLIPROXYAPI_API_KEY",
	"CLIPROXYAPI_BASE_URL",
	"CLIPROXYAPI_FAST",
	"CLIPROXYAPI_PROVIDER_ID",
	"CLIPROXYAPI_PROVIDER_NAME",
	"CLIPROXYAPI_TRANSPORT",
	"CLIPROXYAPI_USE_MAX_CONTEXT_WINDOW",
] as const;

function loadStoredAuth(agentDir: string): unknown {
	const auth = JSON.parse(readFileSync(join(agentDir, AUTH_FILE_NAME), "utf8")) as Record<string, unknown>;
	return auth.cliproxyapi;
}

async function withTempAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-extension-test-"));
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
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function createPiMock(commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const registeredModels = new Map<string, Model<Api>>();
	const registeredProviders = new Map<string, Record<string, unknown>>();
	const pi = {
		registerCommand: vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			commands.set(name, options);
		}),
		unregisterProvider: vi.fn((providerId: string) => {
			for (const key of registeredModels.keys()) {
				if (key.startsWith(`${providerId}/`)) registeredModels.delete(key);
			}
		}),
		registerProvider: vi.fn((providerOrId: string | Record<string, unknown>, config?: Record<string, unknown>) => {
			const provider = typeof providerOrId === "string" ? config : providerOrId;
			if (!provider) return;
			const providerId = typeof providerOrId === "string" ? providerOrId : String(provider.id);
			registeredProviders.set(providerId, provider);
			const getModels = provider.getModels;
			const models =
				typeof getModels === "function"
					? (getModels as () => Model<Api>[])()
					: Array.isArray(provider.models)
						? provider.models
						: [];
			for (const model of models) {
				const entry = model as Model<Api>;
				registeredModels.set(`${providerId}/${entry.id}`, {
					...entry,
					provider: providerId,
					api: (entry.api ?? provider.api) as Api,
					baseUrl: (entry.baseUrl ?? provider.baseUrl) as string,
				});
			}
		}),
		setModel: vi.fn(async () => true),
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
	} as unknown as ExtensionAPI;
	const modelRegistry = {
		find: (providerId: string, modelId: string) => registeredModels.get(`${providerId}/${modelId}`),
	};
	return { pi, handlers, modelRegistry, registeredModels, registeredProviders };
}

describe("pi 0.82.0 compatibility", () => {
	it("registers native API-key login and /fast without a dedicated /cliproxyapi command", async () => {
		await withTempAgentDir(async () => {
			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, registeredProviders } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(fetchMock).not.toHaveBeenCalled();

				expect(commands.size).toBe(4);
				expect(commands.has("fast")).toBe(true);
				expect(commands.has("pause")).toBe(true);
				expect(commands.has("continue")).toBe(true);
				expect(commands.has("cliproxyapi-refresh")).toBe(true);
				expect(commands.has("cliproxyapi")).toBe(false);
				expect(pi.unregisterProvider).toHaveBeenCalledWith("cliproxyapi");
				const provider = registeredProviders.get("cliproxyapi") as {
					stream?: unknown;
					streamSimple?: unknown;
				};
				expect(provider).toEqual(
					expect.objectContaining({
						name: "CLIProxyAPI",
						auth: {
							apiKey: expect.objectContaining({ login: expect.any(Function), resolve: expect.any(Function) }),
						},
						refreshModels: expect.any(Function),
						stream: expect.any(Function),
						streamSimple: expect.any(Function),
					}),
				);
				expect(provider.stream).not.toBe(provider.streamSimple);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("stores native login credentials without duplicating secrets in cliproxyapi.json", async () => {
		await withTempAgentDir(async (agentDir) => {
			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, registeredProviders } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).startsWith("https://models.dev/")) {
					return new Response(JSON.stringify({}), { status: 200 });
				}
				return new Response(JSON.stringify({ models: [{ slug: "native-model" }] }), { status: 200 });
			});

			try {
				await providerExtension(pi);
				writeFileSync(
					join(agentDir, "cliproxyapi.json"),
					JSON.stringify({ baseUrl: "http://old.example", apiKey: "old-key", fast: true }),
					"utf8",
				);
				const provider = registeredProviders.get("cliproxyapi") as {
					auth: {
						apiKey: {
							login: (interaction: {
								prompt: () => Promise<string>;
								notify: (event: unknown) => void;
							}) => Promise<unknown>;
							resolve: (input: {
								ctx: { env: (name: string) => Promise<string | undefined> };
								credential?: unknown;
							}) => Promise<unknown>;
						};
					};
					getModels: () => Array<{ id: string }>;
				};
				const answers = ["http://127.0.0.1:8317", "native-key"];
				const credential = await provider.auth.apiKey.login({
					prompt: async () => answers.shift() ?? "",
					notify: vi.fn(),
				});

				expect(credential).toEqual({
					type: "api_key",
					key: "native-key",
					env: { CLIPROXYAPI_BASE_URL: "http://127.0.0.1:8317" },
				});
				expect(provider.getModels().map((model) => model.id)).toEqual(["native-model"]);
				// The login callback runs before Pi persists auth.json, so old config remains available on failure.
				expect(JSON.parse(readFileSync(join(agentDir, "cliproxyapi.json"), "utf8"))).toMatchObject({
					apiKey: "old-key",
					baseUrl: "http://old.example",
				});

				await expect(
					provider.auth.apiKey.resolve({
						ctx: { env: async () => undefined },
						credential,
					}),
				).resolves.toEqual({
					auth: {
						apiKey: "native-key",
						baseUrl: "http://127.0.0.1:8317/backend-api/",
					},
					env: { CLIPROXYAPI_BASE_URL: "http://127.0.0.1:8317" },
					source: "stored",
				});
				expect(JSON.parse(readFileSync(join(agentDir, "cliproxyapi.json"), "utf8"))).toEqual({ fast: true });
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("persists and refreshes native credentials through ModelRuntime.login", async () => {
		await withTempAgentDir(async (agentDir) => {
			const runtime = await ModelRuntime.create({
				authPath: join(agentDir, AUTH_FILE_NAME),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const pi = {
				registerCommand: vi.fn(),
				on: vi.fn(),
				unregisterProvider: (providerId: string) => runtime.unregisterProvider(providerId),
				registerProvider: (provider: Provider) => runtime.registerNativeProvider(provider),
			} as unknown as ExtensionAPI;
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				if (String(input).startsWith("https://models.dev/")) {
					return new Response(JSON.stringify({}), { status: 200 });
				}
				expect(String(input)).toBe("http://new.example/v1/models?client_version=pi");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer new-key");
				return new Response(JSON.stringify({ models: [{ slug: "runtime-model" }] }), { status: 200 });
			});

			try {
				await providerExtension(pi);
				writeFileSync(
					join(agentDir, "cliproxyapi.json"),
					JSON.stringify({ baseUrl: "http://old.example", apiKey: "old-key", fast: true }),
					"utf8",
				);
				const answers = ["http://new.example", "new-key"];
				const credential = await runtime.login("cliproxyapi", "api_key", {
					prompt: async () => answers.shift() ?? "",
					notify: vi.fn(),
				});

				expect(credential).toEqual({
					type: "api_key",
					key: "new-key",
					env: { CLIPROXYAPI_BASE_URL: "http://new.example" },
				});
				expect(loadStoredAuth(agentDir)).toEqual({
					type: "api_key",
					key: "new-key",
					env: { CLIPROXYAPI_BASE_URL: "http://new.example" },
				});
				expect(JSON.parse(readFileSync(join(agentDir, "cliproxyapi.json"), "utf8"))).toEqual({ fast: true });
				expect(runtime.getModel("cliproxyapi", "runtime-model")).toEqual(
					expect.objectContaining({
						id: "runtime-model",
						baseUrl: "http://new.example/backend-api/",
					}),
				);
				expect(fetchMock).toHaveBeenCalledWith(
					"http://new.example/v1/models?client_version=pi",
					expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer new-key" }) }),
				);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("uses the same env-first credential priority for inference auth", async () => {
		await withTempAgentDir(async (agentDir) => {
			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, registeredProviders } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				if (String(input).startsWith("https://models.dev/")) {
					return new Response(JSON.stringify({}), { status: 200 });
				}
				expect(String(input)).toBe("http://env.example/v1/models?client_version=pi");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer env-key");
				return new Response(JSON.stringify({ models: [] }), { status: 200 });
			});
			await providerExtension(pi);
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://file.example", apiKey: "file-key" }),
				"utf8",
			);

			const provider = registeredProviders.get("cliproxyapi") as {
				auth: {
					apiKey: {
						resolve: (input: {
							ctx: { env: (name: string) => Promise<string | undefined> };
							credential?: unknown;
						}) => Promise<{
							auth: { apiKey: string; baseUrl: string };
							env?: Record<string, string>;
							source: string;
						}>;
					};
				};
				refreshModels?: (context: { allowNetwork: boolean; credential?: unknown }) => Promise<void>;
			};
			const credential = {
				type: "api_key",
				key: "stored-key",
				env: { CLIPROXYAPI_BASE_URL: "http://stored.example" },
			};

			try {
				const resolution = await provider.auth.apiKey.resolve({
					ctx: {
						env: async (name) =>
							name === "CLIPROXYAPI_API_KEY"
								? "env-key"
								: name === "CLIPROXYAPI_BASE_URL"
									? "http://env.example"
									: undefined,
					},
					credential,
				});
				expect(resolution).toEqual({
					auth: { apiKey: "env-key", baseUrl: "http://env.example/backend-api/" },
					env: { CLIPROXYAPI_BASE_URL: "http://env.example" },
					source: "CLIPROXYAPI_API_KEY",
				});

				// Pi converts the auth result back into the effective credential used by refreshModels.
				await provider.refreshModels?.({
					allowNetwork: true,
					credential: { type: "api_key", key: resolution.auth.apiKey, env: resolution.env },
				});
				expect(fetchMock).toHaveBeenCalled();
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("refreshes models through Pi's provider lifecycle", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "stored-key" }),
				"utf8",
			);

			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, registeredProviders } = createPiMock(commands);
			let catalogVersion = 1;
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).startsWith("https://models.dev/")) {
					return new Response(JSON.stringify({}), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(JSON.stringify({ models: [{ slug: `model-${catalogVersion}` }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});

			try {
				await providerExtension(pi);
				catalogVersion = 2;
				const provider = registeredProviders.get("cliproxyapi") as {
					refreshModels?: (context: { allowNetwork: boolean; signal?: AbortSignal }) => Promise<void>;
					getModels: () => Array<{ id: string }>;
				};
				await provider.refreshModels?.({ allowNetwork: true });
				expect(provider.getModels().map((model) => model.id)).toEqual(["model-2"]);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("updates the active session model with Fast pricing after /fast", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "stored-key" }),
				"utf8",
			);

			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, modelRegistry, registeredModels } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				if (String(input).startsWith("https://models.dev/")) {
					return new Response(
						JSON.stringify({
							openai: {
								models: {
									"gpt-5.6-sol": {
										cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
										experimental: {
											modes: {
												fast: {
													cost: { input: 10, output: 60, cache_read: 1, cache_write: 12.5 },
												},
											},
										},
									},
								},
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({ models: [{ slug: "gpt-5.6-sol", service_tiers: [{ id: "priority" }] }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			try {
				await providerExtension(pi);
				const currentModel = registeredModels.get("cliproxyapi/gpt-5.6-sol");
				expect(currentModel?.cost.input).toBe(5);
				const command = commands.get("fast");
				if (!command || !currentModel) throw new Error("Fast command or active model is unavailable");

				const ctx = {
					model: currentModel,
					modelRegistry,
					ui: { notify: vi.fn() },
				} as unknown as ExtensionCommandContext;
				await command.handler("", ctx);

				expect(pi.setModel).toHaveBeenCalledWith(
					expect.objectContaining({
						id: "gpt-5.6-sol",
						provider: "cliproxyapi",
						cost: { input: 10, output: 60, cacheRead: 1, cacheWrite: 12.5 },
					}),
				);

				const fastModel = (pi.setModel as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Model<Api>;
				await command.handler("", { ...ctx, model: fastModel });
				expect(pi.setModel).toHaveBeenLastCalledWith(
					expect.objectContaining({
						id: "gpt-5.6-sol",
						provider: "cliproxyapi",
						cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
					}),
				);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("loads native API-key models through the CLIProxyAPI Codex endpoint", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, AUTH_FILE_NAME),
				JSON.stringify({
					cliproxyapi: {
						type: "api_key",
						key: "stored-key",
						env: { CLIPROXYAPI_BASE_URL: "http://127.0.0.1:8317" },
					},
				}),
				"utf8",
			);

			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, registeredProviders } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [{ slug: "claude-through-cpa" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(fetchMock).toHaveBeenCalled();
				const provider = registeredProviders.get("cliproxyapi") as {
					baseUrl: string;
					getModels: () => Model<Api>[];
				};
				expect(provider.baseUrl).toBe("http://127.0.0.1:8317/backend-api/");
				expect(provider.getModels()[0]).toEqual(
					expect.objectContaining({ id: "claude-through-cpa", api: "cliproxyapi-codex-responses" }),
				);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});
});
