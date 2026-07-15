import { type ExtensionAPI, type ExtensionContext, FooterComponent } from "@earendil-works/pi-coding-agent";
import type { FastModeController } from "./fast.ts";

const FAST_FOOTER_PATCH = Symbol.for("@router-for-me/pi-cliproxyapi-provider/fast-footer-patch");
const FAST_REFRESH_STATUS_KEY = "cliproxyapi-fast-refresh";

interface MutableModel {
	id: string;
	provider: string;
	reasoning: boolean;
}

interface FooterSessionLike {
	state: {
		model?: MutableModel;
		thinkingLevel?: string;
	};
}

interface FooterComponentLike {
	session?: FooterSessionLike;
}

interface FooterPatchState {
	controllers: Set<FastFooterController>;
	originalRender: FooterComponent["render"];
	patchedRender: FooterComponent["render"];
}

type PatchableFooterPrototype = FooterComponent & {
	[FAST_FOOTER_PATCH]?: FooterPatchState;
};

export function formatFastModelStatus(
	modelName: string,
	supportsReasoning: boolean,
	thinkingLevel: string,
	fastEnabled: boolean,
	fastLabel = "fast",
): string {
	let status = modelName;
	if (supportsReasoning) {
		status += thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`;
	}
	if (fastEnabled) {
		status += ` • ${fastLabel}`;
	}
	return status;
}

function installFooterPatch(controller: FastFooterController): void {
	const prototype = FooterComponent.prototype as PatchableFooterPrototype;
	let patchState = prototype[FAST_FOOTER_PATCH];
	if (!patchState) {
		const originalRender = prototype.render;
		patchState = {
			controllers: new Set(),
			originalRender,
			patchedRender(this: FooterComponent, width: number): string[] {
				const session = (this as unknown as FooterComponentLike).session;
				const model = session?.state.model;
				let activeController: FastFooterController | undefined;
				if (model) {
					for (const candidate of patchState?.controllers ?? []) {
						if (candidate.isEffectiveFor(model)) {
							activeController = candidate;
							break;
						}
					}
				}
				if (!model || !activeController) {
					return originalRender.call(this, width);
				}

				const originalId = model.id;
				const originalReasoning = model.reasoning;
				model.id = activeController.formatModelStatus(
					originalId,
					originalReasoning,
					session?.state.thinkingLevel ?? "off",
				);
				model.reasoning = false;
				try {
					return originalRender.call(this, width);
				} finally {
					model.id = originalId;
					model.reasoning = originalReasoning;
				}
			},
		};
		prototype[FAST_FOOTER_PATCH] = patchState;
		prototype.render = patchState.patchedRender;
	}
	patchState.controllers.add(controller);
}

function removeFooterPatch(controller: FastFooterController): void {
	const prototype = FooterComponent.prototype as PatchableFooterPrototype;
	const patchState = prototype[FAST_FOOTER_PATCH];
	if (!patchState) return;

	patchState.controllers.delete(controller);
	if (patchState.controllers.size > 0) return;
	if (prototype.render === patchState.patchedRender) {
		prototype.render = patchState.originalRender;
	}
	delete prototype[FAST_FOOTER_PATCH];
}

/** Adds Fast to pi's built-in model status without replacing the footer. */
export class FastFooterController {
	private activeContext: ExtensionContext | undefined;
	private patchInstalled = false;

	constructor(
		private readonly providerId: string,
		private readonly fastMode: FastModeController,
	) {}

	register(pi: ExtensionAPI): void {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			this.activeContext = ctx;
			if (this.patchInstalled) return;
			installFooterPatch(this);
			this.patchInstalled = true;
		});
		pi.on("session_shutdown", () => {
			this.activeContext = undefined;
			if (!this.patchInstalled) return;
			removeFooterPatch(this);
			this.patchInstalled = false;
		});
	}

	formatModelStatus(modelName: string, supportsReasoning: boolean, thinkingLevel: string): string {
		const fastLabel = this.activeContext?.ui.theme.fg("warning", "fast") ?? "fast";
		return formatFastModelStatus(modelName, supportsReasoning, thinkingLevel, true, fastLabel);
	}

	isEffectiveFor(model: MutableModel): boolean {
		return model.provider === this.providerId && this.fastMode.isEffectiveFor(model.id);
	}

	refresh(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(FAST_REFRESH_STATUS_KEY, undefined);
	}
}
