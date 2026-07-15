import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	applyFastPayloadHook,
	type CliproxyCodexStreamSimple,
	withPriorityServiceTier,
	wrapStreamSimpleForFast,
} from "../extensions/codex-stream.ts";
import { FAST_MODE_ENTRY_TYPE, FastModeController, restoreFastModeFromEntries } from "../extensions/fast.ts";
import { loadMappedModels } from "../extensions/lib.ts";

const model = {
	id: "gpt-5.4",
	provider: "cliproxyapi",
} as Model<Api>;

describe("FastModeController", () => {
	it("combines configured default, session override, and model capability", () => {
		const mode = new FastModeController(false);
		mode.setSupportedModelIds(["gpt-5.4", " gpt-5.5 ", ""]);

		expect(mode.isEnabled()).toBe(false);
		expect(mode.getSource()).toBe("configured-default");
		expect(mode.isModelSupported("gpt-5.4")).toBe(true);
		expect(mode.isModelSupported("gpt-5.5")).toBe(true);
		expect(mode.isEffectiveFor("gpt-5.4")).toBe(false);
		expect(mode.isEffectiveFor("custom-model")).toBe(false);

		mode.setSessionEnabled(true);
		expect(mode.getSource()).toBe("session-override");
		expect(mode.isEffectiveFor("gpt-5.4")).toBe(true);
		expect(mode.isEffectiveFor("custom-model")).toBe(false);

		mode.setSessionEnabled(false);
		expect(mode.isEffectiveFor("gpt-5.4")).toBe(false);
		mode.clearSessionOverride();
		expect(mode.getSource()).toBe("configured-default");
		expect(mode.isEnabled()).toBe(false);
	});

	it("uses an enabled configured default until the session overrides it", () => {
		const mode = new FastModeController(true);
		mode.setSupportedModelIds(["gpt-5.4"]);

		expect(mode.isEffectiveFor("gpt-5.4")).toBe(true);
		mode.setSessionEnabled(false);
		expect(mode.isEffectiveFor("gpt-5.4")).toBe(false);
	});

	it("restores the latest Fast override from session entries", () => {
		const mode = new FastModeController(true);
		restoreFastModeFromEntries(mode, [
			{ type: "custom", customType: FAST_MODE_ENTRY_TYPE, data: { enabled: true } },
			{ type: "custom", customType: "other-extension", data: { enabled: true } },
			{ type: "custom", customType: FAST_MODE_ENTRY_TYPE, data: { enabled: false } },
		]);

		expect(mode.isEnabled()).toBe(false);
		expect(mode.getSource()).toBe("session-override");
		restoreFastModeFromEntries(mode, []);
		expect(mode.isEnabled()).toBe(true);
		expect(mode.getSource()).toBe("configured-default");
	});
});

describe("Fast catalog mapping", () => {
	it("returns the model ids that advertise Fast", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					models: [
						{ slug: "gpt-5.4", service_tiers: [{ id: "priority", name: "Fast" }] },
						{ slug: "gpt-5.5", additional_speed_tiers: ["fast"] },
						{ slug: "custom-model", service_tiers: [] },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		try {
			const loaded = await loadMappedModels("http://127.0.0.1:8317", "test-key");
			expect(loaded.fastModelIds).toEqual(["gpt-5.4", "gpt-5.5"]);
			expect(loaded.models.map((entry) => entry.id)).toEqual(["gpt-5.4", "gpt-5.5", "custom-model"]);
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
