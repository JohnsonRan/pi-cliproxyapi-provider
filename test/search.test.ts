import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pauseController } from "../extensions/pause.ts";
import {
	parseSearchResponse,
	readSearchResponse,
	registerNativeSearch,
	SEARCH_TOOL_NAME,
} from "../extensions/search.ts";
import { SessionHierarchy } from "../extensions/session.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	pauseController.setEnabled(false);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const model: Model<Api> = {
	id: "search-model",
	name: "Search",
	provider: "cliproxyapi",
	api: "openai-codex-responses",
	baseUrl: "http://cpa.invalid/prefix/backend-api/",
	reasoning: false,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 16384,
	cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
};
function responsePayload() {
	return {
		status: "completed",
		output: [
			{
				type: "web_search_call",
				status: "completed",
				action: { type: "search", sources: [{ url: "https://example.com/", title: "Example" }] },
			},
			{
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Grounded answer.",
						annotations: [
							{
								type: "url_citation",
								url: "https://example.com/",
								title: "Example",
								start_index: 0,
								end_index: 8,
							},
							{ type: "url_citation", url: "https://other.example/", title: "Other" },
							{ type: "url_citation", url: "javascript:alert(1)", title: "unsafe" },
						],
					},
				],
			},
		],
		usage: {
			input_tokens: 100,
			output_tokens: 20,
			input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
		},
	};
}
function setup(enabled = false) {
	const agentDir = mkdtempSync(join(tmpdir(), "cpa-search-"));
	dirs.push(agentDir);
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	let active = ["read", "write"];
	const pi = {
		registerTool: vi.fn((tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
			tools.set(tool.name, tool);
			active.push(tool.name);
		}),
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
			commands.set(name, command),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		model,
		ui: { notify: vi.fn() },
		sessionManager: { getSessionId: () => "current-session" },
		modelRegistry: {
			find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "real-key", headers: { "X-Custom": "kept" } })),
		},
	} as unknown as ExtensionCommandContext;
	let supported = true;
	registerNativeSearch({
		pi,
		agentDir,
		providerId: model.provider,
		enabled,
		isSupported: (id) => supported && id === model.id,
		shouldUseFast: () => true,
		hierarchy: new SessionHierarchy(),
	});
	return {
		pi,
		ctx,
		tools,
		agentDir,
		revoke: () => {
			supported = false;
		},
		command: (args: string) => commands.get("cliproxyapi-search")!.handler(args, ctx),
		run: (query = "Latest news", selected?: string, signal?: AbortSignal) =>
			tools.get(SEARCH_TOOL_NAME)!.execute("call", { query, model: selected }, signal, undefined, ctx),
	};
}

describe("native search results", () => {
	it("preserves text and unique safe citations, with nested usage accounting", () => {
		const result = parseSearchResponse(responsePayload(), model);
		expect(result.content[0].text).toContain("Grounded answer.");
		expect(result.content[0].text).toContain("https://other.example/");
		expect(result.content[0].text).not.toContain("javascript:");
		expect(result.details.sources).toHaveLength(2);
		expect(result.details.searches).toBe(1);
		expect(result.usage).toMatchObject({ input: 30, output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 120 });
		expect(result.usage?.cost.total).toBeGreaterThan(0);
	});
	it("rejects an answer that did not actually perform native search", () => {
		const payload = responsePayload();
		payload.output.shift();
		expect(() => parseSearchResponse(payload, model)).toThrow("no completed native web search");
		expect(() => parseSearchResponse({ status: "failed", output: [] }, model)).toThrow("did not complete");
		expect(() => parseSearchResponse({ status: "completed" }, model)).toThrow("no output array");
		expect(() =>
			parseSearchResponse({ status: "completed", output: [{ type: "web_search_call", status: "failed" }] }, model),
		).toThrow("web search failed");
	});
	it("marks incomplete answers and truncates oversized output", () => {
		const payload = responsePayload();
		payload.status = "incomplete";
		payload.output.push({
			type: "message",
			content: [{ type: "output_text", text: "x".repeat(60000), annotations: [] }],
		});
		const result = parseSearchResponse(payload, model);
		expect(result.details.incomplete).toBe(true);
		expect(result.content[0].text).toContain("Search response incomplete");
		expect(result.content[0].text).toContain("Search output truncated");
		expect(result.content[0].text.length).toBeLessThan(52000);
	});
	it("bounds the response body, handles HTTP and JSON errors, and cancels readers", async () => {
		await expect(readSearchResponse(new Response("unauthorized", { status: 401 }))).rejects.toThrow("HTTP 401");
		await expect(readSearchResponse(new Response("not json"))).rejects.toThrow("invalid JSON");
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(readSearchResponse(new Response(body))).rejects.toThrow("exceeds 2 MiB");
		expect(cancelled).toBe(true);
	});
});

