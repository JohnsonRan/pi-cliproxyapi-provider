import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	CLIPROXYAPI_CODEX_API,
	type CliproxyCodexStreamSimple,
	resolveCliproxyTransport,
	toFastCodexOptions,
	wrapCodexStreamForTransport,
	wrapStreamSimpleForTransport,
} from "../extensions/codex-stream.ts";
import { FastModeController } from "../extensions/fast.ts";
import { loadMappedModels } from "../extensions/lib.ts";
import { PauseController } from "../extensions/pause.ts";
import { ProviderStatusController, STATUS_KEY } from "../extensions/status.ts";

const model = {
	id: "gpt-5.4",
	provider: "cliproxyapi",
} as Model<Api>;

describe("FastModeController", () => {
	it("combines the global preference with model capability", () => {
		const mode = new FastModeController(false);
		mode.setSupportedModelIds(["gpt-5.4", " gpt-5.5 ", ""]);

		expect(mode.isEnabled()).toBe(false);
		expect(mode.isModelSupported("gpt-5.4")).toBe(true);
		expect(mode.isModelSupported("gpt-5.5")).toBe(true);
		expect(mode.isEffectiveFor("gpt-5.4")).toBe(false);
		expect(mode.isEffectiveFor("custom-model")).toBe(false);

		mode.setEnabled(true);
		expect(mode.isEffectiveFor("gpt-5.4")).toBe(true);
		expect(mode.isEffectiveFor("custom-model")).toBe(false);

		mode.setEnabled(false);
		expect(mode.isEffectiveFor("gpt-5.4")).toBe(false);
	});

	it("updates the global preference", () => {
		const mode = new FastModeController(false);

		mode.setEnabled(true);
		expect(mode.isEnabled()).toBe(true);
		mode.setEnabled(false);
		expect(mode.isEnabled()).toBe(false);
	});
});

