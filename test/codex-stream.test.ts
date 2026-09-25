import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type AssistantMessage,
	cleanupSessionResources,
	type Model,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLIPROXYAPI_CODEX_API,
	createSyntheticCodexAccountId,
	createSyntheticCodexJwt,
	loadCliproxyCodexStreams,
	withCliproxyCodexAuth,
	wrapStreamSimpleForCliproxyAuth,
} from "../extensions/codex-stream.ts";
import { SessionHierarchy } from "../extensions/session.ts";

const REAL_API_KEY = "cpa-real-secret-key";

function createModel(baseUrl = "http://127.0.0.1:8317/backend-api/"): Model<typeof CLIPROXYAPI_CODEX_API> {
	return {
		id: "gpt-5.6-sol",
		name: "gpt-5.6-sol",
		api: CLIPROXYAPI_CODEX_API,
		provider: "cliproxyapi",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function completedEvent(id: string, output: unknown[] = []) {
	return {
		type: "response.completed",
		response: {
			id,
			status: "completed",
			output,
			usage: {
				input_tokens: 1,
				output_tokens: 0,
				total_tokens: 1,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
		},
	};
}

function decodeJwtPayload(token: string): Record<string, any> {
	const payload = token.split(".")[1];
	if (!payload) throw new Error("JWT payload is missing");
	return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, any>;
}

function toHeaders(headers?: ProviderHeaders): Headers {
	const result = new Headers();
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value !== null) result.set(name, value);
	}
	return result;
}

class FakeWebSocket extends EventTarget {
	static instances: FakeWebSocket[] = [];
	static responseCount = 0;

	readonly url: string;
	readonly options: { headers?: Record<string, string> };
	readonly sent: Array<Record<string, any>> = [];
	readyState = 0;

	constructor(url: string | URL, options: { headers?: Record<string, string> } = {}) {
		super();
		this.url = String(url);
		this.options = options;
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.dispatchEvent(new Event("open"));
		});
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, any>);
		const responseId = `resp_${++FakeWebSocket.responseCount}`;
		queueMicrotask(() => {
			const event = new Event("message") as Event & { data: string };
			Object.defineProperty(event, "data", { value: JSON.stringify(completedEvent(responseId)) });
			this.dispatchEvent(event);
		});
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		const event = new Event("close") as Event & { code: number; reason: string; wasClean: boolean };
		Object.defineProperties(event, {
			code: { value: code },
			reason: { value: reason },
			wasClean: { value: true },
		});
		this.dispatchEvent(event);
	}
}

afterEach(() => {
	cleanupSessionResources();
	vi.unstubAllGlobals();
	FakeWebSocket.instances = [];
	FakeWebSocket.responseCount = 0;
});

describe("CLIProxyAPI Codex authentication", () => {
	it("creates a deterministic non-secret JWT account identity", () => {
		const token = createSyntheticCodexJwt(REAL_API_KEY);
		const payload = decodeJwtPayload(token);
		const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;

		expect(token.split(".")).toHaveLength(3);
		expect(accountId).toBe(createSyntheticCodexAccountId(REAL_API_KEY));
		expect(accountId).toMatch(/^cpa_[0-9a-f]{64}$/);
		expect(token).not.toContain(REAL_API_KEY);
		expect(createSyntheticCodexJwt(REAL_API_KEY)).toBe(token);
		expect(createSyntheticCodexJwt("another-key")).not.toBe(token);
	});

	it("moves the real key to X-Api-Key without mutating caller options", () => {
		const original: SimpleStreamOptions = {
			apiKey: REAL_API_KEY,
			headers: { "X-Test": "kept", "x-api-key": "stale" },
			timeoutMs: 1234,
		};
		const adapted = withCliproxyCodexAuth(original);

		expect(adapted).not.toBe(original);
		expect(adapted?.apiKey).toBe(createSyntheticCodexJwt(REAL_API_KEY));
		expect(toHeaders(adapted?.headers).get("X-Api-Key")).toBe(REAL_API_KEY);
		expect(adapted?.headers?.["X-Test"]).toBe("kept");
		expect(adapted?.timeoutMs).toBe(1234);
		expect(original).toEqual({
			apiKey: REAL_API_KEY,
			headers: { "X-Test": "kept", "x-api-key": "stale" },
			timeoutMs: 1234,
		});
	});

	it("passes through requests that do not yet have resolved auth", () => {
		const options: SimpleStreamOptions = { timeoutMs: 1234 };
		expect(withCliproxyCodexAuth(options)).toBe(options);
		expect(withCliproxyCodexAuth()).toBeUndefined();
	});

	it("adapts auth at the stream boundary", () => {
		let captured: SimpleStreamOptions | undefined;
		const streamResult = {} as ReturnType<Parameters<typeof wrapStreamSimpleForCliproxyAuth>[0]>;
		const wrapped = wrapStreamSimpleForCliproxyAuth((_model, _context, options) => {
			captured = options;
			return streamResult;
		});

		expect(wrapped(createModel(), { messages: [] }, { apiKey: REAL_API_KEY })).toBe(streamResult);
		expect(captured?.apiKey).toBe(createSyntheticCodexJwt(REAL_API_KEY));
		expect(captured?.headers?.["X-Api-Key"]).toBe(REAL_API_KEY);
	});
});

