import { readFileSync } from "node:fs";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, FooterComponent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	applyFastPayloadHook,
	type CliproxyCodexStreamSimple,
	patchCodexSource,
	withPriorityServiceTier,
	wrapStreamSimpleForFast,
} from "../extensions/codex-stream.ts";
import { FastModeController } from "../extensions/fast.ts";
import { FastFooterController, formatFastModelStatus } from "../extensions/fast-footer.ts";
import { loadMappedModels } from "../extensions/lib.ts";

const model = {
	id: "gpt-5.4",
	provider: "cliproxyapi",
} as Model<Api>;

describe("Codex WebSocket transport patch", () => {
	it("reconnects WebSocket instead of falling back to SSE", () => {
		const source = readFileSync(
			new URL("../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js", import.meta.url),
			"utf8",
		);
		const patched = patchCodexSource(source, ["cliproxyapi"]);

		expect(patched).toContain("const websocketDisabledForSession = false;");
		expect(patched).toContain("let websocketRetries = 0;");
		expect(patched).toContain("const connectionLimitBeforeStart = !websocketStarted");
		expect(patched).toContain("isCodexNonTransportError(error) && !connectionLimitBeforeStart");
		expect(patched).toContain("const maxWebSocketRetries = Number.isFinite(options?.maxRetries)");
		expect(patched).toContain("? Math.min(Math.max(0, Math.floor(options.maxRetries)), 5)");
		expect(patched).toContain(": 3;");
		expect(patched).not.toContain('fallbackTransport: websocketStarted ? undefined : "sse",');
		expect(patched).not.toContain("websocketSseFallbackSessions.add(sessionId);");
		expect(patched).not.toContain("recordWebSocketSseFallback(options?.sessionId);\n                        break;");
	});
});

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

describe("Fast footer model status", () => {
	it("appends lowercase fast after the reasoning level only while Fast is effective", () => {
		expect(formatFastModelStatus("gpt-5.6-sol", true, "xhigh", true)).toBe("gpt-5.6-sol • xhigh • fast");
		expect(formatFastModelStatus("gpt-5.6-sol", true, "xhigh", false)).toBe("gpt-5.6-sol • xhigh");
	});

	it("refreshes pi's built-in footer without replacing it", () => {
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([model.id]);
		const setFooter = vi.fn();
		const setStatus = vi.fn();
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const ctx = {
			mode: "tui",
			model,
			ui: { setFooter, setStatus },
		} as unknown as ExtensionContext;
		const footer = new FastFooterController(model.provider, fastMode);
		footer.register(pi);

		handlers.get("session_start")?.({}, ctx);
		footer.refresh(ctx);

		expect(setFooter).not.toHaveBeenCalled();
		expect(setStatus).toHaveBeenCalledWith("cliproxyapi-fast-refresh", undefined);
		handlers.get("session_shutdown")?.({}, ctx);
	});

	it("patches and restores the built-in footer across session reloads", () => {
		const originalRender = FooterComponent.prototype.render;
		const displayModel = { id: model.id, provider: model.provider, reasoning: true };
		const stubRender = function stubRender(this: FooterComponent, width: number): string[] {
			const session = (this as unknown as { session: { state: { model: typeof displayModel } } }).session;
			if (width < 0) throw new Error("render failed");
			return [`${session.state.model.id}|${session.state.model.reasoning}`];
		};
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([model.id]);
		fastMode.setEnabled(true);
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const ctx = {
			mode: "tui",
			ui: {
				theme: {
					fg: (color: string, text: string) => (color === "warning" ? `<yellow>${text}</yellow>` : text),
				},
			},
		} as unknown as ExtensionContext;
		const footer = new FastFooterController(model.provider, fastMode);
		const component = Object.create(FooterComponent.prototype) as FooterComponent;
		Object.defineProperty(component, "session", {
			value: { state: { model: displayModel, thinkingLevel: "xhigh" } },
		});

		try {
			FooterComponent.prototype.render = stubRender;
			footer.register(pi);
			handlers.get("session_start")?.({}, ctx);

			expect(component.render(80)).toEqual(["gpt-5.4 • xhigh • <yellow>fast</yellow>|false"]);
			expect(displayModel).toEqual({ id: "gpt-5.4", provider: "cliproxyapi", reasoning: true });

			fastMode.setEnabled(false);
			expect(component.render(80)).toEqual(["gpt-5.4|true"]);
			fastMode.setEnabled(true);
			fastMode.setSupportedModelIds([]);
			expect(component.render(80)).toEqual(["gpt-5.4|true"]);
			fastMode.setSupportedModelIds([model.id]);

			expect(() => component.render(-1)).toThrow("render failed");
			expect(displayModel).toEqual({ id: "gpt-5.4", provider: "cliproxyapi", reasoning: true });

			handlers.get("session_shutdown")?.({}, ctx);
			expect(FooterComponent.prototype.render).toBe(stubRender);

			handlers.get("session_start")?.({}, ctx);
			expect(component.render(80)).toEqual(["gpt-5.4 • xhigh • <yellow>fast</yellow>|false"]);
		} finally {
			handlers.get("session_shutdown")?.({}, ctx);
			FooterComponent.prototype.render = originalRender;
		}
	});
});

