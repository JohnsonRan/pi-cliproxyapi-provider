import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FastModeController } from "./fast.ts";
import { type PauseController, pauseController } from "./pause.ts";

export const STATUS_KEY = "cliproxyapi";
// Orange labels: truecolor #ffa500, xterm 214 (distinct from the yellow `fast`).
const ORANGE_TRUECOLOR = "\x1b[38;2;255;165;0m";
const ORANGE_256 = "\x1b[38;5;214m";
const FG_RESET = "\x1b[39m";

type Theme = ExtensionContext["ui"]["theme"];

function orange(theme: Theme, text: string): string {
	const ansi = theme.getColorMode?.() === "truecolor" ? ORANGE_TRUECOLOR : ORANGE_256;
	return `${ansi}${text}${FG_RESET}`;
}

/** Shows Fast / paused through Pi's public status line instead of patching the built-in footer. */
export class ProviderStatusController {
	private ctx: ExtensionContext | undefined;
	private unsubscribe: (() => void) | undefined;

	constructor(
		private readonly providerId: string,
		private readonly fastMode: FastModeController,
		private readonly pauseMode: PauseController = pauseController,
	) {}

	register(pi: ExtensionAPI): void {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			this.ctx = ctx;
			this.unsubscribe ??= this.pauseMode.onChange(() => this.refresh());
			this.refresh();
		});
		pi.on("model_select", (event, ctx) => this.refresh(ctx, event.model));
		pi.on("session_shutdown", () => {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			this.ctx = undefined;
		});
	}

	/** Labels apply only to CLIProxyAPI models: Fast and /pause do not affect other providers. */
	refresh(
		ctx: ExtensionContext | undefined = this.ctx,
		model: { provider: string; id: string } | undefined = ctx?.model,
	): void {
		if (ctx?.mode !== "tui") return;
		const labels: string[] = [];
		if (model?.provider === this.providerId) {
			if (this.fastMode.isEffectiveFor(model.id)) labels.push(ctx.ui.theme.fg("warning", "fast"));
			if (this.pauseMode.isEnabled()) labels.push(orange(ctx.ui.theme, "paused"));
		}
		ctx.ui.setStatus(STATUS_KEY, labels.length > 0 ? labels.join(" • ") : undefined);
	}
}
