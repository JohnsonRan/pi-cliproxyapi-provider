import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import providerExtension from "../extensions/index.ts";
import { AUTH_FILE_NAME, loadConfigFile } from "../extensions/lib.ts";

const CLIPROXYAPI_ENV_NAMES = [
	"CLIPROXYAPI_API_KEY",
	"CLIPROXYAPI_BASE_URL",
	"CLIPROXYAPI_FAST",
	"CLIPROXYAPI_PROVIDER_ID",
	"CLIPROXYAPI_PROVIDER_NAME",
] as const;

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
	const autocompleteWrappers: Array<(current: unknown) => unknown> = [];
	const pi = {
		registerCommand: vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			commands.set(name, options);
		}),
		unregisterProvider: vi.fn(),
		registerProvider: vi.fn(),
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
	} as unknown as ExtensionAPI;
	return { pi, handlers, autocompleteWrappers };
}

async function runSessionStart(
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>,
	autocompleteWrappers: Array<(current: unknown) => unknown>,
): Promise<void> {
	const sessionCtx = {
		mode: "interactive",
		modelRegistry: {},
		ui: {
			addAutocompleteProvider: (factory: (current: unknown) => unknown) => {
				autocompleteWrappers.push(factory);
			},
		},
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, sessionCtx);
	}
}

