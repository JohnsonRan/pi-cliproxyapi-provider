import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
}

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

/** Pi owns compaction triggers; this controller only maintains settings and resources. */
export class CompactionController {
	private settingsManager: SettingsManager | undefined;

	constructor(
		private readonly agentDir: string,
		private readonly providerId: string,
		private readonly cleanupResources: SessionResourceCleanup = cleanupSessionResources,
	) {}

	register(pi: ExtensionAPI): void {
		pi.on("session_start", (_event, ctx) => {
			this.settingsManager = SettingsManager.create(ctx.cwd, this.agentDir, {
				projectTrusted: ctx.isProjectTrusted(),
			});
		});

		pi.on("session_shutdown", () => {
			this.settingsManager = undefined;
			this.resetSessionResources();
		});

		pi.on("session_compact", (_event, ctx) => {
			// CLIProxyAPI binds server-side Codex context to the WebSocket. Compaction
			// only rewrites the client message list, so reuse would keep cacheRead high
			// and retrigger compaction on a now-small session.
			this.resetSessionResources(resolveCompactionSessionId(ctx));
		});

		pi.on("turn_end", async (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant" || message.provider !== this.providerId) {
				return;
			}
			if (!ctx.model || ctx.model.provider !== this.providerId || ctx.model.id !== message.model) {
				return;
			}

			// Refresh the footer's budget without intercepting the next request:
			// Pi may already be sending a compaction summary on the same model.
			await this.settingsManager?.reload();
		});
	}

	getCompactionSettings(): CompactionSettings | undefined {
		return this.settingsManager?.getCompactionSettings();
	}

	private resetSessionResources(sessionId?: string): void {
		try {
			this.cleanupResources(sessionId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const scope = sessionId ? `session ${sessionId}` : "all sessions";
			console.warn(`[pi-cliproxyapi-provider] failed to clean Pi resources for ${scope}: ${message}`);
		}
	}
}