describe("Fast catalog mapping", () => {
	it("returns the model ids that advertise Fast", async () => {
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
			expect(loaded.fastModelIds).toEqual(["gpt-5.4", "gpt-5.5"]);
			expect(loaded.models.map((entry) => entry.id)).toEqual([
				"gpt-5.4",
				"gpt-5.5",
				"speed-tier-only",
				"custom-model",
			]);
			expect(fetchMock).toHaveBeenCalledWith(
				"http://127.0.0.1:8317/v1/models?client_version=pi",
				expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-key" }) }),
			);
		} finally {
			fetchMock.mockRestore();
		}
	});
});

describe("Fast stream wrapper", () => {
	it("passes options through unchanged when Fast is not effective", () => {
		let captured: SimpleStreamOptions | undefined;
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = (_model, _context, options) => {
			captured = options;
			return streamResult;
		};
		const wrapped = wrapStreamSimpleForFast(baseStream, () => false);
		const options: SimpleStreamOptions = { timeoutMs: 1234 };

		expect(wrapped(model, { messages: [] }, options)).toBe(streamResult);
		expect(captured).toBe(options);
	});

	it("preserves stream options and composes the Fast payload hook when enabled", async () => {
		let captured: SimpleStreamOptions | undefined;
		let observed: unknown;
		const streamResult = {} as ReturnType<CliproxyCodexStreamSimple>;
		const baseStream: CliproxyCodexStreamSimple = (_model, _context, options) => {
			captured = options;
			return streamResult;
		};
		const wrapped = wrapStreamSimpleForFast(baseStream, () => true);
		const options: SimpleStreamOptions = {
			timeoutMs: 1234,
			onPayload: (payload) => {
				observed = payload;
				return undefined;
			},
		};

		expect(wrapped(model, { messages: [] }, options)).toBe(streamResult);
		expect(captured?.timeoutMs).toBe(1234);
		expect(captured).not.toBe(options);
		const shaped = await captured?.onPayload?.({ model: "gpt-5.4" }, model);
		expect(observed).toEqual({ model: "gpt-5.4", service_tier: "priority" });
		expect(shaped).toEqual({ model: "gpt-5.4", service_tier: "priority" });
	});
});

describe("Fast payload shaping", () => {
	it("adds priority without mutating the original payload", () => {
		const original = { model: "gpt-5.4", service_tier: "default" };
		const shaped = withPriorityServiceTier(original);

		expect(shaped).toEqual({ model: "gpt-5.4", service_tier: "priority" });
		expect(original).toEqual({ model: "gpt-5.4", service_tier: "default" });
	});

	it("leaves non-object payloads unchanged", () => {
		const arrayPayload: unknown[] = [];
		expect(withPriorityServiceTier(null)).toBeNull();
		expect(withPriorityServiceTier("payload")).toBe("payload");
		expect(withPriorityServiceTier(arrayPayload)).toBe(arrayPayload);
	});

	it("lets pi payload hooks inspect and override the injected tier", async () => {
		let observed: unknown;
		const result = await applyFastPayloadHook({ model: "gpt-5.4" }, model, (payload) => {
			observed = payload;
			return { ...(payload as Record<string, unknown>), service_tier: "default" };
		});

		expect(observed).toEqual({ model: "gpt-5.4", service_tier: "priority" });
		expect(result).toEqual({ model: "gpt-5.4", service_tier: "default" });
	});

	it("keeps priority when later payload hooks return undefined", async () => {
		const result = await applyFastPayloadHook({ model: "gpt-5.4" }, model, () => undefined);
		expect(result).toEqual({ model: "gpt-5.4", service_tier: "priority" });
	});
});
