import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import providerExtension from "../extensions/index.ts";
import { AUTH_FILE_NAME } from "../extensions/lib.ts";

let agentDir: string;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-images-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, AUTH_FILE_NAME),
		JSON.stringify({
			cliproxyapi: { type: "api_key", key: "cpa-key", env: { CLIPROXYAPI_BASE_URL: "http://cpa.test/proxy" } },
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

async function loadRuntime(): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, AUTH_FILE_NAME),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const pi = {
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn(),
		registerProvider: (provider: Provider) => runtime.registerNativeProvider(provider),
	} as unknown as ExtensionAPI;
	await providerExtension(pi);
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

describe("CLIProxyAPI image models", () => {
	it("generates and edits images through the configured CPA image models", async () => {
		writeFileSync(join(agentDir, "cliproxyapi.json"), JSON.stringify({ imageModels: ["gpt-image-2"] }));
		const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (!url.includes("/v1/images/")) return new Response("{}", { status: 503 });
			requests.push({
				url,
				auth: new Headers(init?.headers).get("Authorization"),
				body: JSON.parse(String(init?.body)),
			});
			return new Response(
				JSON.stringify({
					data: [{ b64_json: "aW1n" }],
					output_format: "webp",
					usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
				}),
				{ status: 200 },
			);
		});

		const runtime = await loadRuntime();
		const [model] = await runtime.getAvailableOfType("image", "cliproxyapi");
		expect(model?.id).toBe("gpt-image-2");

		const generated = await runtime.generateImages(model!, { input: [{ type: "text", text: "a fox" }] });
		expect(generated.errorMessage).toBeUndefined();
		expect(generated.output).toEqual([{ type: "image", data: "aW1n", mimeType: "image/webp" }]);
		expect(generated.usage).toMatchObject({ input: 5, output: 7, totalTokens: 12 });

		await runtime.generateImages(model!, {
			input: [
				{ type: "text", text: "make it blue" },
				{ type: "image", data: "c3Jj", mimeType: "image/png" },
			],
		});
		expect(requests).toEqual([
			{
				url: "http://cpa.test/proxy/v1/images/generations",
				auth: "Bearer cpa-key",
				body: { model: "gpt-image-2", prompt: "a fox", response_format: "b64_json" },
			},
			{
				url: "http://cpa.test/proxy/v1/images/edits",
				auth: "Bearer cpa-key",
				body: {
					model: "gpt-image-2",
					prompt: "make it blue",
					response_format: "b64_json",
					images: [{ image_url: "data:image/png;base64,c3Jj" }],
				},
			},
		]);
	});

	it("reports CPA errors and lists no image models unless configured", async () => {
		writeFileSync(join(agentDir, "cliproxyapi.json"), JSON.stringify({ imageModels: ["gpt-image-2"] }));
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"error":"nope"}', { status: 400 }));
		const runtime = await loadRuntime();
		const [model] = runtime.getModelsOfType("image", "cliproxyapi");
		const result = await runtime.generateImages(model!, { input: [{ type: "text", text: "x" }] });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("HTTP 400");

		writeFileSync(join(agentDir, "cliproxyapi.json"), JSON.stringify({}));
		expect((await loadRuntime()).getModelsOfType("image", "cliproxyapi")).toEqual([]);
	});
});
