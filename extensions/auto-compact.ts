import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SessionResourceCleanup = (sessionId?: string) => void;

/** Session id used to key pi-ai's reused Codex WebSocket. */
export function resolveCompactionSessionId(source?: {
	sessionId?: unknown;
	sessionManager?: { getSessionId?: () => unknown };
}): string | undefined {
	const fromManager = source?.sessionManager?.getSessionId?.();
	if (typeof fromManager === "string" && fromManager.trim()) {
		return fromManager;
	}
	if (typeof source?.sessionId === "string" && source.sessionId.trim()) {
		return source.sessionId;
	}
	return undefined;
}

/** Pi owns compaction triggers; this controller only resets the compacted session's WebSocket. */
export class CompactionController {
	constructor(private readonly cleanupResources: SessionResourceCleanup = cleanupSessionResources) {}

	register(pi: ExtensionAPI): void {
		// Pi's AgentSession.dispose() already cleans the disposed session's resources on shutdown.
		pi.on("session_compact", (_event, ctx) => {
			// CLIProxyAPI binds server-side Codex context to the WebSocket. Compaction
			// only rewrites the client message list, so reuse would keep cacheRead high
			// and retrigger compaction on a now-small session.
			const sessionId = resolveCompactionSessionId(ctx);
			// Pi only caches WebSockets under a session id; without one there is nothing to reset.
			if (sessionId) this.resetSessionResources(sessionId);
		});
	}

	private resetSessionResources(sessionId: string): void {
		try {
			this.cleanupResources(sessionId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[pi-cliproxyapi-provider] failed to clean Pi resources for session ${sessionId}: ${message}`);
		}
	}
}
