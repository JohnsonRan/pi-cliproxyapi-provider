/**
 * Pure helpers for CLIProxyAPI baseUrl normalization, model mapping, and config I/O.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Local shape matching pi ThinkingLevelMap; avoid hard runtime peer imports here.
export type ThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra", string | null>
>;

export const DEFAULT_PROVIDER_ID = "cliproxyapi";
export const DEFAULT_PROVIDER_NAME = "CLIProxyAPI";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
export const CONFIG_FILE_NAME = "cliproxyapi.json";
export const AUTH_FILE_NAME = "auth.json";
export const CLIENT_VERSION = "pi";

/** Keep login credentials effectively permanent; reconfigure via /cliproxyapi or /login. */
export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_CONTEXT_WINDOW = 128000;

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export interface CliproxyConfigFile {
	baseUrl?: string;
	apiKey?: string;
	providerId?: string;
	providerName?: string;
	fast?: boolean;
}

export interface ResolvedIdentity {
	providerId: string;
	providerName: string;
}

export interface ResolvedConnection {
	baseUrlInput: string;
	apiKey: string;
	inferenceBaseUrl: string;
	modelsUrl: string;
}

export interface CodexReasoningLevel {
	effort?: string;
	description?: string;
}

export interface CodexServiceTier {
	id?: string;
	name?: string;
	description?: string;
}

export interface CodexClientModel {
	slug?: string;
	id?: string;
	display_name?: string;
	name?: string;
	description?: string;
	context_window?: number;
	max_context_window?: number;
	input_modalities?: string[];
	supported_reasoning_levels?: CodexReasoningLevel[] | string[];
	default_service_tier?: string | null;
	service_tiers?: Array<CodexServiceTier | string>;
	additional_speed_tiers?: string[];
	visibility?: string;
}

export interface CodexClientModelsResponse {
	models?: CodexClientModel[];
	data?: CodexClientModel[];
}

export interface PiProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface OAuthRefreshMeta {
	baseUrl: string;
}

