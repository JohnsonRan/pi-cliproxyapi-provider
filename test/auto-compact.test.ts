import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactionController, resolveCompactionSessionId } from "../extensions/auto-compact.ts";

describe("compaction controller", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function setup(cleanupResources = vi.fn()) {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-auto-compact-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-auto-compact-cwd-"));
		tempDirs.push(agentDir, cwd);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, `${JSON.stringify({ compaction: { enabled: true, reserveTokens: 16384 } })}\n`);

		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		const controller = new CompactionController(agentDir, "cliproxyapi", cleanupResources);
		controller.register(pi);

		const model = {
			id: "gpt-5.6-sol",
			provider: "cliproxyapi",
			api: "openai-codex-responses",
			contextWindow: 272000,
		} as Model<Api>;
		const sessionId = "session-compact-1";
		const ctx = {
			cwd,
			model,
			sessionId,
			sessionManager: { getSessionId: () => sessionId },
			isProjectTrusted: () => false,
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.({}, ctx);

		return { ctx, handlers, settingsPath, cleanupResources, sessionId, controller };
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

	it("cleans all resources and clears settings when the extension runtime shuts down", () => {
		const { ctx, handlers, cleanupResources, controller } = setup();
		handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
		expect(cleanupResources).toHaveBeenCalledWith(undefined);
		expect(controller.getCompactionSettings()).toBeUndefined();
	});

	it("cleans all resources when the compacted session id is missing", () => {
		const { handlers, cleanupResources } = setup();
		handlers.get("session_compact")?.({ reason: "manual" }, {
			sessionManager: { getSessionId: () => "" },
		} as unknown as ExtensionContext);
		expect(cleanupResources).toHaveBeenCalledWith(undefined);
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

	it("reloads footer settings after provider turns without cleaning resources", async () => {
		const { ctx, handlers, settingsPath, controller, cleanupResources } = setup();
		expect(controller.getCompactionSettings()).toMatchObject({ enabled: true, reserveTokens: 16384 });
		writeFileSync(settingsPath, `${JSON.stringify({ compaction: { enabled: false, reserveTokens: 32768 } })}\n`);

		await handlers.get("turn_end")?.(
			{
				message: { role: "assistant", provider: "cliproxyapi", model: ctx.model!.id },
			},
			ctx,
		);
		expect(controller.getCompactionSettings()).toMatchObject({ enabled: false, reserveTokens: 32768 });
		expect(cleanupResources).not.toHaveBeenCalled();
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
