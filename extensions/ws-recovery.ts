/**
 * Recover Codex WebSocket after a transport failure.
 *
 * Pi's stock Codex stream switches a session to SSE for good after one WebSocket failure.
 * Hosts that expose the lazy Codex WebSocket state accessors let us lift that: the first
 * failure gets an immediate retry on a fresh socket (the failed one was discarded, so this
 * covers a silently dead cached socket), and further consecutive failures wait out a
 * cooldown on SSE. Hosts without the accessors keep Pi's default behavior.
 */

import * as piAi from "@earendil-works/pi-ai";

export const WEBSOCKET_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

interface CodexWebSocketStats {
	websocketFailures: number;
	websocketFallbackActive?: boolean;
}

export interface CodexWebSocketStateAccess {
	get(sessionId: string): Promise<CodexWebSocketStats | undefined>;
	reset(sessionId: string): Promise<void>;
}

/** The accessors exist only on Pi builds that export them; feature-detect instead of importing by name. */
export function hostCodexWebSocketStateAccess(): CodexWebSocketStateAccess | undefined {
	const host = piAi as unknown as {
		getOpenAICodexWebSocketDebugStatsLazy?: CodexWebSocketStateAccess["get"];
		resetOpenAICodexWebSocketDebugStatsLazy?: CodexWebSocketStateAccess["reset"];
	};
	const get = host.getOpenAICodexWebSocketDebugStatsLazy;
	const reset = host.resetOpenAICodexWebSocketDebugStatsLazy;
	return typeof get === "function" && typeof reset === "function" ? { get, reset } : undefined;
}

interface SessionRecovery {
	/** Failures already counted from Pi's stats since the last reset. */
	seen: number;
	/** Consecutive failures without a successful WebSocket request in between. */
	streak: number;
	retryAt: number;
}

export class WebSocketRecovery {
	private readonly sessions = new Map<string, SessionRecovery>();

	constructor(
		private readonly access: CodexWebSocketStateAccess,
		private readonly cooldownMs = WEBSOCKET_RETRY_COOLDOWN_MS,
		private readonly now = Date.now,
	) {}

	/** Call before each request: lifts the session's SSE fallback once its retry time has come. */
	async beforeRequest(sessionId: string): Promise<void> {
		const stats = await this.access.get(sessionId);
		if (!stats?.websocketFallbackActive) {
			// Either no WebSocket state yet, or the last request used WebSocket successfully.
			if (stats) this.sessions.delete(sessionId);
			return;
		}
		const state = this.sessions.get(sessionId) ?? { seen: 0, streak: 0, retryAt: 0 };
		if (stats.websocketFailures > state.seen) {
			state.streak += stats.websocketFailures - state.seen;
			state.seen = stats.websocketFailures;
			state.retryAt = this.now() + (state.streak === 1 ? 0 : this.cooldownMs);
		}
		this.sessions.set(sessionId, state);
		if (this.now() < state.retryAt) return;
		await this.access.reset(sessionId);
		// The reset cleared Pi's failure count; the streak survives until a WebSocket success.
		state.seen = 0;
	}
}