describe("Pi stock Codex streams", () => {
	it.each([
		"stream",
		"streamSimple",
	] as const)("preserves parent identity through stock WebSocket %s without altering cache identity", async (method) => {
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const hierarchy = new SessionHierarchy();
		const streams = loadCliproxyCodexStreams({
			transport: "websocket",
			getSessionHeaders: (options) => hierarchy.headers(options),
		});
		const result = await streams[method](createModel(), normalizeContext({ messages: [userMessage("hello")] }), {
			apiKey: REAL_API_KEY,
			sessionId: "child-id",
			metadata: { parent_session_id: "parent-id" },
		}).result();
		expect(result.stopReason).toBe("stop");
		const headers = toHeaders(FakeWebSocket.instances[0]?.options.headers);
		expect(headers.get("session-id")).toBe("child-id");
		expect(headers.get("x-codex-parent-thread-id")).toBe("parent-id");
		expect(FakeWebSocket.instances[0]?.sent[0]?.prompt_cache_key).toBe("child-id");
	});

	it("sends SSE through the public stock API with split auth and Fast payload shaping", async () => {
		let requestUrl: string | undefined;
		let requestHeaders: IncomingHttpHeaders | undefined;
		let observedPayload: unknown;
		const reasoningItem = {
			type: "reasoning",
			id: "rs_sse",
			summary: [{ type: "summary_text", text: "checked" }],
			encrypted_content: "opaque-signature",
		};
		const server = createServer((request, response) => {
			requestUrl = request.url;
			requestHeaders = request.headers;
			request.resume();
			request.on("end", () => {
				response.writeHead(200, {
					"Content-Type": "text/event-stream",
					Connection: "close",
				});
				response.end(
					`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: reasoningItem })}\n\n` +
						`data: ${JSON.stringify(completedEvent("resp_sse", [reasoningItem]))}\n\n`,
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

		try {
			const address = server.address() as AddressInfo;
			const model = createModel(`http://127.0.0.1:${address.port}/backend-api/`);
			const streams = loadCliproxyCodexStreams({
				transport: "sse",
				shouldUseFast: () => true,
				getSessionHeaders: (options) => new SessionHierarchy().headers(options),
			});
			const result = await streams
				.streamSimple(
					model,
					{ messages: [userMessage("hello")] },
					{
						apiKey: REAL_API_KEY,
						sessionId: "sse-child",
						metadata: { parent_session_id: "sse-parent" },
						onPayload: (payload) => {
							observedPayload = payload;
						},
					},
				)
				.result();

			expect(result.stopReason).toBe("stop");
			expect(result.api).toBe("openai-codex-responses");
			expect(result.content[0]).toMatchObject({ type: "thinking", thinking: "checked" });
			expect(result.content[0]?.type === "thinking" ? result.content[0].thinkingSignature : undefined).toContain(
				"opaque-signature",
			);
			expect(requestUrl).toBe("/backend-api/codex/responses");
			expect(requestHeaders?.["session-id"]).toBe("sse-child");
			expect(requestHeaders?.["x-codex-parent-thread-id"]).toBe("sse-parent");
			expect(requestHeaders?.["x-api-key"]).toBe(REAL_API_KEY);
			const authorization = requestHeaders?.authorization;
			expect(authorization).toBe(`Bearer ${createSyntheticCodexJwt(REAL_API_KEY)}`);
			expect(requestHeaders?.["chatgpt-account-id"]).toBe(createSyntheticCodexAccountId(REAL_API_KEY));
			expect(observedPayload).toMatchObject({ service_tier: "priority" });
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("replays parallel tool calls from sessions using the legacy custom API id", async () => {
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const model = createModel();
		const streams = loadCliproxyCodexStreams({ transport: "websocket" });
		const legacyAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call_one|fc_one", name: "read", arguments: { path: "one.txt" } },
				{ type: "toolCall", id: "call_two|fc_two", name: "read", arguments: { path: "two.txt" } },
			],
			api: "cliproxyapi-codex-responses",
			provider: "cliproxyapi",
			model: model.id,
			usage: emptyUsage(),
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const toolResults: ToolResultMessage[] = [
			{
				role: "toolResult",
				toolCallId: "call_one|fc_one",
				toolName: "read",
				content: [{ type: "text", text: "one" }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_two|fc_two",
				toolName: "read",
				content: [{ type: "text", text: "two" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = await streams
			.streamSimple(
				model,
				{ messages: [userMessage("read both"), legacyAssistant, ...toolResults, userMessage("continue")] },
				{ apiKey: REAL_API_KEY },
			)
			.result();

		expect(result.stopReason).toBe("stop");
		const input = FakeWebSocket.instances[0]?.sent[0]?.input as Array<Record<string, any>>;
		const calls = input.filter((item) => item.type === "function_call");
		const outputs = input.filter((item) => item.type === "function_call_output");
		expect(calls).toHaveLength(2);
		expect(outputs).toHaveLength(2);
		expect(calls.map((item) => item.call_id)).toEqual(["call_one_fc_one", "call_two_fc_two"]);
		expect(outputs.map((item) => item.call_id)).toEqual(["call_one_fc_one", "call_two_fc_two"]);
	});

	it("reuses cached WebSockets per session and isolates them when the CPA key changes", async () => {
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const model = createModel();
		const sessionId = "cached-session";
		const streams = loadCliproxyCodexStreams({ transport: "websocket-cached" });

		const first = await streams
			.streamSimple(model, { messages: [userMessage("first")] }, { apiKey: REAL_API_KEY, sessionId })
			.result();
		const second = await streams
			.streamSimple(
				model,
				{ messages: [userMessage("first"), first, userMessage("second")] },
				{ apiKey: REAL_API_KEY, sessionId },
			)
			.result();

		expect(first.stopReason).toBe("stop");
		expect(second.stopReason).toBe("stop");
		expect(FakeWebSocket.instances).toHaveLength(1);
		const firstSocket = FakeWebSocket.instances[0];
		expect(firstSocket?.sent).toHaveLength(2);
		expect(firstSocket?.sent[1]).toMatchObject({
			type: "response.create",
			previous_response_id: "resp_1",
		});
		expect(firstSocket?.sent[1]?.input).toHaveLength(1);
		const firstHeaders = toHeaders(firstSocket?.options.headers);
		expect(firstHeaders.get("X-Api-Key")).toBe(REAL_API_KEY);
		expect(firstHeaders.get("Authorization")).toBe(`Bearer ${createSyntheticCodexJwt(REAL_API_KEY)}`);
		expect(firstHeaders.get("chatgpt-account-id")).toBe(createSyntheticCodexAccountId(REAL_API_KEY));

		await streams
			.streamSimple(model, { messages: [userMessage("new account")] }, { apiKey: "rotated-key", sessionId })
			.result();
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(toHeaders(FakeWebSocket.instances[1]?.options.headers).get("X-Api-Key")).toBe("rotated-key");

		cleanupSessionResources(sessionId);
		expect(FakeWebSocket.instances.every((socket) => socket.readyState === 3)).toBe(true);
	});
});
