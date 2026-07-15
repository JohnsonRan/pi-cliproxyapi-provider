import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { FAST_MODE_ENTRY_TYPE, FastModeController } from "../extensions/fast.ts";
import { registerFastCommand } from "../extensions/index.ts";

function createCommandHarness(fastMode: FastModeController, currentModel: Model<Api>) {
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const appendEntry = vi.fn();
	const onStatusChange = vi.fn();
	const notify = vi.fn();
	const pi = {
		on: vi.fn(),
		registerCommand: vi.fn((_name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			command = options;
		}),
		appendEntry,
	} as unknown as ExtensionAPI;

	registerFastCommand({ pi, providerId: "cliproxyapi", fastMode, onStatusChange });

	const ctx = {
		model: currentModel,
		ui: { notify },
	} as unknown as ExtensionCommandContext;

	return {
		appendEntry,
		command: () => {
			if (!command) throw new Error("Fast command was not registered");
			return command;
		},
		ctx,
		notify,
		onStatusChange,
	};
}

const supportedModel = {
	id: "gpt-5.6-sol",
	provider: "cliproxyapi",
} as Model<Api>;

describe("/fast command", () => {
	it("toggles Fast without arguments and relies on the footer for supported-model status", async () => {
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel);

		await harness.command().handler("", harness.ctx);
		expect(fastMode.isEnabled()).toBe(true);
		expect(harness.appendEntry).toHaveBeenLastCalledWith(FAST_MODE_ENTRY_TYPE, { enabled: true });
		expect(harness.onStatusChange).toHaveBeenCalledTimes(1);
		expect(harness.notify).not.toHaveBeenCalled();

		await harness.command().handler("", harness.ctx);
		expect(fastMode.isEnabled()).toBe(false);
		expect(harness.appendEntry).toHaveBeenLastCalledWith(FAST_MODE_ENTRY_TYPE, { enabled: false });
		expect(harness.onStatusChange).toHaveBeenCalledTimes(2);
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("rejects arguments instead of using the old on, off, or status actions", async () => {
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel);

		await harness.command().handler("on", harness.ctx);

		expect(fastMode.isEnabled()).toBe(false);
		expect(harness.appendEntry).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("Usage: /fast", "error");
	});

	it("warns without changing state when the selected model does not support Fast", async () => {
		const fastMode = new FastModeController(false);
		const harness = createCommandHarness(fastMode, supportedModel);

		await harness.command().handler("", harness.ctx);

		expect(fastMode.isEnabled()).toBe(false);
		expect(harness.appendEntry).not.toHaveBeenCalled();
		expect(harness.onStatusChange).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("This model does not support Fast mode.", "warning");
	});
});
