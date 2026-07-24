import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { normalizeTransientNetworkError, registerTransientNetworkErrorRetry } from "../extensions/retry.ts";

const CLOSED_CONNECTION_ERROR =
	"Codex error: read tcp 172.16.209.2:57303->172.64.155.209:443: use of closed network connection";

function assistantError(errorMessage: string, provider = "cliproxyapi"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cliproxyapi-codex-responses",
		provider,
		model: "gpt-5.6-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("transient network error normalization", () => {
	it("makes CLIProxyAPI closed network connection errors retryable", () => {
		const original = assistantError(CLOSED_CONNECTION_ERROR);
		expect(isRetryableAssistantError(original)).toBe(false);

		const normalized = normalizeTransientNetworkError(original);
		expect(normalized).not.toBe(original);
		expect(normalized.errorMessage).toBe(`network error: ${CLOSED_CONNECTION_ERROR}`);
		expect(isRetryableAssistantError(normalized)).toBe(true);
	});

	it("leaves existing retryable and unrelated errors unchanged", () => {
		const retryable = assistantError("WebSocket closed 1006");
		const unrelated = assistantError("Codex error: invalid request");

		expect(normalizeTransientNetworkError(retryable)).toBe(retryable);
		expect(normalizeTransientNetworkError(unrelated)).toBe(unrelated);
	});

	it("only rewrites assistant errors from the registered provider", () => {
		let handler: ((event: any, ctx: ExtensionContext) => unknown) | undefined;
		const pi = {
			on: (event: string, candidate: (event: any, ctx: ExtensionContext) => unknown) => {
				if (event === "message_end") handler = candidate;
			},
		} as unknown as ExtensionAPI;
		registerTransientNetworkErrorRetry(pi, "cliproxyapi");
		if (!handler) throw new Error("message_end handler was not registered");

		const matching = assistantError(CLOSED_CONNECTION_ERROR);
		const replacement = handler({ type: "message_end", message: matching }, {} as ExtensionContext) as {
			message: AssistantMessage;
		};
		expect(replacement.message.errorMessage).toBe(`network error: ${CLOSED_CONNECTION_ERROR}`);

		const otherProvider = assistantError(CLOSED_CONNECTION_ERROR, "other");
		expect(handler({ type: "message_end", message: otherProvider }, {} as ExtensionContext)).toBeUndefined();
	});
});
