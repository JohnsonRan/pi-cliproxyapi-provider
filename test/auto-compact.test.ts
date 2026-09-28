import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CompactionController, resolveCompactionSessionId } from "../extensions/auto-compact.ts";

describe("compaction controller", () => {
	function setup(cleanupResources = vi.fn()) {
		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		new CompactionController(cleanupResources).register(pi);

		const sessionId = "session-compact-1";
		const ctx = {
			sessionId,
			sessionManager: { getSessionId: () => sessionId },
		} as unknown as ExtensionContext;
		return { ctx, handlers, cleanupResources, sessionId };
	}

	it.each([
		"manual",
		"threshold",
		"overflow",
	])("cleans the current session resources after %s compaction", (reason) => {
		const { ctx, handlers, cleanupResources, sessionId } = setup();
		handlers.get("session_compact")?.({ reason }, ctx);
		expect(cleanupResources).toHaveBeenCalledTimes(1);
		expect(cleanupResources).toHaveBeenCalledWith(sessionId);
	});

	it("leaves resource cleanup to Pi when the extension runtime shuts down", () => {
		const { handlers, cleanupResources } = setup();
		expect(handlers.has("session_shutdown")).toBe(false);
		expect(cleanupResources).not.toHaveBeenCalled();
	});

	it("never cleans other sessions when the compacted session id is missing", () => {
		const { handlers, cleanupResources } = setup();
		handlers.get("session_compact")?.({ reason: "manual" }, {
			sessionManager: { getSessionId: () => "" },
		} as unknown as ExtensionContext);
		expect(cleanupResources).not.toHaveBeenCalled();
	});

	it("keeps compaction working if resource cleanup throws", () => {
		const cleanupResources = vi.fn(() => {
			throw new Error("socket already gone");
		});
		const { ctx, handlers, sessionId } = setup(cleanupResources);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(() => handlers.get("session_compact")?.({}, ctx)).not.toThrow();
			expect(cleanupResources).toHaveBeenCalledWith(sessionId);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("socket already gone"));
		} finally {
			warn.mockRestore();
		}
	});
});

describe("resolveCompactionSessionId", () => {
	it("prefers sessionManager.getSessionId over a stale sessionId field", () => {
		expect(
			resolveCompactionSessionId({
				sessionId: "stale",
				sessionManager: { getSessionId: () => "current" },
			}),
		).toBe("current");
	});

	it("falls back to sessionId when sessionManager is unavailable", () => {
		expect(resolveCompactionSessionId({ sessionId: "fallback" })).toBe("fallback");
		expect(resolveCompactionSessionId({})).toBeUndefined();
	});
});
