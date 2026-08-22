import { type ExtensionAPI, type ExtensionContext, FooterComponent } from "@earendil-works/pi-coding-agent";
import type { ProactiveCompactionSettings } from "./auto-compact.ts";
import type { FastModeController } from "./fast.ts";
import { type PauseController, pauseController } from "./pause.ts";

const FAST_FOOTER_PATCH = Symbol.for("@router-for-me/pi-cliproxyapi-provider/fast-footer-patch");
const FAST_REFRESH_STATUS_KEY = "cliproxyapi-fast-refresh";
// Orange labels: truecolor #ffa500, xterm 214
const ORANGE_TRUECOLOR = "\x1b[38;2;255;165;0m";
const ORANGE_256 = "\x1b[38;5;214m";
const FG_RESET = "\x1b[39m";

interface MutableModel {
	id: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
}

interface FooterSessionLike {
	state: {
		model?: MutableModel;
		thinkingLevel?: string;
	};
}

interface FooterComponentLike {
	session?: FooterSessionLike;
	autoCompactEnabled?: boolean;
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
	paused = false,
	pausedLabel = "paused",
): string {
	let status = modelName;
	if (supportsReasoning) {
		status += thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`;
	}
	if (fastEnabled) {
		status += ` • ${fastLabel}`;
	}
	if (paused) {
		status += ` • ${pausedLabel}`;
	}
	return status;
}

/** Colorize status labels in orange (distinct from yellow warning/fast). */
function formatOrangeLabel(theme: { getColorMode?: () => string } | undefined, text: string): string {
	if (!theme) return text;
	const ansi = theme.getColorMode?.() === "truecolor" ? ORANGE_TRUECOLOR : ORANGE_256;
	return `${ansi}${text}${FG_RESET}`;
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
				const footer = this as unknown as FooterComponentLike;
				const session = footer.session;
				const model = session?.state.model;
				let activeController: FastFooterController | undefined;
				if (model) {
					for (const candidate of patchState?.controllers ?? []) {
						if (candidate.isProviderModel(model)) {
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
				const originalContextWindow = model.contextWindow;
				const fastEnabled = activeController.isEffectiveFor(model);
				if (fastEnabled || activeController.isPaused()) {
					model.id = activeController.formatModelStatus(
						originalId,
						originalReasoning,
						session?.state.thinkingLevel ?? "off",
						fastEnabled,
					);
					model.reasoning = false;
				}
				model.contextWindow = activeController.getDisplayContextWindow(
					originalContextWindow,
					footer.autoCompactEnabled ?? false,
				);
				try {
					return originalRender.call(this, width);
				} finally {
					model.id = originalId;
					model.reasoning = originalReasoning;
					model.contextWindow = originalContextWindow;
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
		private readonly resolveCompactionSettings: () => ProactiveCompactionSettings | undefined = () => undefined,
		private readonly pauseMode: PauseController = pauseController,
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

	formatModelStatus(modelName: string, supportsReasoning: boolean, thinkingLevel: string, fastEnabled = true): string {
		const theme = this.activeContext?.ui.theme;
		const fastLabel = theme?.fg("warning", "fast") ?? "fast";
		const pausedLabel = formatOrangeLabel(theme, "paused");
		return formatFastModelStatus(
			modelName,
			supportsReasoning,
			thinkingLevel,
			fastEnabled,
			fastLabel,
			this.pauseMode.isEnabled(),
			pausedLabel,
		);
	}

	isProviderModel(model: MutableModel): boolean {
		return model.provider === this.providerId;
	}

	isEffectiveFor(model: MutableModel): boolean {
		return this.isProviderModel(model) && this.fastMode.isEffectiveFor(model.id);
	}

	isPaused(): boolean {
		return this.pauseMode.isEnabled();
	}

	getDisplayContextWindow(contextWindow: number, autoCompactEnabled: boolean): number {
		const settings = this.resolveCompactionSettings();
		if (!autoCompactEnabled || !settings || !Number.isFinite(settings.reserveTokens) || settings.reserveTokens < 0) {
			return contextWindow;
		}
		const availableContextWindow = contextWindow - settings.reserveTokens;
		return availableContextWindow > 0 ? availableContextWindow : contextWindow;
	}

	refresh(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(FAST_REFRESH_STATUS_KEY, undefined);
	}
}
