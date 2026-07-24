import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLOSED_NETWORK_CONNECTION_PATTERN = /\bclosed network connection\b/i;
const NETWORK_ERROR_PREFIX = "network error:";

export function normalizeTransientNetworkError(message: AssistantMessage): AssistantMessage {
	if (message.stopReason !== "error" || !message.errorMessage) {
		return message;
	}
	if (isRetryableAssistantError(message) || !CLOSED_NETWORK_CONNECTION_PATTERN.test(message.errorMessage)) {
		return message;
	}

	return {
		...message,
		errorMessage: `${NETWORK_ERROR_PREFIX} ${message.errorMessage}`,
	};
}

export function registerTransientNetworkErrorRetry(pi: ExtensionAPI, providerId: string): void {
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== providerId) {
			return;
		}

		const normalized = normalizeTransientNetworkError(message);
		if (normalized === message) {
			return;
		}
		return { message: normalized };
	});
}
