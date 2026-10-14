import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type ModelsStore } from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifierBaseUrl,
	createClassify,
	DEFAULT_CLASSIFIER_CONTEXT_WINDOW,
	toClassifierModel,
} from "../extensions/classifiers.ts";
import providerExtension from "../extensions/index.ts";
import { AUTH_FILE_NAME, CONFIG_FILE_NAME } from "../extensions/lib.ts";

const ROOT = "http://127.0.0.1:8317";
const MODELS_URL = `${ROOT}/v1/models?client_version=cpa`;
const LIST_URL = `${ROOT}/v1/models`;
const SYSTEMONE_URL = `${ROOT}/v1/systemone`;
const INFERENCE_BASE = `${ROOT}/backend-api/`;

const ENV_NAMES = ["CLIPROXYAPI_API_KEY", "CLIPROXYAPI_BASE_URL", "CLIPROXYAPI_PROVIDER_ID"] as const;
const tempPaths: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (tempPaths.length > 0) {
		const path = tempPaths.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-classifier-test-"));
	tempPaths.push(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of ENV_NAMES) delete process.env[name];
	writeFileSync(join(agentDir, CONFIG_FILE_NAME), JSON.stringify({ baseUrl: ROOT, apiKey: "key" }), "utf8");
	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const [name, value] of previousEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

async function startPi(store: ModelsStore, agentDir: string) {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, AUTH_FILE_NAME),
		modelsPath: null,
		modelsStore: store,
		refreshOnCreate: false,
	});
	const pi = {
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn(),
		registerProvider: (provider: Parameters<ModelRuntime["registerNativeProvider"]>[0]) =>
			runtime.registerNativeProvider(provider),
		unregisterProvider: (id: string) => runtime.unregisterProvider(id),
	} as unknown as ExtensionAPI;
	await providerExtension(pi);
	return runtime;
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const LISTED = [
	{ id: "gpt-5.4", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
	{ id: "typesafe/jev", context_length: 24_000, architecture: { output_modalities: ["decisions"] } },
	{ id: "Qwen/Qwen3-Embedding-4B", architecture: { output_modalities: ["embeddings"] } },
];

/** Serve CPA's Codex catalog, plain list and System One endpoint. */
function mockCpa(list: () => unknown[] | Error) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		if (url === MODELS_URL) return json({ models: [{ slug: "gpt-5.4" }] });
		if (url === LIST_URL) {
			const result = list();
			if (result instanceof Error) throw result;
			return json({ object: "list", data: result });
		}
		if (url === SYSTEMONE_URL) {
			return json({ model: "typesafe/jev", answers: { done: { type: "noul", noul: 0.86 } } });
		}
		return new Response("{}");
	});
}

describe("classifier model mapping", () => {
	it("maps only decision models and bounds unknown input limits", () => {
		expect(toClassifierModel(LISTED[0]!, "cliproxyapi", INFERENCE_BASE)).toBeNull();
		expect(toClassifierModel(LISTED[2]!, "cliproxyapi", INFERENCE_BASE)).toBeNull();
		expect(toClassifierModel(LISTED[1]!, "cliproxyapi", INFERENCE_BASE)).toMatchObject({
			type: "classifier",
			id: "typesafe/jev",
			api: "typesafe-system-one",
			provider: "cliproxyapi",
			baseUrl: INFERENCE_BASE,
			input: ["text"],
			contextWindow: 24_000,
		});
		const unknownLimit = toClassifierModel(
			{ id: "jev", architecture: { output_modalities: ["DECISIONS"] } },
			"cliproxyapi",
			INFERENCE_BASE,
		);
		expect(unknownLimit?.contextWindow).toBe(DEFAULT_CLASSIFIER_CONTEXT_WINDOW);
	});

	it("derives the CPA /v1 root from the inference base", () => {
		expect(classifierBaseUrl(INFERENCE_BASE)).toBe(`${ROOT}/v1/`);
		expect(classifierBaseUrl("https://cpa.example/proxy/backend-api")).toBe("https://cpa.example/proxy/v1/");
	});

	it("never rejects when the stock classifier fails", async () => {
		const classify = createClassify(async () => {
			throw new Error("boom");
		});
		const result = await classify(
			toClassifierModel(LISTED[1]!, "cliproxyapi", INFERENCE_BASE)!,
			{ state: {}, questions: {} },
			{ apiKey: "key" },
		);
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "boom", model: "typesafe/jev" });
	});
});

describe("classifier models in Pi", () => {
	it("registers decision models as classifiers and classifies through CPA /v1/systemone", async () => {
		await withAgentDir(async (agentDir) => {
			const fetchMock = mockCpa(() => LISTED);
			const store = new InMemoryModelsStore();
			const runtime = await startPi(store, agentDir);
			await runtime.refresh({ allowNetwork: false });

			expect(runtime.getModels("cliproxyapi").map((model) => model.id)).toEqual(["gpt-5.4"]);
			const classifiers = await runtime.getAvailableOfType("classifier", "cliproxyapi");
			expect(classifiers.map((model) => model.id)).toEqual(["typesafe/jev"]);
			expect((await store.read("cliproxyapi"))?.models.map((model) => model.id)).toEqual([
				"gpt-5.4",
				"typesafe/jev",
			]);

			const result = await runtime.classify(classifiers[0]!, {
				state: { task: "fix bug", tests: "pass" },
				questions: {
					done: { type: "bool", instructions: "Is the task complete?", criteria: { true: "yes", false: "no" } },
				},
			});
			expect(result.errorMessage).toBeUndefined();
			expect(result.answers.done).toEqual({ type: "bool", probability: 0.86 });

			const call = fetchMock.mock.calls.find(([url]) => String(url) === SYSTEMONE_URL);
			expect(call).toBeDefined();
			const init = call![1] as RequestInit;
			expect(new Headers(init.headers).get("authorization")).toBe("Bearer key");
			expect(JSON.parse(String(init.body))).toMatchObject({ model: "typesafe/jev" });
		});
	});

	it("keeps stored classifiers when only the plain model list fails", async () => {
		await withAgentDir(async (agentDir) => {
			let list: unknown[] | Error = LISTED;
			mockCpa(() => list);
			const store = new InMemoryModelsStore();
			const first = await startPi(store, agentDir);
			await first.refresh({ allowNetwork: false });
			expect((await first.getAvailableOfType("classifier", "cliproxyapi")).map((m) => m.id)).toEqual([
				"typesafe/jev",
			]);

			list = new Error("list down");
			vi.spyOn(console, "warn").mockImplementation(() => {});
			await first.refresh({ providers: ["cliproxyapi"], force: true });
			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("failed to load decision models"));
			expect((await first.getAvailableOfType("classifier", "cliproxyapi")).map((m) => m.id)).toEqual([
				"typesafe/jev",
			]);
			expect((await store.read("cliproxyapi"))?.models.map((model) => model.id)).toContain("typesafe/jev");
		});
	});
});
