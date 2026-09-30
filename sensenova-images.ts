import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SENSENOVA_BASE_URL = "https://token.sensenova.cn/v1";

const IMAGE_CONSTANTS = {
	n: 1,
	size: "auto",
	watermark: false,
	output_format: "png",
	response_format: "b64_json",
};

const ERROR_PREFIX = "SenseNova Images: ";

const PROVIDER_ID = "sensenova-images";
const DEFAULT_MODEL = "sensenova-u1.5-fast";
const IMAGE_MODELS = [
	{ id: "sensenova-u1.5-lite", name: "SenseNova U1.5 Lite" },
	{ id: DEFAULT_MODEL, name: "SenseNova U1.5 Fast" },
];
const IMAGE_DIR_NAME = ".sensenova";

export function generateImages(model, context, options = {}) {
	// Provider contract: never reject; fold failures into the returned result.
	const output = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return (async () => {
		try {
			const apiKey = options.apiKey;
			if (!apiKey) throw new Error(`${ERROR_PREFIX}API key is not configured`);
			const { prompt, images } = extractInput(context.input);
			if (!prompt) throw new Error(`${ERROR_PREFIX}image generation requires a text prompt`);
			const isEdit = images.length > 0;
			const body = {
				model: model.id,
				prompt,
				...IMAGE_CONSTANTS,
				...(isEdit
					? { images: images.map(({ mimeType, data }) => ({ image_url: `data:${mimeType};base64,${data}` })) }
					: {}),
			};
			const fetchImpl = options.fetch ?? globalThis.fetch;
			const response = await fetchImpl(`${model.baseUrl}/images/${isEdit ? "edits" : "generations"}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				...options.signal ? { signal: options.signal } : {},
			});
			const payload = await response.json();
			if (!response.ok) {
				throw new Error(`${ERROR_PREFIX}HTTP ${response.status} ${payload?.error?.message ?? ""}`.trim());
			}
			const entry = payload?.data?.[0];
			if (!entry || typeof entry.b64_json !== "string") {
				throw new Error(`${ERROR_PREFIX}response did not include b64_json image data`);
			}
			output.output.push({ type: "image", mimeType: outputMimeType(), data: entry.b64_json });
			output.usage = parseUsage(payload.usage);
			return output;
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			return output;
		}
	})();
}

function extractInput(input) {
	const parts = Array.isArray(input) ? input : [];
	const prompt = parts
		.filter((part) => part?.type === "text")
		.map((part) => String(part.text ?? ""))
		.join("\n");
	const images = parts
		.filter((part) => part?.type === "image")
		.map(({ mimeType, data }) => ({ mimeType, data }));
	return { prompt, images };
}

function outputMimeType() {
	return `image/${IMAGE_CONSTANTS.output_format}`;
}

function parseUsage(usage = {}) {
	const input = usage.input_tokens ?? 0;
	const output = usage.output_tokens ?? 0;
	const totalTokens = usage.total_tokens ?? input + output;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function imageModel(id, name) {
	return {
		type: "image",
		id,
		name,
		api: "sensenova-images",
		baseUrl: SENSENOVA_BASE_URL,
		input: ["text", "image"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function slugify(prompt) {
	const slug = prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "image";
}

function formatTimestamp(date) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, "0")}`;
}

async function saveImageFile(cwd, prompt, image, now) {
	const dir = join(cwd, IMAGE_DIR_NAME);
	const fileName = `${formatTimestamp(now)}-${slugify(prompt)}.${IMAGE_CONSTANTS.output_format}`;
	const filePath = join(dir, fileName);
	await mkdir(dir, { recursive: true });
	await writeFile(filePath, Buffer.from(image.data, "base64"));
	return filePath;
}

function toolError(message) {
	const text = message.startsWith(ERROR_PREFIX) ? message : `${ERROR_PREFIX}${message}`;
	return { content: [{ type: "text", text }], isError: true };
}

/** Conversation entry point for image generation; also the test seam for the tool. */
export function createGenerateImageTool(options = {}) {
	return {
		name: "sensenova_generate_image",
		label: "SenseNova Image Generator",
		description:
			"Generate an image from a text prompt with the SenseNova U1.5 model and save it as a PNG. Returns the path of the saved image. Use model \"sensenova-u1.5-lite\" for higher quality or \"sensenova-u1.5-fast\" (default) for quicker results.",
		promptSnippet: "Generate an image from a text prompt (SenseNova U1.5)",
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"Detailed text description of the image to generate: subject, style, composition, and mood.",
				},
				model: {
					type: "string",
					enum: IMAGE_MODELS.map((m) => m.id),
					default: DEFAULT_MODEL,
					description: "U-series model: sensenova-u1.5-fast (default, quicker) or sensenova-u1.5-lite (higher quality).",
				},
			},
			required: ["prompt"],
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const modelId = params.model ?? DEFAULT_MODEL;
			if (typeof params.prompt !== "string" || params.prompt.trim().length === 0) {
				return toolError("a text prompt is required");
			}
			const model = ctx.modelRegistry.getModelOfType("image", PROVIDER_ID, modelId);
			if (!model) {
				return toolError(`image model "${modelId}" is not in the catalog`);
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				return toolError(
					`no API key for provider "${PROVIDER_ID}"; run /login and choose \"SenseNova Images\", or set $SENSENOVA_API_KEY`,
				);
			}
			const result = await generateImages(
				model,
				{ input: [{ type: "text", text: params.prompt }] },
				{ apiKey: auth.apiKey, signal, fetch: options.fetch },
			);
			if (result.stopReason === "aborted") {
				return toolError("image generation aborted");
			}
			if (result.stopReason === "error" && result.errorMessage) {
				return toolError(result.errorMessage);
			}
			const image = result.output[0];
			if (!image || image.type !== "image") {
				return toolError("image generation returned no image data");
			}
			let filePath;
			try {
				filePath = await saveImageFile(ctx.cwd, params.prompt, image, options.now ? options.now() : new Date());
			} catch (error) {
				return toolError(`failed to save image: ${error instanceof Error ? error.message : String(error)}`);
			}
			return {
				content: [{ type: "text", text: `Image generated and saved to ${filePath}` }],
				details: { model: modelId, path: filePath },
			};
		},
	};
}

export default function (pi) {
	pi.registerProvider(PROVIDER_ID, {
		name: "SenseNova Images",
		apiKey: "$SENSENOVA_API_KEY",
		models: IMAGE_MODELS.map(({ id, name }) => imageModel(id, name)),
		images: { "sensenova-images": { generateImages } },
	});
	pi.registerTool(createGenerateImageTool());
}