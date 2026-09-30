import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

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
const MAX_EDIT_IMAGES = 5;
const MIME_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

export async function readImageBlocks(imagePaths, cwd) {
	const blocks = [];
	for (const rawPath of imagePaths) {
		const filePath = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
		let data;
		try {
			data = await readFile(filePath);
		} catch {
			throw new Error(`cannot read image file "${rawPath}"`);
		}
		const mimeType = detectImageMime(data.subarray(0, MIME_SNIFF_BYTES));
		if (!mimeType) {
			throw new Error(`"${rawPath}" is not a supported image file (expected png, jpeg, gif, webp, or bmp)`);
		}
		blocks.push({ type: "image", mimeType, data: data.toString("base64") });
	}
	return blocks;
}

function detectImageMime(buffer) {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		// 0xf7 marks a JPEG variant treated as unsupported (same guard as pi).
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWith(buffer, PNG_SIGNATURE)) {
		return isPngImage(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWith(buffer, "GIF87a") || startsWith(buffer, "GIF89a")) {
		return "image/gif";
	}
	if (startsWith(buffer, "RIFF") && startsWith(buffer, "WEBP", 8)) {
		return "image/webp";
	}
	if (startsWith(buffer, "BM") && isBmpImage(buffer)) {
		return "image/bmp";
	}
	return null;
}

function startsWith(buffer, pattern, offset = 0) {
	for (let i = 0; i < pattern.length; i++) {
		const expected = typeof pattern[i] === "string" ? pattern[i].charCodeAt(0) : pattern[i];
		if (buffer[offset + i] !== expected) {
			return false;
		}
	}
	return true;
}

function isPngImage(buffer) {
	return buffer.length >= 16 && readUint32BE(buffer, 8) === 13 && startsWith(buffer, "IHDR", 12);
}

// Animated PNGs (acTL chunk before IDAT) carry multiple frames, not one still.
function isAnimatedPng(buffer) {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkType = offset + 4;
		if (startsWith(buffer, "acTL", chunkType)) return true;
		if (startsWith(buffer, "IDAT", chunkType)) return false;
		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

function isBmpImage(buffer) {
	if (buffer.length < 26) return false;
	const declaredFileSize = readUint32LE(buffer, 2);
	const pixelDataOffset = readUint32LE(buffer, 10);
	const dibHeaderSize = readUint32LE(buffer, 14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
	let colorPlanes;
	let bitsPerPixel;
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		return false;
	}
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint32BE(buffer, offset) {
	return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
}

function readUint32LE(buffer, offset) {
	return (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0;
}

function readUint16LE(buffer, offset) {
	return buffer[offset] | (buffer[offset + 1] << 8);
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
			"Generate or edit an image with the SenseNova U1.5 model and save it as a PNG; returns the saved file path. Omit image_paths to generate an image from the prompt. To edit images, pass local file paths in image_paths (absolute, or relative to the working directory): the first image is the main edit target and up to 5 images are allowed; describe the desired result and what to keep unchanged in the prompt. Use model \"sensenova-u1.5-lite\" for higher quality or \"sensenova-u1.5-fast\" (default) for quicker results.",
		promptSnippet: "Generate or edit an image (SenseNova U1.5)",
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"Detailed text description of the image to generate or the edit to apply: subject, style, composition, and mood; for edits, state what to keep unchanged.",
				},
				image_paths: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
					maxItems: 5,
					description:
						"Local paths of reference images to edit (optional): pass 1+ paths to run image editing, the first image is the main edit target and up to 5 images are allowed; omit to generate from text only.",
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
			const imagePaths = params.image_paths ?? [];
			if (!Array.isArray(imagePaths) || imagePaths.some((p) => typeof p !== "string" || p.length === 0)) {
				return toolError("image_paths must be an array of non-empty file paths");
			}
			if (imagePaths.length > MAX_EDIT_IMAGES) {
				return toolError(`image_paths supports at most ${MAX_EDIT_IMAGES} images, got ${imagePaths.length}`);
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
			const input = [{ type: "text", text: params.prompt }];
			if (imagePaths.length > 0) {
				try {
					input.push(...(await readImageBlocks(imagePaths, ctx.cwd)));
				} catch (error) {
					return toolError(error instanceof Error ? error.message : String(error));
				}
			}
			const result = await generateImages(model, { input }, { apiKey: auth.apiKey, signal, fetch: options.fetch });
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
				content: [{ type: "text", text: `Image ${imagePaths.length > 0 ? "edited" : "generated"} and saved to ${filePath}` }],
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