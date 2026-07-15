import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTH_FILE_NAME,
	buildInputModalities,
	buildThinkingLevelMap,
	CONFIG_FILE_NAME,
	type CodexClientModel,
	DEFAULT_BASE_URL,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	DEFAULT_PROVIDER_ID,
	DEFAULT_PROVIDER_NAME,
	decodeRefreshMeta,
	encodeRefreshMeta,
	extractReasoningEfforts,
	firstNonEmpty,
	isUnauthorizedModelsError,
	loadAuthConnection,
	loadConfigFile,
	ModelsHttpError,
	parseBooleanSetting,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	saveConfigFile,
	supportsFastServiceTier,
	toPiModel,
	ZERO_COST,
} from "../extensions/lib.ts";

describe("firstNonEmpty", () => {
	it("returns the first non-empty trimmed string", () => {
		expect(firstNonEmpty("  ", undefined, null, " alpha ", "beta")).toBe("alpha");
	});

	it("returns undefined when all values are empty", () => {
		expect(firstNonEmpty("", "   ", undefined, null)).toBeUndefined();
	});
});

describe("resolveEndpoints", () => {
	it("normalizes host:port input", () => {
		const result = resolveEndpoints("http://127.0.0.1:8317");
		expect(result).toEqual({
			inferenceBaseUrl: "http://127.0.0.1:8317/backend-api/",
			modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=pi",
			rootOrigin: "http://127.0.0.1:8317",
		});
	});

	it("keeps /backend-api for inference", () => {
		const result = resolveEndpoints("http://127.0.0.1:8317/backend-api");
		expect(result.inferenceBaseUrl).toBe("http://127.0.0.1:8317/backend-api/");
		expect(result.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=pi");
	});

	it("rewrites /v1 to /backend-api for inference", () => {
		const result = resolveEndpoints("http://127.0.0.1:8317/v1");
		expect(result.inferenceBaseUrl).toBe("http://127.0.0.1:8317/backend-api/");
		expect(result.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=pi");
	});

	it("adds http scheme when missing", () => {
		const result = resolveEndpoints("127.0.0.1:8317");
		expect(result.inferenceBaseUrl).toBe("http://127.0.0.1:8317/backend-api/");
		expect(result.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=pi");
	});

	it("throws on empty baseUrl", () => {
		expect(() => resolveEndpoints("   ")).toThrow(/baseUrl is empty/);
	});
});

describe("refresh meta codec", () => {
	it("round-trips baseUrl metadata", () => {
		const encoded = encodeRefreshMeta("http://127.0.0.1:8317");
		expect(decodeRefreshMeta(encoded)).toEqual({ baseUrl: "http://127.0.0.1:8317" });
	});

	it("returns null for invalid or empty refresh tokens", () => {
		expect(decodeRefreshMeta(undefined)).toBeNull();
		expect(decodeRefreshMeta("")).toBeNull();
		expect(decodeRefreshMeta("not-json")).toBeNull();
		expect(decodeRefreshMeta(JSON.stringify({ foo: 1 }))).toBeNull();
	});
});

describe("model mapping helpers", () => {
	it("extracts unique reasoning efforts from objects and strings", () => {
		expect(
			extractReasoningEfforts({
				supported_reasoning_levels: [{ effort: "High" }, { effort: "high" }, { effort: "" }],
			}),
		).toEqual(["high"]);
		expect(
			extractReasoningEfforts({
				supported_reasoning_levels: ["Low", "low", ""],
			}),
		).toEqual(["low"]);
	});

	it("builds thinking level map with unsupported levels as null", () => {
		expect(buildThinkingLevelMap([])).toBeUndefined();
		expect(buildThinkingLevelMap(["none", "medium", "high"])).toMatchObject({
			off: "none",
			minimal: null,
			low: null,
			medium: "medium",
			high: "high",
			xhigh: null,
		});
	});

	it("builds input modalities and always includes text", () => {
		expect(buildInputModalities({ input_modalities: ["image", "IMAGE", "audio"] })).toEqual(["text", "image"]);
		expect(buildInputModalities({})).toEqual(["text"]);
	});

	it("detects Fast support from the CPA catalog", () => {
		expect(supportsFastServiceTier({ service_tiers: [{ id: "priority", name: "Fast" }] })).toBe(true);
		expect(supportsFastServiceTier({ service_tiers: ["PRIORITY"] })).toBe(true);
		expect(supportsFastServiceTier({ additional_speed_tiers: ["FAST"] })).toBe(true);
		expect(supportsFastServiceTier({ service_tiers: [], additional_speed_tiers: [] })).toBe(false);
		expect(supportsFastServiceTier({ service_tiers: [{ id: "flex" }] })).toBe(false);
	});

	it("treats malformed optional Fast metadata as unsupported", () => {
		expect(supportsFastServiceTier({ service_tiers: [null] } as unknown as CodexClientModel)).toBe(false);
		expect(supportsFastServiceTier({ service_tiers: {} } as unknown as CodexClientModel)).toBe(false);
		expect(supportsFastServiceTier({ additional_speed_tiers: [null] } as unknown as CodexClientModel)).toBe(false);
	});

	it("maps codex catalog entries to pi models", () => {
		const model = toPiModel({
			slug: "gpt-5",
			display_name: "GPT-5",
			context_window: 200000,
			input_modalities: ["text", "image"],
			supported_reasoning_levels: [{ effort: "high" }, { effort: "none" }],
		});

		expect(model).toEqual({
			id: "gpt-5",
			name: "GPT-5",
			reasoning: true,
			input: ["text", "image"],
			cost: { ...ZERO_COST },
			contextWindow: 200000,
			maxTokens: DEFAULT_MAX_TOKENS,
			thinkingLevelMap: buildThinkingLevelMap(["high", "none"]),
		});
	});

	it("skips hide visibility and missing ids", () => {
		expect(toPiModel({ slug: "x", visibility: "hide" })).toBeNull();
		expect(toPiModel({ display_name: "no-id" })).toBeNull();
	});

	it("falls back to default context window", () => {
		const model = toPiModel({ id: "m1" });
		expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(model?.reasoning).toBe(false);
	});
});

describe("ModelsHttpError", () => {
	it("detects unauthorized status", () => {
		const unauthorized = new ModelsHttpError(401, "Unauthorized", "nope");
		const forbidden = new ModelsHttpError(403, "Forbidden", "");
		expect(isUnauthorizedModelsError(unauthorized)).toBe(true);
		expect(isUnauthorizedModelsError(forbidden)).toBe(false);
		expect(isUnauthorizedModelsError(new Error("401"))).toBe(false);
		expect(unauthorized.message).toContain("401");
	});
});

describe("config and auth file helpers", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	function tempAgentDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-test-"));
		tempDirs.push(dir);
		return dir;
	}

	it("loads empty config when file is missing", () => {
		const agentDir = tempAgentDir();
		expect(loadConfigFile(agentDir)).toEqual({});
	});

	it("saves and merges config file", () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { baseUrl: "http://a", apiKey: "k1", fast: true });
		saveConfigFile(agentDir, { apiKey: "k2", providerName: "CPA" });

		const loaded = loadConfigFile(agentDir);
		expect(loaded).toEqual({
			baseUrl: "http://a",
			apiKey: "k2",
			providerName: "CPA",
			fast: true,
		});

		const raw = readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
	});

	it("loads oauth auth connection metadata", () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, AUTH_FILE_NAME),
			JSON.stringify({
				cliproxyapi: {
					type: "oauth",
					access: "sk-test",
					refresh: encodeRefreshMeta("http://127.0.0.1:8317"),
				},
			}),
			"utf8",
		);

		expect(loadAuthConnection(agentDir, "cliproxyapi")).toEqual({
			apiKey: "sk-test",
			baseUrl: "http://127.0.0.1:8317",
		});
	});

	it("loads api_key auth connection", () => {
		const agentDir = tempAgentDir();
		writeFileSync(
			join(agentDir, AUTH_FILE_NAME),
			JSON.stringify({
				cliproxyapi: {
					type: "api_key",
					key: "plain-key",
				},
			}),
			"utf8",
		);

		expect(loadAuthConnection(agentDir, "cliproxyapi")).toEqual({
			apiKey: "plain-key",
		});
	});

	it("parses Fast boolean settings", () => {
		for (const value of ["true", "1", "yes", "ON"]) {
			expect(parseBooleanSetting(value)).toBe(true);
		}
		for (const value of ["false", "0", "no", "OFF"]) {
			expect(parseBooleanSetting(value)).toBe(false);
		}
		expect(parseBooleanSetting("sometimes")).toBeUndefined();
	});

	it("resolves Fast default from config with env precedence", () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { fast: true });
		const previous = process.env.CLIPROXYAPI_FAST;
		try {
			delete process.env.CLIPROXYAPI_FAST;
			expect(resolveFastDefault(agentDir)).toBe(true);
			process.env.CLIPROXYAPI_FAST = "off";
			expect(resolveFastDefault(agentDir)).toBe(false);
			process.env.CLIPROXYAPI_FAST = "invalid";
			expect(() => resolveFastDefault(agentDir)).toThrow(/CLIPROXYAPI_FAST/);
		} finally {
			if (previous === undefined) {
				delete process.env.CLIPROXYAPI_FAST;
			} else {
				process.env.CLIPROXYAPI_FAST = previous;
			}
		}
	});

	it("resolves identity defaults", () => {
		const agentDir = tempAgentDir();
		const identity = resolveIdentity(agentDir);
		expect(identity).toEqual({
			providerId: DEFAULT_PROVIDER_ID,
			providerName: DEFAULT_PROVIDER_NAME,
		});
		expect(DEFAULT_BASE_URL).toBe("http://127.0.0.1:8317");
	});
});
