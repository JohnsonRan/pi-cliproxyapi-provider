/**
 * CLIProxyAPI image models for Pi's `generateImages()` (codemode `models.generateImages`).
 *
 * CPA's Codex catalog hides image models without marking them as such, so the
 * user lists them explicitly in cliproxyapi.json `imageModels`.
 */

import type {
	AssistantImages,
	ImageContent,
	ImageModel,
	ImagesContext,
	ImagesOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { ZERO_COST } from "./lib.ts";

export const CLIPROXYAPI_IMAGES_API = "cliproxyapi-images" as const;

export function parseImageModelIds(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.trim())) {
		throw new Error("imageModels must be an array of model ids");
	}
	return [...new Set(value.map((id: string) => id.trim()))];
}

export function toImageModel(id: string, provider: string, baseUrl: string): ImageModel<typeof CLIPROXYAPI_IMAGES_API> {
	return {
		type: "image",
		id,
		name: id,
		api: CLIPROXYAPI_IMAGES_API,
		provider,
		baseUrl,
		input: ["text", "image"],
		output: ["image"],
		// ponytail: zero cost; match models.dev image pricing if CPA image spend needs tracking.
		cost: { ...ZERO_COST },
	};
}

/** `baseUrl` is the inference base `{root}/backend-api/`; the images endpoints live at `{root}/v1/images/*`. */
export function imagesUrl(baseUrl: string, edit: boolean): string {
	return new URL(`../v1/images/${edit ? "edits" : "generations"}`, baseUrl).toString();
}

export function buildImagesRequest(model: ImageModel<string>, context: ImagesContext) {
	const prompt = context.input
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
	const images = context.input.filter((item): item is ImageContent => item.type === "image");
	return {
		edit: images.length > 0,
		body: {
			model: model.id,
			prompt,
			response_format: "b64_json",
			...(images.length > 0
				? { images: images.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })) }
				: {}),
		},
	};
}

interface ImagesResponse {
	data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
	output_format?: string;
	usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

/** Base64 magic-byte prefixes; used when CPA omits `output_format` (e.g. Grok returns JPEG without it). */
const BASE64_SIGNATURES: Array<[string, string]> = [
	["iVBORw0KGgo", "image/png"],
	["/9j/", "image/jpeg"],
	["UklGR", "image/webp"],
	["R0lGOD", "image/gif"],
];

function sniffMimeType(data: string): string {
	return BASE64_SIGNATURES.find(([prefix]) => data.startsWith(prefix))?.[1] ?? "image/png";
}

export function parseImagesResponse(payload: ImagesResponse, output: AssistantImages): void {
	const format = payload.output_format === "jpg" ? "jpeg" : payload.output_format;
	for (const item of payload.data ?? []) {
		const dataUrl = item.url?.match(/^data:([^;]+);base64,(.+)$/);
		if (item.b64_json) {
			const mimeType = format ? `image/${format}` : sniffMimeType(item.b64_json);
			output.output.push({ type: "image", data: item.b64_json, mimeType });
		} else if (dataUrl) output.output.push({ type: "image", mimeType: dataUrl[1]!, data: dataUrl[2]! });
		else if (item.url) output.output.push({ type: "text", text: `Image URL: ${item.url}` });
		if (item.revised_prompt) output.output.push({ type: "text", text: `Revised prompt: ${item.revised_prompt}` });
	}
	if (payload.usage) {
		const input = payload.usage.input_tokens ?? 0;
		const generated = payload.usage.output_tokens ?? 0;
		const usage: Usage = {
			input,
			output: generated,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: payload.usage.total_tokens ?? input + generated,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		output.usage = usage;
	}
}

export async function generateImages(
	model: ImageModel<string>,
	context: ImagesContext,
	options?: ImagesOptions,
): Promise<AssistantImages> {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		const request = buildImagesRequest(model, context);
		if (!request.body.prompt) throw new Error("Image generation needs a text prompt");
		const response = await (options.fetch ?? fetch)(imagesUrl(model.baseUrl, request.edit), {
			method: "POST",
			headers: {
				...model.headers,
				...options.headers,
				Authorization: `Bearer ${options.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request.body),
			signal: options.signal,
		});
		await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
		const text = await response.text();
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
		parseImagesResponse(JSON.parse(text) as ImagesResponse, output);
		if (!output.output.some((item) => item.type === "image")) throw new Error("CLIProxyAPI returned no images");
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
	}
	return output;
}
