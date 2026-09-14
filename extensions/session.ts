/** Link real Pi session ancestry without reusing a root permission-routing ID. */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { ProviderHeaders, StreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function sessionId(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.trim())
		? value.trim()
		: undefined;
}

export function readParentSessionId(path: string): string | undefined {
	let fd: number | undefined;
	try {
		if (!statSync(path).isFile()) return undefined;
		fd = openSync(path, "r");
		// Only the header is needed, never load a parent's conversation into memory.
		const buffer = Buffer.alloc(8192);
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		const header = JSON.parse(buffer.toString("utf8", 0, bytes).split("\n", 1)[0]);
		return header?.type === "session" ? sessionId(header.id) : undefined;
	} catch {
		// Deleted, moved, oversized, or malformed parent headers do not block inference.
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

const PARENT_ENTRY = "cliproxyapi-parent-session";
interface ParentLink {
	sessionId: string;
	parentId: string;
}

export class SessionHierarchy {
	private currentId: string | undefined;
	private parentId: string | undefined;

	register(pi: ExtensionAPI): void {
		pi.on("session_start", (event, ctx) => {
			this.currentId = sessionId(ctx.sessionManager.getSessionId());
			const parentFile = ctx.sessionManager.getHeader()?.parentSession;
			this.parentId = parentFile ? readParentSessionId(parentFile) : undefined;
			if (!this.parentId) {
				const saved = ctx.sessionManager
					.getEntries()
					.slice()
					.reverse()
					.find(
						(entry) =>
							entry.type === "custom" &&
							entry.customType === PARENT_ENTRY &&
							(entry.data as Partial<ParentLink> | undefined)?.sessionId === this.currentId,
					);
				this.parentId =
					saved?.type === "custom" ? sessionId((saved.data as Partial<ParentLink>)?.parentId) : undefined;
			}
			// Bind launcher metadata once to this exact session. Never reinterpret it after /new or /resume.
			if (!this.parentId && this.currentId && event.reason === "startup") {
				this.parentId = sessionId(process.env.CLIPROXYAPI_PARENT_SESSION_ID);
				if (this.parentId && this.parentId !== this.currentId) {
					pi.appendEntry(PARENT_ENTRY, {
						sessionId: this.currentId,
						parentId: this.parentId,
					} satisfies ParentLink);
				}
			}
		});
		pi.on("session_shutdown", () => {
			this.currentId = undefined;
			this.parentId = undefined;
		});
	}

	headers(options?: StreamOptions): ProviderHeaders {
		// One-off native summaries must keep their independent routing/cache identity.
		if (options?.cacheRetention === "none") return {};
		const id = sessionId(options?.sessionId);
		const parent =
			sessionId(options?.metadata?.parent_session_id) ?? (id && id === this.currentId ? this.parentId : undefined);
		return id && parent && parent !== id ? { "X-Codex-Parent-Thread-Id": parent } : {};
	}

	searchHeaders(ctx: ExtensionContext): ProviderHeaders {
		const id = sessionId(ctx.sessionManager.getSessionId());
		return id ? { "Session-Id": id, ...this.headers({ sessionId: id }) } : {};
	}
}

/** Caller-supplied headers (including null deletions) retain final control, case-insensitively. */
export function mergeSessionHeaders(defaults: ProviderHeaders, headers?: ProviderHeaders): ProviderHeaders {
	const result = { ...defaults };
	for (const [name, value] of Object.entries(headers ?? {})) {
		for (const existing of Object.keys(result)) {
			if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
		}
		result[name] = value;
	}
	return result;
}
