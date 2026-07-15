/** Global Fast preference plus the capability set advertised by CPA. */
export class FastModeController {
	private supportedModelIds = new Set<string>();

	constructor(private enabled: boolean) {}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	setSupportedModelIds(modelIds: Iterable<string>): void {
		this.supportedModelIds = new Set(
			Array.from(modelIds, (modelId) => modelId.trim()).filter((modelId) => modelId.length > 0),
		);
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	isModelSupported(modelId: string): boolean {
		return this.supportedModelIds.has(modelId.trim());
	}

	isEffectiveFor(modelId: string): boolean {
		return this.enabled && this.isModelSupported(modelId);
	}
}
