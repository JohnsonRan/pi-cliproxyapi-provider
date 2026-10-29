/**
 * CLIProxyAPI decision models as Pi classifier models (`Models.classify()`).
 *
 * CPA's plain `/v1/models` list declares OpenRouter-style
 * `architecture.output_modalities`; entries whose outputs include `decisions`
 * are System One models served at `{root}/v1/systemone`. They are registered
 * with Pi's `typesafe-system-one` API. Listed models that Pi's built-in `openai`
 * provider serves through the Decisions API (`gpt-6-luna`) are also registered,
 * with `openai-decisions`, at `{root}/v1/decisions`. Requests go through the
 * stock implementation from the matching built-in provider.
 */

import {
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierOptions,
	type ClassifierResult,
	isModelType,
	type ProviderId,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { MODELS_REQUEST_TIMEOUT_MS, ModelsHttpError, resolveEndpoints, ZERO_COST } from "./lib.ts";

export const CLIPROXYAPI_CLASSIFIER_API = "typesafe-system-one" as const;
/** OpenRouter's output modality for decision models such as Jev. */
export const DECISIONS_MODALITY = "decisions";
/**
 * Input limit when CPA lists no `context_length` (set `max-context-length` on the
 * CPA model). Callers size their state by it, so it uses the smallest Jev limit in
 * Pi's catalog (OpenCode `jev-1.13`) rather than the chat default.
 */
export const DEFAULT_CLASSIFIER_CONTEXT_WINDOW = 32_000;

/** One entry of CPA's plain `/v1/models` list (fields used here). */
export interface ListedModel {
	id?: string;
	context_length?: number;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
}

function hasModality(values: unknown, modality: string): boolean {
	return Array.isArray(values) && values.some((value) => String(value).trim().toLowerCase() === modality);
}

export function isDecisionModel(model: ListedModel): boolean {
	return hasModality(model.architecture?.output_modalities, DECISIONS_MODALITY);
}

/** Built-in provider whose stock implementation serves each classifier API. */
const STOCK_PROVIDERS: Partial<Record<ClassifierApi, string>> = {
	"typesafe-system-one": "typesafe",
	"openai-decisions": "openai",
};

/** Pi's built-in OpenAI Decisions API models, the only models `/v1/decisions` accepts. */
export function decisionsApiModels(): ClassifierModel<ClassifierApi>[] {
	const openai = builtinProviders().find((candidate) => candidate.id === "openai");
	return (openai?.getAllModels?.() ?? []).filter(
		(model): model is ClassifierModel<ClassifierApi> =>
			isModelType(model as ClassifierModel<ClassifierApi>, "classifier") &&
			(model as ClassifierModel<ClassifierApi>).api === "openai-decisions",
	);
}

export function toClassifierModel(
	model: ListedModel,
	provider: ProviderId,
	baseUrl: string,
	decisionsModels: readonly ClassifierModel<ClassifierApi>[] = [],
): ClassifierModel<ClassifierApi> | null {
	const id = String(model.id ?? "").trim();
	if (!id) return null;
	// Checked first: a Decisions API model stays on that API even if CPA marks it as a decision model.
	const decisions = decisionsModels.find((candidate) => candidate.id === id);
	if (decisions) return { ...decisions, provider, baseUrl };
	if (!isDecisionModel(model)) return null;
	const input: Array<"text" | "image"> = hasModality(model.architecture?.input_modalities, "image")
		? ["text", "image"]
		: ["text"];
	return {
		type: "classifier",
		id,
		name: id,
		api: CLIPROXYAPI_CLASSIFIER_API,
		provider,
		baseUrl,
		input,
		cost: { ...ZERO_COST },
		contextWindow:
			typeof model.context_length === "number" && model.context_length > 0
				? model.context_length
				: DEFAULT_CLASSIFIER_CONTEXT_WINDOW,
	};
}

/** Fetch CPA's plain `/v1/models` list, which carries `architecture`. */
export async function fetchListedModels(listUrl: string, apiKey: string, signal?: AbortSignal): Promise<ListedModel[]> {
	const response = await fetch(listUrl, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new ModelsHttpError(response.status, response.statusText, body);
	}
	const payload = (await response.json()) as { data?: unknown };
	if (!Array.isArray(payload?.data)) throw new ModelsHttpError(response.status, "missing model list", "");
	return payload.data as ListedModel[];
}

/** Load CPA decision models as classifier models bound to `provider` and the inference base. */
export async function loadClassifierModels(
	baseUrlInput: string,
	apiKey: string,
	provider: ProviderId,
	signal?: AbortSignal,
): Promise<ClassifierModel<ClassifierApi>[]> {
	const { listUrl, inferenceBaseUrl } = resolveEndpoints(baseUrlInput);
	const timeout = AbortSignal.timeout(MODELS_REQUEST_TIMEOUT_MS);
	const listed = await fetchListedModels(listUrl, apiKey, signal ? AbortSignal.any([signal, timeout]) : timeout);
	const decisionsModels = decisionsApiModels();
	return listed
		.map((model) => toClassifierModel(model, provider, inferenceBaseUrl, decisionsModels))
		.filter((model): model is ClassifierModel<ClassifierApi> => model !== null);
}

/** Narrow a stored catalog to this provider's classifier models for the given endpoint. */
export function storedClassifierModels(
	models: readonly unknown[],
	provider: ProviderId,
	baseUrl: string,
): ClassifierModel<ClassifierApi>[] {
	return models.filter(
		(model): model is ClassifierModel<ClassifierApi> =>
			isModelType(model as ClassifierModel<ClassifierApi>, "classifier") &&
			(model as ClassifierModel<ClassifierApi>).provider === provider &&
			(model as ClassifierModel<ClassifierApi>).baseUrl === baseUrl,
	);
}

/**
 * `baseUrl` is the inference base `{root}/backend-api/`; System One lives at
 * `{root}/v1/systemone` and the Decisions API at `{root}/v1/decisions`.
 */
export function classifierBaseUrl(baseUrl: string): string {
	return new URL("../v1/", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

type Classify = (
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options?: ClassifierOptions,
) => Promise<ClassifierResult>;

/**
 * Classify through the stock implementation for the model's API (System One from
 * `typesafe`, Decisions from `openai`). `Models` rewrites the model's base URL to
 * the provider auth's inference base before dispatch, so the CPA `/v1` root is
 * derived here. Never rejects, like provider `classify`. `stockClassify` replaces
 * every stock implementation (tests).
 */
export function createClassify(stockClassify?: Classify): Classify {
	const stocks = new Map<string, Classify>();
	return async (model, context, options) => {
		try {
			let stock = stockClassify ?? stocks.get(model.api);
			if (!stock) {
				const id = STOCK_PROVIDERS[model.api];
				if (!id) throw new Error(`Unsupported classifier API: ${model.api}`);
				const provider = builtinProviders().find((candidate) => candidate.id === id);
				if (!provider?.classify) throw new Error(`Pi's built-in ${id} classifier is unavailable`);
				stock = provider.classify.bind(provider);
				stocks.set(model.api, stock);
			}
			return await stock({ ...model, baseUrl: classifierBaseUrl(model.baseUrl) }, context, options);
		} catch (error) {
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				answers: {},
				stopReason: options?.signal?.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
		}
	};
}