export function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Normalize user-provided base URL into inference + models endpoints.
 *
 * Preferred input: host:port (e.g. http://127.0.0.1:8317)
 * - /backend-api kept as-is for inference
 * - /v1 rewritten to /backend-api for inference
 * - models always at {root}/v1/models?client_version=pi
 */
export function resolveEndpoints(baseUrlInput: string): {
	inferenceBaseUrl: string;
	modelsUrl: string;
	rootOrigin: string;
} {
	let raw = baseUrlInput.trim();
	if (!raw) {
		throw new Error("baseUrl is empty");
	}
	if (!/^https?:\/\//i.test(raw)) {
		raw = `http://${raw}`;
	}

	const url = new URL(raw);
	let path = url.pathname.replace(/\/+$/, "");

	if (path === "/v1") {
		path = "/backend-api";
	} else if (path.endsWith("/v1")) {
		path = `${path.slice(0, -"/v1".length)}/backend-api`;
	} else if (path === "" || path === "/") {
		path = "/backend-api";
	} else if (!path.endsWith("/backend-api")) {
		path = `${path}/backend-api`;
	}

	const rootPath = path.replace(/\/backend-api$/, "");
	const inferenceBaseUrl = `${url.origin}${path}/`;
	const modelsPath = `${rootPath}/v1/models`.replace(/\/{2,}/g, "/");
	const modelsUrl = `${url.origin}${modelsPath}?client_version=${encodeURIComponent(CLIENT_VERSION)}`;

	return {
		inferenceBaseUrl,
		modelsUrl,
		rootOrigin: url.origin,
	};
}

export function encodeRefreshMeta(baseUrl: string): string {
	const meta: OAuthRefreshMeta = { baseUrl };
	return JSON.stringify(meta);
}

export function decodeRefreshMeta(refresh: string | undefined): OAuthRefreshMeta | null {
	if (!refresh?.trim()) {
		return null;
	}
	try {
		const parsed = JSON.parse(refresh) as OAuthRefreshMeta;
		if (parsed && typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()) {
			return { baseUrl: parsed.baseUrl.trim() };
		}
	} catch {
		// Older / non-JSON refresh tokens are ignored.
	}
	return null;
}

export function loadConfigFile(agentDir: string): CliproxyConfigFile {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object`);
		}
		return parsed as CliproxyConfigFile;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			throw error;
		}
		return {};
	}
}

export function saveConfigFile(agentDir: string, config: CliproxyConfigFile): void {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	mkdirSync(dirname(configPath), { recursive: true });

	const existing = loadConfigFile(agentDir);
	const next: CliproxyConfigFile = {
		...existing,
		...config,
	};
	writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function loadAuthConnection(agentDir: string, providerId: string): { baseUrl?: string; apiKey?: string } | null {
	const authPath = join(agentDir, AUTH_FILE_NAME);
	try {
		const raw = readFileSync(authPath, "utf8");
		const data = JSON.parse(raw) as Record<string, any>;
		const entry = data?.[providerId];
		if (!entry || typeof entry !== "object") {
			return null;
		}

		if (entry.type === "oauth" && typeof entry.access === "string" && entry.access.trim()) {
			const meta = decodeRefreshMeta(typeof entry.refresh === "string" ? entry.refresh : undefined);
			return {
				apiKey: entry.access.trim(),
				baseUrl: meta?.baseUrl,
			};
		}

		if (entry.type === "api_key" && typeof entry.key === "string" && entry.key.trim()) {
			return { apiKey: entry.key.trim() };
		}
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			throw error;
		}
	}
	return null;
}

export function resolveIdentity(agentDir: string): ResolvedIdentity {
	let file: CliproxyConfigFile = {};
	try {
		file = loadConfigFile(agentDir);
	} catch {
		file = {};
	}

	return {
		providerId: firstNonEmpty(process.env.CLIPROXYAPI_PROVIDER_ID, file.providerId, DEFAULT_PROVIDER_ID)!,
		providerName: firstNonEmpty(process.env.CLIPROXYAPI_PROVIDER_NAME, file.providerName, DEFAULT_PROVIDER_NAME)!,
	};
}

export function parseBooleanSetting(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

/** Resolve the Fast preference from env, then cliproxyapi.json, then false. */
export function resolveFastDefault(agentDir: string): boolean {
	const envValue = firstNonEmpty(process.env.CLIPROXYAPI_FAST);
	if (envValue !== undefined) {
		const parsed = parseBooleanSetting(envValue);
		if (parsed === undefined) {
			throw new Error(`CLIPROXYAPI_FAST must be one of: true, false, 1, 0, yes, no, on, off`);
		}
		return parsed;
	}

	const file = loadConfigFile(agentDir);
	if (file.fast === undefined) {
		return false;
	}
	if (typeof file.fast !== "boolean") {
		throw new Error(`${CONFIG_FILE_NAME} field "fast" must be a boolean`);
	}
	return file.fast;
}

/**
 * Resolve connection settings.
 * Priority: env > cliproxyapi.json > auth.json (/login) > default baseUrl
 */
export function resolveConnection(agentDir: string, providerId: string): ResolvedConnection | null {
	let file: CliproxyConfigFile = {};
	try {
		file = loadConfigFile(agentDir);
	} catch {
		file = {};
	}

	let auth: { baseUrl?: string; apiKey?: string } | null = null;
	try {
		auth = loadAuthConnection(agentDir, providerId);
	} catch {
		auth = null;
	}

	const baseUrlInput = firstNonEmpty(process.env.CLIPROXYAPI_BASE_URL, file.baseUrl, auth?.baseUrl, DEFAULT_BASE_URL)!;
	const apiKey = firstNonEmpty(process.env.CLIPROXYAPI_API_KEY, file.apiKey, auth?.apiKey);
	if (!apiKey) {
		return null;
	}

	const endpoints = resolveEndpoints(baseUrlInput);
	return {
		baseUrlInput,
		apiKey,
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
	};
}

export function extractReasoningEfforts(model: CodexClientModel): string[] {
	const raw = model.supported_reasoning_levels ?? [];
	const efforts: string[] = [];
	for (const entry of raw) {
		const effort = typeof entry === "string" ? entry : typeof entry?.effort === "string" ? entry.effort : "";
		const normalized = effort.trim().toLowerCase();
		if (!normalized) continue;
		if (!efforts.includes(normalized)) {
			efforts.push(normalized);
		}
	}
	return efforts;
}

export function buildThinkingLevelMap(efforts: string[]): ThinkingLevelMap | undefined {
	if (efforts.length === 0) {
		return undefined;
	}

	const supported = new Set(efforts);
	const map: ThinkingLevelMap = {};

	for (const level of PI_THINKING_LEVELS) {
		if (level === "off") {
			map.off = supported.has("none") ? "none" : null;
			continue;
		}
		map[level] = supported.has(level) ? level : null;
	}

	return map;
}

export function buildInputModalities(model: CodexClientModel): Array<"text" | "image"> {
	const raw = model.input_modalities ?? [];
	const input: Array<"text" | "image"> = [];
	for (const modality of raw) {
		const value = String(modality).trim().toLowerCase();
		if ((value === "text" || value === "image") && !input.includes(value)) {
			input.push(value);
		}
	}
	if (!input.includes("text")) {
		input.unshift("text");
	}
	return input;
}

export function codexModelId(model: CodexClientModel): string {
	return (model.slug ?? model.id ?? "").trim();
}

export function supportsFastServiceTier(model: CodexClientModel): boolean {
	return Array.isArray(model.service_tiers) && model.service_tiers.length > 0;
}

export function toPiModel(model: CodexClientModel): PiProviderModel | null {
	const id = codexModelId(model);
	if (!id) {
		return null;
	}
	if (String(model.visibility ?? "").toLowerCase() === "hide") {
		return null;
	}

	const efforts = extractReasoningEfforts(model);
	const hasReasoning = efforts.some((effort) => effort !== "none");
	const contextWindow =
		(typeof model.context_window === "number" && model.context_window > 0 ? model.context_window : undefined) ??
		(typeof model.max_context_window === "number" && model.max_context_window > 0
			? model.max_context_window
			: undefined) ??
		DEFAULT_CONTEXT_WINDOW;

	return {
		id,
		name: (model.display_name ?? model.name ?? id).trim() || id,
		reasoning: hasReasoning,
		input: buildInputModalities(model),
		cost: { ...ZERO_COST },
		contextWindow,
		maxTokens: DEFAULT_MAX_TOKENS,
		thinkingLevelMap: buildThinkingLevelMap(efforts),
	};
}

/** HTTP error from /v1/models (used to detect 401 and re-show setup commands). */
export class ModelsHttpError extends Error {
	readonly status: number;
	readonly statusText: string;

	constructor(status: number, statusText: string, body: string) {
		super(`models request failed: ${status} ${statusText}${body ? ` body=${body.slice(0, 200)}` : ""}`);
		this.name = "ModelsHttpError";
		this.status = status;
		this.statusText = statusText;
	}
}

export function isUnauthorizedModelsError(error: unknown): boolean {
	return error instanceof ModelsHttpError && error.status === 401;
}

export async function fetchCodexModels(modelsUrl: string, apiKey: string): Promise<CodexClientModel[]> {
	const response = await fetch(modelsUrl, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
	});

	// Login validation only requires HTTP 200; non-2xx means credentials/baseUrl failed.
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new ModelsHttpError(response.status, response.statusText, body);
	}

	// Status 200 is enough for success, even when the catalog is empty or non-JSON.
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return [];
	}

	if (Array.isArray(payload)) {
		return payload as CodexClientModel[];
	}
	if (payload && typeof payload === "object") {
		const obj = payload as CodexClientModelsResponse;
		if (Array.isArray(obj.models)) {
			return obj.models;
		}
		if (Array.isArray(obj.data)) {
			return obj.data;
		}
	}
	return [];
}

export async function loadMappedModels(
	baseUrlInput: string,
	apiKey: string,
): Promise<{ models: PiProviderModel[]; fastModelIds: string[]; inferenceBaseUrl: string; modelsUrl: string }> {
	const endpoints = resolveEndpoints(baseUrlInput);
	const remoteModels = await fetchCodexModels(endpoints.modelsUrl, apiKey);
	const models = remoteModels.map(toPiModel).filter((model): model is PiProviderModel => model !== null);
	const fastModelIds = Array.from(
		new Set(
			remoteModels
				.filter(supportsFastServiceTier)
				.map(codexModelId)
				.filter((modelId) => modelId.length > 0),
		),
	);

	// Empty catalog is valid: credentials passed (HTTP 200), just no usable models yet.
	return {
		models,
		fastModelIds,
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
	};
}
