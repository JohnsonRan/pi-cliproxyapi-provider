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

describe("pi 0.80.9 compatibility", () => {
	it("starts with the current ModelRegistry facade and keeps the setup command available", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-extension-test-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousEnv = new Map(CLIPROXYAPI_ENV_NAMES.map((name) => [name, process.env[name]]));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		for (const name of CLIPROXYAPI_ENV_NAMES) delete process.env[name];

		const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
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
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ models: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		try {
			await expect(providerExtension(pi)).resolves.toBeUndefined();
			expect(fetchMock).not.toHaveBeenCalled();

			const sessionCtx = {
				mode: "print",
				modelRegistry: {},
			} as unknown as ExtensionContext;
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({}, sessionCtx);
			}

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
			// OAuth-only registration keeps `/login cliproxyapi` off the API-key selector.
			for (const [, config] of (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls) {
				expect(config).not.toHaveProperty("apiKey");
			}

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
			expect(commands.has("cliproxyapi")).toBe(true);
			expect(commands.has("cpa")).toBe(false);
			expect(loadConfigFile(agentDir)).toEqual(
				expect.objectContaining({ baseUrl: "http://127.0.0.1:8317", apiKey: "new-key" }),
			);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("CLIProxyAPI configured"), "info");
			// Dedicated command may register ambient apiKey for request auth, but only after setup.
			const postSetupConfigs = (pi.registerProvider as ReturnType<typeof vi.fn>).mock.calls.map(
				([, config]) => config as { apiKey?: string },
			);
			expect(postSetupConfigs.some((config) => config.apiKey === "new-key")).toBe(true);

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
			input.mockClear();
			notify.mockClear();
			fetchMock.mockClear();

			await setupCommand.handler("", commandCtx);

			expect(input).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("run /logout before /cliproxyapi"), "error");
		} finally {
			fetchMock.mockRestore();
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
	});
});
