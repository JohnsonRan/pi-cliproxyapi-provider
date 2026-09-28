/** Shared pause state for request gating and elapsed-time accounting. */

import { setTimeout as delay } from "node:timers/promises";
import { resolvePauseDefault } from "./lib.ts";

export const PAUSE_POLL_INTERVAL_MS = 200;

export class PauseController {
	private enabled = false;
	private pauseStartedAtMs: number | undefined;
	private pausedDurationMs = 0;
	private readonly listeners = new Set<() => void>();

	constructor(enabled = false) {
		this.setEnabled(enabled);
	}

	setEnabled(enabled: boolean, now = Date.now()): void {
		if (enabled === this.enabled) return;

		if (enabled) {
			this.pauseStartedAtMs = now;
		} else if (this.pauseStartedAtMs !== undefined) {
			this.pausedDurationMs += Math.max(0, now - this.pauseStartedAtMs);
			this.pauseStartedAtMs = undefined;
		}

		this.enabled = enabled;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Status display must never break request gating.
			}
		}
	}

	/** Subscribe to pause changes, including those picked up from another Pi process. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	getPausedDurationMs(now = Date.now()): number {
		if (this.pauseStartedAtMs === undefined) return this.pausedDurationMs;
		return this.pausedDurationMs + Math.max(0, now - this.pauseStartedAtMs);
	}

	getElapsedMs(startMs: number, pausedDurationAtStartMs: number, now = Date.now()): number {
		const pausedSinceStartMs = Math.max(0, this.getPausedDurationMs(now) - pausedDurationAtStartMs);
		return Math.max(0, now - startMs - pausedSinceStartMs);
	}
}

// Pi loads each package extension (index.ts, tps.ts) with its own module cache,
// so a plain module singleton would split pause state between them.
const SHARED_PAUSE_CONTROLLER = Symbol.for("@router-for-me/pi-cliproxyapi-provider/pause-controller");
const sharedScope = globalThis as Record<symbol, PauseController | undefined>;
sharedScope[SHARED_PAUSE_CONTROLLER] ??= new PauseController();
export const pauseController: PauseController = sharedScope[SHARED_PAUSE_CONTROLLER];

function readPauseSetting(agentDir: string, fallback = false): boolean {
	try {
		return resolvePauseDefault(agentDir);
	} catch {
		// Keep the current in-memory state when the setting cannot be read.
		return fallback;
	}
}

export async function waitForPauseToEnd(
	agentDir: string,
	controller: PauseController = pauseController,
	signal?: AbortSignal,
): Promise<void> {
	while (true) {
		signal?.throwIfAborted();
		const enabled = readPauseSetting(agentDir, controller.isEnabled());
		controller.setEnabled(enabled);
		if (!enabled) return;
		await delay(PAUSE_POLL_INTERVAL_MS, undefined, { signal });
	}
}
