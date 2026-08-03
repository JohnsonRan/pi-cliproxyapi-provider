/** Shared pause state for request gating and elapsed-time accounting. */

import { resolvePauseDefault } from "./lib.ts";

export const PAUSE_POLL_INTERVAL_MS = 200;

export class PauseController {
	private enabled = false;
	private pauseStartedAtMs: number | undefined;
	private pausedDurationMs = 0;

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

export const pauseController = new PauseController();

export function readPauseSetting(agentDir: string, fallback = false): boolean {
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
): Promise<void> {
	while (true) {
		const enabled = readPauseSetting(agentDir, controller.isEnabled());
		controller.setEnabled(enabled);
		if (!enabled) return;
		await new Promise<void>((resolve) => setTimeout(resolve, PAUSE_POLL_INTERVAL_MS));
	}
}
