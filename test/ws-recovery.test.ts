import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cleanupSessionResources, type Model } from "@earendil-works/pi-ai";
import {
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIPROXYAPI_CODEX_API, loadCliproxyCodexStreams } from "../extensions/codex-stream.ts";
import { type CodexWebSocketStateAccess, WebSocketRecovery } from "../extensions/ws-recovery.ts";

afterEach(() => {
	cleanupSessionResources();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
});

describe("WebSocketRecovery", () => {
	it("retries at once after the first failure, then waits out the cooldown", async () => {
		let stats: { websocketFailures: number; websocketFallbackActive?: boolean } | undefined;
		const access: CodexWebSocketStateAccess = {
			get: async () => stats,
			reset: vi.fn(async () => {
				stats = undefined;
			}),
		};
		let now = 0;
		const recovery = new WebSocketRecovery(access, 1000, () => now);

		stats = { websocketFailures: 1, websocketFallbackActive: true };
		await recovery.beforeRequest("s");
		expect(access.reset).toHaveBeenCalledTimes(1);

		// The fresh socket failed too: stay on SSE until the cooldown ends.
		stats = { websocketFailures: 1, websocketFallbackActive: true };
		await recovery.beforeRequest("s");
		now = 999;
		await recovery.beforeRequest("s");
		expect(access.reset).toHaveBeenCalledTimes(1);
		now = 1000;
		await recovery.beforeRequest("s");
		expect(access.reset).toHaveBeenCalledTimes(2);

		// A WebSocket success clears the streak, so the next failure retries at once again.
		stats = { websocketFailures: 0, websocketFallbackActive: false };
		await recovery.beforeRequest("s");
		stats = { websocketFailures: 1, websocketFallbackActive: true };
		await recovery.beforeRequest("s");
		expect(access.reset).toHaveBeenCalledTimes(3);
	});
});

describe("WebSocket recovery with Pi's stock Codex stream", () => {
	it("returns a session to WebSocket after Pi fell back to SSE", async () => {
		const completed = { type: "response.completed", response: { id: "r", status: "completed", output: [] } };
		let sseRequests = 0;
		const server = createServer((request, response) => {
			sseRequests++;
			request.resume();
			request.on("end", () => {
				response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
				response.end(`data: ${JSON.stringify(completed)}\n\n`);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

		let failSends = true;
		let websocketRequests = 0;
		class FakeWebSocket extends EventTarget {
			readyState = 0;
			constructor() {
				super();
				queueMicrotask(() => {
					this.readyState = 1;
					this.dispatchEvent(new Event("open"));
				});
			}
			send(): void {
				websocketRequests++;
				const fail = failSends;
				queueMicrotask(() => {
					if (fail) {
						this.dispatchEvent(new Event("error"));
						return;
					}
					const event = new Event("message") as Event & { data: string };
					Object.defineProperty(event, "data", { value: JSON.stringify(completed) });
					this.dispatchEvent(event);
				});
			}
			close(): void {
				this.readyState = 3;
			}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);

		try {
			const model = {
				id: "gpt-5.6-sol",
				name: "gpt-5.6-sol",
				api: CLIPROXYAPI_CODEX_API,
				provider: "cliproxyapi",
				baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api/`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			} as Model<typeof CLIPROXYAPI_CODEX_API>;
			const streams = loadCliproxyCodexStreams({
				webSocketRecovery: new WebSocketRecovery({
					get: async (id) => getOpenAICodexWebSocketDebugStats(id),
					reset: async (id) => resetOpenAICodexWebSocketDebugStats(id),
				}),
			});
			const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
			const run = () => streams.streamSimple(model, context, { apiKey: "key", sessionId: "ws-session" }).result();

			expect((await run()).stopReason).toBe("stop");
			expect([websocketRequests, sseRequests]).toEqual([1, 1]);

			failSends = false;
			expect((await run()).stopReason).toBe("stop");
			expect([websocketRequests, sseRequests]).toEqual([2, 1]);
		} finally {
			server.close();
		}
	});
});
