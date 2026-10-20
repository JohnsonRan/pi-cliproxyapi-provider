/**
 * Adapt Pi's stock OpenAI Codex Responses streams for CLIProxyAPI.
 *
 * CLIProxyAPI authenticates with a plain API key, while Pi's Codex protocol
 * parser expects a ChatGPT JWT so it can derive chatgpt-account-id. Keep the
 * real key in X-Api-Key and give the stock stream a deterministic synthetic
 * JWT whose account id also isolates Pi's per-session WebSocket cache.
 */

import { createHash } from "node:crypto";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	clampThinkingLevel,
	type Message,
	type Model,
	type OpenAICodexResponsesOptions,
	type Provider,
	type ProviderHeaders,
	type ProviderStreamOptions,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { mergeSessionHeaders } from "./session.ts";

export const CLIPROXYAPI_CODEX_API = "openai-codex-responses" as const;

const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const SYNTHETIC_JWT_HEADER = { alg: "none", typ: "JWT" } as const;

type CliproxyCodexStreamFunction<TOptions extends StreamOptions> = (
	model: Model<Api>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

export type CliproxyCodexStream = Provider<typeof CLIPROXYAPI_CODEX_API>["stream"];
export type CliproxyCodexStreamSimple = CliproxyCodexStreamFunction<SimpleStreamOptions>;

export type CliproxyCodexStreams = {
	streamSimple: CliproxyCodexStreamSimple;
	stream: CliproxyCodexStream;
	api: typeof CLIPROXYAPI_CODEX_API;
};

export interface CliproxyCodexStreamOptions {
	shouldUseFast?: (model: Model<Api>) => boolean;
	getSessionHeaders?: (options?: StreamOptions) => ProviderHeaders;
}

type Transport = NonNullable<StreamOptions["transport"]>;
type TransportChoice = (model: Model<Api>, options?: StreamOptions) => Transport;

export const PRIORITY_SERVICE_TIER = "priority" as const;

function encodeJwtPart(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createSyntheticCodexAccountId(apiKey: string): string {
	const fingerprint = createHash("sha256").update(apiKey, "utf8").digest("hex");
	return `cpa_${fingerprint}`;
}

export function createSyntheticCodexJwt(apiKey: string): string {
	const payload = {
		[CODEX_ACCOUNT_CLAIM]: {
			chatgpt_account_id: createSyntheticCodexAccountId(apiKey),
		},
	};
	return `${encodeJwtPart(SYNTHETIC_JWT_HEADER)}.${encodeJwtPart(payload)}.`;
}

export function withCliproxyCodexAuth<TOptions extends StreamOptions>(options?: TOptions): TOptions | undefined {
	if (!options || typeof options.apiKey !== "string" || !options.apiKey.trim()) {
		return options;
	}
	const realApiKey = options.apiKey.trim();

	return {
		...options,
		apiKey: createSyntheticCodexJwt(realApiKey),
		headers: {
			...options.headers,
			"X-Api-Key": realApiKey,
		},
	} as unknown as TOptions;
}

/**
 * Pi's `transport` setting passes through unchanged; its default `auto` lets Pi's stock
 * Codex stream try WebSocket first and own SSE fallback and recovery.
 * One-off no-cache requests always use SSE.
 */
export function resolveCliproxyTransport(options: StreamOptions | undefined): Transport {
	if (options?.cacheRetention === "none") return "sse";
	return options?.transport ?? "auto";
}

/**
 * Pi's stock Codex streamSimple drops `serviceTier`, so Fast maps simple options onto the
 * full stream the same way (the Codex stream ignores maxTokens/samplingParams, so the rest
 * passes through). The stock stream then sends `service_tier` and applies Codex tier pricing.
 */
export function toFastCodexOptions(model: Model<Api>, options?: SimpleStreamOptions): OpenAICodexResponsesOptions {
	const { reasoning, ...rest } = options ?? {};
	const level = reasoning ? clampThinkingLevel(model, reasoning) : undefined;
	return {
		...rest,
		reasoningEffort: (level === "off" ? undefined : level) as OpenAICodexResponsesOptions["reasoningEffort"],
		serviceTier: PRIORITY_SERVICE_TIER,
	};
}

export function wrapStreamForCliproxyAuth<TOptions extends StreamOptions>(
	stream: CliproxyCodexStreamFunction<TOptions>,
): CliproxyCodexStreamFunction<TOptions> {
	return (model, context, streamOptions) => stream(model, context, withCliproxyCodexAuth(streamOptions));
}

export function wrapStreamForTransport<TOptions extends StreamOptions>(
	stream: CliproxyCodexStreamFunction<TOptions>,
	transport: TransportChoice,
): CliproxyCodexStreamFunction<TOptions> {
	return (model, context, streamOptions) =>
		stream(model, context, { ...streamOptions, transport: transport(model, streamOptions) } as TOptions);
}

/**
 * Empty user/assistant messages (e.g. watchdog fold markers that convert to `""`) become empty
 * `input_text`/`output_text` items, which CPA forwards to backends such as Claude or Gemini that
 * reject empty content. Signed blocks and tool calls are always kept: providers require them.
 */
export function isEmptyMessage(message: Message): boolean {
	if (message.role === "user") {
		return typeof message.content === "string"
			? !message.content.trim()
			: message.content.every((block) => block.type === "text" && !block.text.trim());
	}
	if (message.role !== "assistant") return false;
	return message.content.every(
		(block) =>
			(block.type === "text" && !block.textSignature && !block.text.trim()) ||
			(block.type === "thinking" && !block.thinkingSignature && !block.thinking.trim()),
	);
}

function wrapStreamForEmptyMessages<TOptions extends StreamOptions>(
	stream: CliproxyCodexStreamFunction<TOptions>,
): CliproxyCodexStreamFunction<TOptions> {
	return (model, context, options) =>
		stream(model, { ...context, messages: context.messages.filter((message) => !isEmptyMessage(message)) }, options);
}

function wrapStreamForSession<TOptions extends StreamOptions>(
	stream: CliproxyCodexStreamFunction<TOptions>,
	getHeaders?: CliproxyCodexStreamOptions["getSessionHeaders"],
): CliproxyCodexStreamFunction<TOptions> {
	return (model, context, options) => {
		const headers = getHeaders?.(options) ?? {};
		return stream(
			model,
			context,
			Object.keys(headers).length === 0
				? options
				: ({
						...options,
						headers: mergeSessionHeaders(mergeSessionHeaders(headers, model.headers), options?.headers),
					} as TOptions),
		);
	};
}

/**
 * Pi's built-in `openai-codex` provider carries the stock Codex Responses streams. Taking them
 * from `providers/all` avoids `@earendil-works/pi-ai/compat`, which Pi marks as temporary.
 */
function stockCodexStreams(): Pick<Provider, "stream" | "streamSimple"> {
	const provider = builtinProviders().find((candidate) => candidate.id === "openai-codex");
	if (!provider) throw new Error("Pi's built-in openai-codex provider is unavailable");
	return provider;
}

export function loadCliproxyCodexStreams(options: CliproxyCodexStreamOptions = {}): CliproxyCodexStreams {
	const stock = stockCodexStreams();
	const transport: TransportChoice = (_model, streamOptions) => resolveCliproxyTransport(streamOptions);
	const useFast = (model: Model<Api>): boolean => options.shouldUseFast?.(model) ?? false;
	const stockStreamSimple = wrapStreamForSession(
		wrapStreamForEmptyMessages(stock.streamSimple as CliproxyCodexStreamSimple),
		options.getSessionHeaders,
	);
	const stockStream = wrapStreamForSession(
		wrapStreamForEmptyMessages(stock.stream as CliproxyCodexStreamFunction<ProviderStreamOptions>),
		options.getSessionHeaders,
	) as CliproxyCodexStream;
	const simple = wrapStreamForTransport(wrapStreamForCliproxyAuth(stockStreamSimple), transport);
	const fullStream = wrapStreamForTransport(
		wrapStreamForCliproxyAuth(stockStream as CliproxyCodexStreamFunction<OpenAICodexResponsesOptions>),
		transport,
	);

	return {
		api: CLIPROXYAPI_CODEX_API,
		streamSimple: (model, context, streamOptions) =>
			useFast(model)
				? fullStream(model, context, toFastCodexOptions(model, streamOptions))
				: simple(model, context, streamOptions),
		stream: ((model, context, streamOptions) =>
			fullStream(
				model,
				context,
				useFast(model)
					? { ...streamOptions, serviceTier: streamOptions?.serviceTier ?? PRIORITY_SERVICE_TIER }
					: streamOptions,
			)) as CliproxyCodexStream,
	};
}