describe("native search tool and opt-in", () => {
	it("registers only after opt-in and never changes unrelated active tools", async () => {
		const s = setup();
		expect(s.tools.size).toBe(0);
		await s.command("on");
		expect(s.pi.getActiveTools()).toEqual(["read", "write", SEARCH_TOOL_NAME]);
		expect(JSON.parse(readFileSync(join(s.agentDir, "cliproxyapi.json"), "utf8"))).toMatchObject({ webSearch: true });
		await s.command("off");
		expect(s.pi.getActiveTools()).toEqual(["read", "write"]);
		await expect(s.run()).rejects.toThrow("disabled");
		await s.command("on");
		expect(s.pi.registerTool).toHaveBeenCalledTimes(1);
	});
	it("does not enable search when persisting settings fails", async () => {
		const s = setup();
		writeFileSync(join(s.agentDir, "cliproxyapi.json"), "{");
		await s.command("on");
		expect(s.tools.size).toBe(0);
		expect(s.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save"), "error");
	});
	it("sends an isolated Responses request with real auth, safe redirects, Fast, and citations", async () => {
		const s = setup(true);
		const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(responsePayload())));
		const result = await s.run();
		const [url, init] = mock.mock.calls[0];
		expect(String(url)).toBe("http://cpa.invalid/prefix/v1/responses");
		expect(init?.redirect).toBe("error");
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer real-key");
		expect(headers.get("X-Api-Key")).toBe("real-key");
		expect(headers.get("X-Custom")).toBe("kept");
		expect(headers.get("Session-Id")).toBe("current-session");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			model: model.id,
			input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Latest news" }] }],
			stream: false,
			store: false,
			tools: [{ type: "web_search" }],
			tool_choice: "required",
			service_tier: "priority",
			include: ["web_search_call.action.sources"],
		});
		expect(JSON.parse(String(init?.body))).not.toHaveProperty("previous_response_id");
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("https://example.com/") });
	});
	it("checks live capabilities and rejects unknown model IDs before any request", async () => {
		const s = setup(true);
		const mock = vi.spyOn(globalThis, "fetch");
		await expect(s.run("news", "unknown")).rejects.toThrow("explicit web_search support");
		await expect(s.run("   ")).rejects.toThrow("cannot be empty");
		s.revoke();
		await expect(s.run()).rejects.toThrow("explicit web_search support");
		expect(mock).not.toHaveBeenCalled();
	});
	it("allows an explicitly selected CPA model without switching the active provider", async () => {
		const s = setup(true);
		s.ctx.model = { ...model, provider: "other" };
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(responsePayload())));
		await expect(s.run()).rejects.toThrow("explicit web_search support");
		await expect(s.run("news", model.id)).resolves.toMatchObject({ details: { model: model.id } });
	});
	it("aborts while paused, without an HTTP request", async () => {
		const s = setup(true);
		writeFileSync(join(s.agentDir, "cliproxyapi.json"), JSON.stringify({ pause: true }));
		const mock = vi.spyOn(globalThis, "fetch");
		const abort = new AbortController();
		const result = s.run("news", undefined, abort.signal);
		const rejection = expect(result).rejects.toThrow();
		abort.abort();
		await rejection;
		expect(mock).not.toHaveBeenCalled();
	});
});
