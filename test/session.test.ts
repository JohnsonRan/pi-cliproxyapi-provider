import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeSessionHeaders, readParentSessionId, SessionHierarchy, sessionId } from "../extensions/session.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "cpa-session-"));
	dirs.push(dir);
	return dir;
}
function harness() {
	vi.stubEnv("CLIPROXYAPI_PARENT_SESSION_ID", "");
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const hierarchy = new SessionHierarchy();
	const entries: SessionEntry[] = [];
	hierarchy.register({
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, fn),
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data } as SessionEntry),
	} as unknown as ExtensionAPI);
	const start = (id: string, parentSession?: string, reason = "startup") =>
		handlers.get("session_start")!({ reason }, {
			sessionManager: { getSessionId: () => id, getHeader: () => ({ parentSession }), getEntries: () => entries },
		} as unknown as ExtensionContext);
	return { hierarchy, start, shutdown: () => handlers.get("session_shutdown")!({}, {} as ExtensionContext) };
}

describe("real session ancestry", () => {
	it("reads only a valid session header, never infers an ID from a file name", () => {
		const dir = tempDir();
		const path = join(dir, "misleading-id.jsonl");
		writeFileSync(path, `${JSON.stringify({ type: "session", id: "real-parent" })}\nnot valid JSON\n`);
		expect(readParentSessionId(path)).toBe("real-parent");
		writeFileSync(path, JSON.stringify({ type: "message", id: "not-a-session" }));
		expect(readParentSessionId(path)).toBeUndefined();
		expect(readParentSessionId(dir)).toBeUndefined();
		expect(readParentSessionId(join(dir, "missing.jsonl"))).toBeUndefined();
		writeFileSync(path, "x".repeat(9000));
		expect(readParentSessionId(path)).toBeUndefined();
	});
	it("links forked/resumed children while keeping auxiliary calls independent", () => {
		const h = harness();
		const path = join(tempDir(), "parent.jsonl");
		writeFileSync(path, `${JSON.stringify({ type: "session", id: "parent" })}\n`);
		h.start("child", path, "fork");
		expect(h.hierarchy.headers({ sessionId: "child" })).toEqual({ "X-Codex-Parent-Thread-Id": "parent" });
		expect(h.hierarchy.headers({ sessionId: "summary", cacheRetention: "none" })).toEqual({});
		expect(h.hierarchy.headers({ sessionId: "other-session" })).toEqual({});
		expect(h.hierarchy.headers()).toEqual({});
		h.shutdown();
		expect(h.hierarchy.headers({ sessionId: "child" })).toEqual({});
		h.start("child", path, "resume");
		expect(h.hierarchy.headers({ sessionId: "child" })).toHaveProperty("X-Codex-Parent-Thread-Id", "parent");
		h.start("new-session", undefined, "new");
		expect(h.hierarchy.headers({ sessionId: "new-session" })).toEqual({});
	});
	it("accepts only an explicit immediate-parent launcher contract, not the permission root", () => {
		const h = harness();
		vi.stubEnv("PI_SUBAGENT_PARENT_SESSION", "root-not-immediate-parent");
		h.start("child");
		expect(h.hierarchy.headers({ sessionId: "child" })).toEqual({});
		vi.stubEnv("CLIPROXYAPI_PARENT_SESSION_ID", "immediate-parent");
		h.start("child");
		expect(h.hierarchy.headers({ sessionId: "child" })).toEqual({ "X-Codex-Parent-Thread-Id": "immediate-parent" });
		h.shutdown();
		h.start("child", undefined, "reload");
		expect(h.hierarchy.headers({ sessionId: "child" })).toEqual({ "X-Codex-Parent-Thread-Id": "immediate-parent" });
		h.start("unrelated", undefined, "new");
		expect(h.hierarchy.headers({ sessionId: "unrelated" })).toEqual({});
		h.start("unrelated", undefined, "reload");
		expect(h.hierarchy.headers({ sessionId: "unrelated" })).toEqual({});
	});
	it("honors request-specific parent metadata and rejects malformed or self-parent IDs", () => {
		const hierarchy = new SessionHierarchy();
		expect(hierarchy.headers({ sessionId: "child", metadata: { parent_session_id: "sdk-parent" } })).toEqual({
			"X-Codex-Parent-Thread-Id": "sdk-parent",
		});
		for (const parent of ["child", "bad\r\nheader", "C:/session.jsonl", 1, null]) {
			expect(hierarchy.headers({ sessionId: "child", metadata: { parent_session_id: parent } })).toEqual({});
		}
		expect(sessionId("x".repeat(257))).toBeUndefined();
	});
	it("preserves caller overrides and null suppressions regardless of header casing", () => {
		expect(
			mergeSessionHeaders(
				{ "X-Codex-Parent-Thread-Id": "default" },
				{ "x-codex-parent-thread-id": "caller", Other: "kept" },
			),
		).toEqual({ "x-codex-parent-thread-id": "caller", Other: "kept" });
		expect(
			mergeSessionHeaders({ "X-Codex-Parent-Thread-Id": "default" }, { "x-codex-parent-thread-id": null }),
		).toEqual({ "x-codex-parent-thread-id": null });
	});
});
