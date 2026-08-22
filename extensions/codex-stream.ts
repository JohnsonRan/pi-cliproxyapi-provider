/**
 * Adapt Pi's stock OpenAI Codex Responses streams for CLIProxyAPI.
 *
 * CLIProxyAPI authenticates with a plain API key, while Pi's Codex protocol
 * parser expects a ChatGPT JWT so it can derive chatgpt-account-id. Keep the
 * real key in X-Api-Key and give the stock stream a deterministic synthetic
 * JWT whose account id also isolates Pi's per-session WebSocket cache.
 */

import { createHash } from "node:crypto";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	Provider,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import type { CliproxyTransport } from "./lib.ts";

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
	transport?: CliproxyTransport;
}

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

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

export function withPriorityServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	return {
		...(payload as Record<string, unknown>),
		service_tier: "priority",
	};
}

/** Apply Fast before Pi's shared payload hooks so later extensions retain final control. */
export async function applyFastPayloadHook(
	payload: unknown,
	model: Model<Api>,
	onPayload?: PayloadHook,
): Promise<unknown> {
	const fastPayload = withPriorityServiceTier(payload);
	const nextPayload = await onPayload?.(fastPayload, model);
	return nextPayload === undefined ? fastPayload : nextPayload;
}

function wrapStreamForCliproxyAuth<TOptions extends StreamOptions>(
	stream: CliproxyCodexStreamFunction<TOptions>,
): CliproxyCodexStreamFunction<TOptions> {
	return (model, context, streamOptions) => stream(model, context, withCliproxyCodexAuth(streamOptions));
}

export function wrapStreamSimpleForCliproxyAuth(streamSimple: CliproxyCodexStreamSimple): CliproxyCodexStreamSimple {
	return wrapStreamForCliproxyAuth(streamSimple);
}

export function wrapCodexStreamForCliproxyAuth(stream: CliproxyCodexStream): CliproxyCodexStream {
	return wrapStreamForCliproxyAuth(
		stream as CliproxyCodexStreamFunction<ProviderStreamOptions>,
	) as CliproxyCodexStream;
}

function wrapStreamForTransport<TOptions extends StreamOptions>(
	stream: CliproxyCodexStreamFunction<TOptions>,
	transport: CliproxyTransport,
): CliproxyCodexStreamFunction<TOptions> {
	return (model, context, streamOptions) =>
		stream(model, context, {
			...streamOptions,
			transport: streamOptions?.cacheRetention === "none" ? "sse" : transport,
		} as TOptions);
}

export function wrapStreamSimpleForTransport(
	streamSimple: CliproxyCodexStreamSimple,
	transport: CliproxyTransport,
): CliproxyCodexStreamSimple {
	return wrapStreamForTransport(streamSimple, transport);
}

export function wrapCodexStreamForTransport(
	stream: CliproxyCodexStream,
	transport: CliproxyTransport,
): CliproxyCodexStream {
	return wrapStreamForTransport(
		stream as CliproxyCodexStreamFunction<ProviderStreamOptions>,
		transport,
	) as CliproxyCodexStream;
}

function wrapStreamForFast<TOptions extends StreamOptions>(
	stream: CliproxyCodexStreamFunction<TOptions>,
	shouldUseFast?: (model: Model<Api>) => boolean,
): CliproxyCodexStreamFunction<TOptions> {
	return (model, context, streamOptions) => {
		if (!shouldUseFast?.(model)) {
			return stream(model, context, streamOptions);
		}
		return stream(model, context, {
			...streamOptions,
			onPayload: (payload, payloadModel) => applyFastPayloadHook(payload, payloadModel, streamOptions?.onPayload),
		} as TOptions);
	};
}

export function wrapStreamSimpleForFast(
	streamSimple: CliproxyCodexStreamSimple,
	shouldUseFast?: (model: Model<Api>) => boolean,
): CliproxyCodexStreamSimple {
	return wrapStreamForFast(streamSimple, shouldUseFast);
}

export function wrapCodexStreamForFast(
	stream: CliproxyCodexStream,
	shouldUseFast?: (model: Model<Api>) => boolean,
): CliproxyCodexStream {
	return wrapStreamForFast(
		stream as CliproxyCodexStreamFunction<ProviderStreamOptions>,
		shouldUseFast,
	) as CliproxyCodexStream;
}

export function loadCliproxyCodexStreams(options: CliproxyCodexStreamOptions = {}): CliproxyCodexStreams {
	const stock = openAICodexResponsesApi();
	const transport = options.transport ?? "websocket";
	const stockStreamSimple = stock.streamSimple as CliproxyCodexStreamSimple;
	const stockStream = stock.stream as CliproxyCodexStream;
	const streamSimple = wrapStreamSimpleForFast(
		wrapStreamSimpleForTransport(wrapStreamSimpleForCliproxyAuth(stockStreamSimple), transport),
		options.shouldUseFast,
	);
	const stream = wrapCodexStreamForFast(
		wrapCodexStreamForTransport(wrapCodexStreamForCliproxyAuth(stockStream), transport),
		options.shouldUseFast,
	);

	return {
		api: CLIPROXYAPI_CODEX_API,
		streamSimple,
		stream,
	};
}
