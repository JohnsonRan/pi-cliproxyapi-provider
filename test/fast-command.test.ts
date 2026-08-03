import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FastModeController } from "../extensions/fast.ts";
import { registerFastCommand } from "../extensions/index.ts";
import { loadConfigFile, resolveFastDefault, saveConfigFile } from "../extensions/lib.ts";

function createCommandHarness(
	fastMode: FastModeController,
	currentModel: Model<Api>,
	agentDir: string,
	onModeChange?: (enabled: boolean, ctx: ExtensionContext) => Promise<void>,
) {
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const onStatusChange = vi.fn();
	const notify = vi.fn();
	const pi = {
		registerCommand: vi.fn((_name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			command = options;
		}),
	} as unknown as ExtensionAPI;

	registerFastCommand({ pi, agentDir, providerId: "cliproxyapi", fastMode, onStatusChange, onModeChange });

	const ctx = {
		model: currentModel,
		ui: { notify },
	} as unknown as ExtensionCommandContext;

	return {
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

const tempPaths: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-fast-command-test-"));
	tempPaths.push(dir);
	return dir;
}

afterEach(() => {
	while (tempPaths.length > 0) {
		const path = tempPaths.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

describe("/fast command", () => {
	it("toggles Fast and persists the preference in the global config", async () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { baseUrl: "http://localhost:8317" });
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir);

		await harness.command().handler("", harness.ctx);
		expect(fastMode.isEnabled()).toBe(true);
		expect(loadConfigFile(agentDir)).toEqual({ baseUrl: "http://localhost:8317", fast: true });
		expect(harness.onStatusChange).toHaveBeenCalledTimes(1);
		expect(harness.notify).not.toHaveBeenCalled();

		await harness.command().handler("", harness.ctx);
		expect(fastMode.isEnabled()).toBe(false);
		expect(loadConfigFile(agentDir)).toEqual({ baseUrl: "http://localhost:8317", fast: false });
		expect(harness.onStatusChange).toHaveBeenCalledTimes(2);
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("restores persisted Fast only for supported models after restart", async () => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir);

		await harness.command().handler("", harness.ctx);

		const previousFastEnv = process.env.CLIPROXYAPI_FAST;
		try {
			delete process.env.CLIPROXYAPI_FAST;
			const restartedMode = new FastModeController(resolveFastDefault(agentDir));
			restartedMode.setSupportedModelIds([supportedModel.id]);
			expect(restartedMode.isEffectiveFor(supportedModel.id)).toBe(true);
			expect(restartedMode.isEffectiveFor("unsupported-model")).toBe(false);
		} finally {
			if (previousFastEnv === undefined) {
				delete process.env.CLIPROXYAPI_FAST;
			} else {
				process.env.CLIPROXYAPI_FAST = previousFastEnv;
			}
		}
	});

	it("rejects arguments instead of using the old on, off, or status actions", async () => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir);

		await harness.command().handler("on", harness.ctx);

		expect(fastMode.isEnabled()).toBe(false);
		expect(loadConfigFile(agentDir)).toEqual({});
		expect(harness.notify).toHaveBeenCalledWith("Usage: /fast", "error");
	});

	it("updates the global preference while keeping Fast ineffective for an unsupported model", async () => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir);

		await harness.command().handler("", harness.ctx);

		expect(fastMode.isEnabled()).toBe(true);
		expect(fastMode.isEffectiveFor(supportedModel.id)).toBe(false);
		expect(loadConfigFile(agentDir)).toEqual({ fast: true });
		expect(harness.onStatusChange).toHaveBeenCalledTimes(1);
		expect(harness.notify).toHaveBeenLastCalledWith(
			"Fast mode is enabled globally, but the current model does not support it.",
			"warning",
		);

		await harness.command().handler("", harness.ctx);

		expect(fastMode.isEnabled()).toBe(false);
		expect(loadConfigFile(agentDir)).toEqual({ fast: false });
		expect(harness.onStatusChange).toHaveBeenCalledTimes(2);
		expect(harness.notify).toHaveBeenLastCalledWith("Fast mode is disabled globally.", "info");
	});

	it("rejects an overlapping toggle while pricing refresh is in progress", async () => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		let finishRefresh: (() => void) | undefined;
		const onModeChange = vi.fn(
			async () =>
				await new Promise<void>((resolve) => {
					finishRefresh = resolve;
				}),
		);
		const harness = createCommandHarness(fastMode, supportedModel, agentDir, onModeChange);

		const firstToggle = harness.command().handler("", harness.ctx);
		await vi.waitFor(() => expect(onModeChange).toHaveBeenCalledTimes(1));
		await harness.command().handler("", harness.ctx);

		expect(fastMode.isEnabled()).toBe(true);
		expect(loadConfigFile(agentDir)).toEqual({ fast: true });
		expect(onModeChange).toHaveBeenCalledTimes(1);
		expect(harness.notify).toHaveBeenCalledWith(
			"Fast mode is already being refreshed. Try again when it finishes.",
			"warning",
		);

		finishRefresh?.();
		await firstToggle;
	});

	it("restores state, config, and pricing metadata when refresh fails", async () => {
		const agentDir = tempAgentDir();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const onModeChange = vi.fn(async (enabled: boolean) => {
			if (enabled) throw new Error("refresh failed");
		});
		const harness = createCommandHarness(fastMode, supportedModel, agentDir, onModeChange);

		await harness.command().handler("", harness.ctx);

		expect(fastMode.isEnabled()).toBe(false);
		expect(loadConfigFile(agentDir)).toEqual({ fast: false });
		expect(onModeChange.mock.calls.map(([enabled]) => enabled)).toEqual([true, false]);
		expect(harness.notify).toHaveBeenCalledWith("Failed to refresh model pricing: refresh failed", "warning");
	});

	it("does not change in-memory state when the global config cannot be written", async () => {
		const agentDir = tempAgentDir();
		const invalidAgentDir = join(agentDir, "not-a-directory");
		writeFileSync(invalidAgentDir, "file", "utf8");
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supportedModel.id]);
		const harness = createCommandHarness(fastMode, supportedModel, invalidAgentDir);

		await harness.command().handler("", harness.ctx);

		expect(fastMode.isEnabled()).toBe(false);
		expect(harness.onStatusChange).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to save Fast mode:"), "error");
	});
});
