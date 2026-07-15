export type FastModeSource = "configured-default" | "session-override";

export const FAST_MODE_ENTRY_TYPE = "cliproxyapi-fast-mode";

export interface FastModeSessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Session-scoped Fast preference plus the capability set advertised by CPA. */
export class FastModeController {
	private sessionOverride: boolean | undefined;
	private supportedModelIds = new Set<string>();

	constructor(private readonly defaultEnabled: boolean) {}

	setSessionEnabled(enabled: boolean): void {
		this.sessionOverride = enabled;
	}

	toggleSessionEnabled(): boolean {
		const enabled = !this.isEnabled();
		this.setSessionEnabled(enabled);
		return enabled;
	}

	clearSessionOverride(): void {
		this.sessionOverride = undefined;
	}

	setSupportedModelIds(modelIds: Iterable<string>): void {
		this.supportedModelIds = new Set(
			Array.from(modelIds, (modelId) => modelId.trim()).filter((modelId) => modelId.length > 0),
		);
	}

	isEnabled(): boolean {
		return this.sessionOverride ?? this.defaultEnabled;
	}

	getSource(): FastModeSource {
		return this.sessionOverride === undefined ? "configured-default" : "session-override";
	}

	isModelSupported(modelId: string): boolean {
		return this.supportedModelIds.has(modelId.trim());
	}

	isEffectiveFor(modelId: string): boolean {
		return this.isEnabled() && this.isModelSupported(modelId);
	}
}

export function restoreFastModeFromEntries(
	fastMode: FastModeController,
	entries: Iterable<FastModeSessionEntry>,
): void {
	fastMode.clearSessionOverride();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== FAST_MODE_ENTRY_TYPE) {
			continue;
		}
		const data = entry.data;
		if (data && typeof data === "object" && typeof (data as { enabled?: unknown }).enabled === "boolean") {
			fastMode.setSessionEnabled((data as { enabled: boolean }).enabled);
		}
	}
}