describe("provider status line", () => {
	function setup(options: { fast?: boolean; supported?: boolean; provider?: string } = {}) {
		const fastMode = new FastModeController(options.fast ?? true);
		fastMode.setSupportedModelIds(options.supported === false ? [] : [model.id]);
		const pauseMode = new PauseController(false);
		const setStatus = vi.fn();
		const setFooter = vi.fn();
		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => void>();
		const pi = {
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const ctx = {
			mode: "tui",
			model: { ...model, provider: options.provider ?? model.provider },
			ui: {
				setStatus,
				setFooter,
				theme: {
					fg: (color: string, text: string) => (color === "warning" ? `<yellow>${text}</yellow>` : text),
					getColorMode: () => "256color",
				},
			},
		} as unknown as ExtensionContext;
		const status = new ProviderStatusController(model.provider, fastMode, pauseMode);
		status.register(pi);
		handlers.get("session_start")?.({}, ctx);
		return { status, fastMode, pauseMode, setStatus, setFooter, handlers, ctx };
	}
	const orangePaused = "\x1b[38;5;214mpaused\x1b[39m";

	it("shows Fast through the public status API without touching the footer", () => {
		const { setStatus, setFooter } = setup();
		expect(setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "<yellow>fast</yellow>");
		expect(setFooter).not.toHaveBeenCalled();
	});

	it("tracks pause changes and clears the label when nothing applies", () => {
		const { status, fastMode, pauseMode, setStatus } = setup();
		pauseMode.setEnabled(true);
		expect(setStatus).toHaveBeenLastCalledWith(STATUS_KEY, `<yellow>fast</yellow> • ${orangePaused}`);
		fastMode.setEnabled(false);
		status.refresh();
		expect(setStatus).toHaveBeenLastCalledWith(STATUS_KEY, orangePaused);
		pauseMode.setEnabled(false);
		expect(setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
	});

	it("omits Fast for unsupported models and all labels for other providers", () => {
		expect(setup({ supported: false }).setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
		const other = setup({ provider: "anthropic" });
		other.pauseMode.setEnabled(true);
		expect(other.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
	});

	it("follows model_select and stops listening after shutdown", () => {
		const { pauseMode, setStatus, handlers, ctx } = setup();
		handlers.get("model_select")?.({ model: { provider: "anthropic", id: "claude" } }, ctx);
		expect(setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
		handlers.get("session_shutdown")?.({}, ctx);
		const calls = setStatus.mock.calls.length;
		pauseMode.setEnabled(true);
		expect(setStatus).toHaveBeenCalledTimes(calls);
	});
});

describe("Fast catalog mapping", () => {
	it("marks the models that advertise Fast", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					models: [
						{ slug: "gpt-5.4", service_tiers: [{ id: "priority", name: "Fast" }] },
						{ slug: "gpt-5.5", service_tiers: [{ id: "flex" }] },
						{ slug: "speed-tier-only", additional_speed_tiers: ["fast"] },
						{ slug: "custom-model", service_tiers: [] },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		try {
			const loaded = await loadMappedModels("http://127.0.0.1:8317", "test-key");
			expect(loaded.models.map((entry) => [entry.id, entry.cpa?.fast ?? false])).toEqual([
				["gpt-5.4", true],
				["gpt-5.5", true],
				["speed-tier-only", false],
				["custom-model", false],
			]);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledWith(
				"http://127.0.0.1:8317/v1/models?client_version=cpa",
				expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-key" }) }),
			);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("keeps standard pricing regardless of Fast; Pi applies the tier multiplier per request", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input).startsWith("https://models.dev/")) {
				return new Response(
					JSON.stringify({
						openai: {
							models: {
								"gpt-5.6-sol": {
									cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
									experimental: { modes: { fast: { cost: { input: 10, output: 60 } } } },
								},
							},
						},
					}),
				);
			}
			return new Response(
				JSON.stringify({ models: [{ slug: "gpt-5.6-sol", service_tiers: [{ id: "priority" }] }] }),
			);
		});
		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-fast-test-"));
		try {
			const loaded = await loadMappedModels("http://127.0.0.1:8317", "test-key", { agentDir });
			expect(loaded.models[0]?.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
		} finally {
			fetchMock.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("Codex transport selection", () => {
	it("honors an explicit Pi transport setting", () => {
		expect(resolveCliproxyTransport({ transport: "websocket-cached" }, true)).toBe("websocket-cached");
		expect(resolveCliproxyTransport({ transport: "sse" }, false)).toBe("sse");
	});

	it("uses the catalog preference for Pi's default auto transport", () => {
		expect(resolveCliproxyTransport({ transport: "auto" }, false)).toBe("websocket");
		expect(resolveCliproxyTransport({ transport: "auto" }, true)).toBe("sse");
		expect(resolveCliproxyTransport(undefined, false)).toBe("websocket");
	});

	it("uses SSE for standalone no-cache requests", () => {
		expect(resolveCliproxyTransport({ cacheRetention: "none", transport: "websocket" }, false)).toBe("sse");
	});

	it("applies the resolved transport while preserving other options", () => {
		let captured: SimpleStreamOptions | undefined;
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const wrapped = wrapStreamSimpleForTransport(
			(_model, _context, options) => {
				captured = options;
				return streamResult;
			},
			(target, options) => resolveCliproxyTransport(options, target.id === "claude-backed"),
		);

		expect(wrapped({ ...model, id: "claude-backed" }, { messages: [] }, { timeoutMs: 1234 })).toBe(streamResult);
		expect(captured).toEqual({ timeoutMs: 1234, transport: "sse" });
	});

	it("preserves API-specific options on the full stream contract", () => {
		let captured: unknown;
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const wrapped = wrapCodexStreamForTransport(
			(_model, _context, options) => {
				captured = options;
				return streamResult;
			},
			() => "websocket",
		);

		const fullStreamModel = { ...model, api: CLIPROXYAPI_CODEX_API } as Model<typeof CLIPROXYAPI_CODEX_API>;
		expect(
			wrapped(fullStreamModel, normalizeContext({ messages: [] }), {
				reasoningEffort: "high",
				serviceTier: "default",
				textVerbosity: "high",
			}),
		).toBe(streamResult);
		expect(captured).toMatchObject({
			reasoningEffort: "high",
			serviceTier: "default",
			textVerbosity: "high",
			transport: "websocket",
		});
	});
});

describe("Fast stream options", () => {
	const reasoningModel = {
		...model,
		reasoning: true,
		maxTokens: 16384,
		contextWindow: 128000,
		thinkingLevelMap: { off: "none", low: "low", high: "high" },
	} as unknown as Model<Api>;

	it("mirrors stock simple options on the full stream and requests the priority tier", () => {
		const onPayload = vi.fn();
		const options = toFastCodexOptions(reasoningModel, {
			apiKey: "key",
			sessionId: "session",
			timeoutMs: 1234,
			reasoning: "high",
			onPayload,
		});
		expect(options).toMatchObject({
			apiKey: "key",
			sessionId: "session",
			timeoutMs: 1234,
			reasoningEffort: "high",
			serviceTier: "priority",
			onPayload,
		});
	});

	it("does not send a reasoning effort when thinking is off", () => {
		const options = toFastCodexOptions(reasoningModel, {
			apiKey: "key",
			reasoning: "off" as SimpleStreamOptions["reasoning"],
		});
		expect(options.reasoningEffort).toBeUndefined();
		expect(options.serviceTier).toBe("priority");
	});
});