describe("pi 0.80.9 compatibility", () => {
	it("shows /cliproxyapi when unconfigured and hides it after successful setup", async () => {
		await withTempAgentDir(async (agentDir) => {
			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, handlers, autocompleteWrappers } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				expect(fetchMock).not.toHaveBeenCalled();

				await runSessionStart(handlers, autocompleteWrappers);

				expect([...commands.keys()]).toEqual(expect.arrayContaining(["cliproxyapi", "fast"]));
				expect(commands.has("cpa")).toBe(false);
				expect(pi.unregisterProvider).toHaveBeenCalledWith("cliproxyapi");
				expect(pi.registerProvider).toHaveBeenCalledWith(
					"cliproxyapi",
					expect.objectContaining({
						name: "CLIProxyAPI",
						oauth: expect.any(Object),
					}),
				);
				for (const [, config] of (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls) {
					expect(config).not.toHaveProperty("apiKey");
				}
				expect(autocompleteWrappers.length).toBe(1);

				const input = vi
					.fn<ExtensionCommandContext["ui"]["input"]>()
					.mockResolvedValueOnce("")
					.mockResolvedValueOnce("new-key");
				const notify = vi.fn<ExtensionCommandContext["ui"]["notify"]>();
				const commandCtx = {
					hasUI: true,
					modelRegistry: {},
					ui: { input, notify },
				} as unknown as ExtensionCommandContext;
				const setupCommand = commands.get("cliproxyapi");
				if (!setupCommand) throw new Error("/cliproxyapi was not registered");

				await setupCommand.handler("", commandCtx);

				expect(fetchMock).toHaveBeenCalledOnce();
				expect(loadConfigFile(agentDir)).toEqual(
					expect.objectContaining({ baseUrl: "http://127.0.0.1:8317", apiKey: "new-key" }),
				);
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("CLIProxyAPI configured"), "info");
				// Successful setup hides the dedicated command.
				expect(commands.has("cliproxyapi")).toBe(false);

				const postSetupConfigs = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls.map(
					([, config]) => config as { apiKey?: string },
				);
				expect(postSetupConfigs.some((config) => config.apiKey === "new-key")).toBe(true);

				const baseProvider = {
					async getSuggestions() {
						return {
							items: [
								{ value: "cliproxyapi", label: "cliproxyapi", description: "setup" },
								{ value: "fast", label: "fast", description: "toggle" },
							],
							prefix: "/",
						};
					},
					applyCompletion() {
						return { lines: [""], cursorLine: 0, cursorCol: 0 };
					},
				};
				const wrapped = autocompleteWrappers[0](baseProvider) as typeof baseProvider;
				const suggestions = await wrapped.getSuggestions();
				expect(suggestions?.items.map((item) => item.value)).toEqual(["fast"]);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("hides /cliproxyapi when already configured and restores it only after credentials are cleared", async () => {
		await withTempAgentDir(async (agentDir) => {
			writeFileSync(
				join(agentDir, AUTH_FILE_NAME),
				JSON.stringify({
					cliproxyapi: {
						type: "oauth",
						access: "stored-key",
						refresh: JSON.stringify({ baseUrl: "http://127.0.0.1:8317" }),
						expires: Date.now() + 60_000,
					},
				}),
				"utf8",
			);
			writeFileSync(
				join(agentDir, "cliproxyapi.json"),
				JSON.stringify({ baseUrl: "http://127.0.0.1:8317", apiKey: "stored-key" }),
				"utf8",
			);

			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, handlers, autocompleteWrappers } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();

				// Already configured → dedicated setup command stays hidden.
				expect(commands.has("cliproxyapi")).toBe(false);
				expect(commands.has("fast")).toBe(true);

				await runSessionStart(handlers, autocompleteWrappers);
				expect(autocompleteWrappers.length).toBe(1);

				const baseProvider = {
					async getSuggestions() {
						return {
							items: [
								{ value: "cliproxyapi", label: "cliproxyapi", description: "setup" },
								{ value: "fast", label: "fast", description: "toggle" },
							],
							prefix: "/",
						};
					},
					applyCompletion() {
						return { lines: [""], cursorLine: 0, cursorCol: 0 };
					},
				};
				const wrapped = autocompleteWrappers[0](baseProvider) as typeof baseProvider;
				const suggestions = await wrapped.getSuggestions();
				expect(suggestions?.items.map((item) => item.value)).toEqual(["fast"]);

				// Clearing only auth.json is not enough while cliproxyapi.json still provides credentials.
				writeFileSync(join(agentDir, AUTH_FILE_NAME), "{}\n", "utf8");
				const sessionCtx = {
					mode: "print",
					modelRegistry: {},
				} as unknown as ExtensionContext;
				for (const handler of handlers.get("input") ?? []) {
					await handler({ type: "input", text: "hello" }, sessionCtx);
				}
				expect(commands.has("cliproxyapi")).toBe(false);

				// Clear config too → command returns.
				writeFileSync(join(agentDir, "cliproxyapi.json"), "{}\n", "utf8");
				for (const handler of handlers.get("input") ?? []) {
					await handler({ type: "input", text: "hello again" }, sessionCtx);
				}
				expect(commands.has("cliproxyapi")).toBe(true);

				const afterClear = await wrapped.getSuggestions();
				expect(afterClear?.items.map((item) => item.value)).toEqual(["cliproxyapi", "fast"]);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});

	it("blocks /cliproxyapi while /login credentials remain even if the command is forced", async () => {
		await withTempAgentDir(async (agentDir) => {
			const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
			const { pi, handlers, autocompleteWrappers } = createPiMock(commands);
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await expect(providerExtension(pi)).resolves.toBeUndefined();
				await runSessionStart(handlers, autocompleteWrappers);

				const setupCommand = commands.get("cliproxyapi");
				if (!setupCommand) throw new Error("/cliproxyapi was not registered");

				writeFileSync(
					join(agentDir, AUTH_FILE_NAME),
					JSON.stringify({
						cliproxyapi: {
							type: "oauth",
							access: "stored-key",
							refresh: JSON.stringify({ baseUrl: "http://127.0.0.1:8317" }),
							expires: Date.now() + 60_000,
						},
					}),
					"utf8",
				);

				const input = vi.fn<ExtensionCommandContext["ui"]["input"]>();
				const notify = vi.fn<ExtensionCommandContext["ui"]["notify"]>();
				const commandCtx = {
					hasUI: true,
					modelRegistry: {},
					ui: { input, notify },
				} as unknown as ExtensionCommandContext;

				await setupCommand.handler("", commandCtx);

				expect(input).not.toHaveBeenCalled();
				expect(notify).toHaveBeenCalledWith(expect.stringContaining("run /logout before /cliproxyapi"), "error");
				expect(commands.has("cliproxyapi")).toBe(false);
			} finally {
				fetchMock.mockRestore();
			}
		});
	});
});
