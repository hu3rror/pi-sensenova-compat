import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const SENSENOVA_BASE_URL = "https://token.sensenova.cn/v1";

const IMAGE_CONSTANTS = {
	n: 1,
	size: "auto",
	watermark: false,
	output_format: "png",
	response_format: "b64_json",
	// Whether the chat tool includes the generated image as an image block in its result.
	// Rendering is terminal-dependent (kitty/iTerm2 only), but the block also enters the
	// model context on vision models, so it stays off by default.
	image_in_result: false,
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

// User-level command configuration (agent dir / extensions / sensenova-compat.json).
const CONFIG_FILE_NAME = "sensenova-compat.json";
const CONFIG_KEYS = ["model", "size", "output_format", "watermark", "output_dir", "image_in_result"];
const SUBCOMMANDS = ["gen", "edit", "settings"];
const SUBCOMMAND_DESCRIPTIONS = {
	gen: "text-to-image",
	edit: "image-to-image with @-referenced local files",
	settings: "view or change saved defaults",
};
const IMAGE_FILE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const SIZE_MIN = 512;
const SIZE_MAX = 4096;
const SIZE_STEP = 32;
const SIZE_RATIO_MAX = 3;
const OUTPUT_FORMATS = ["png", "jpeg", "webp"];
const MIME_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function resolveImageConfig(config = {}) {
	return {
		n: IMAGE_CONSTANTS.n,
		size: config.size ?? IMAGE_CONSTANTS.size,
		watermark: config.watermark ?? IMAGE_CONSTANTS.watermark,
		output_format: config.output_format ?? IMAGE_CONSTANTS.output_format,
		response_format: IMAGE_CONSTANTS.response_format,
		image_in_result: config.image_in_result ?? IMAGE_CONSTANTS.image_in_result,
	};
}

export function resolveAgentDir(env = process.env) {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function defaultConfigPath() {
	return join(resolveAgentDir(), "extensions", CONFIG_FILE_NAME);
}

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
			const imageConfig = options.config ?? resolveImageConfig();
			const body = {
				model: model.id,
				prompt,
				n: imageConfig.n,
				size: imageConfig.size,
				watermark: imageConfig.watermark,
				output_format: imageConfig.output_format,
				response_format: imageConfig.response_format,
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
			output.output.push({ type: "image", mimeType: outputMimeType(imageConfig.output_format), data: entry.b64_json });
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

function outputMimeType(outputFormat) {
	return `image/${outputFormat}`;
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

async function saveImageFile(cwd, prompt, image, now, outputFormat, outputDir) {
	const dir = isAbsolute(outputDir) ? outputDir : join(cwd, outputDir);
	await mkdir(dir, { recursive: true });
	const stem = `${formatTimestamp(now)}-${slugify(prompt)}`;
	// Exclusive create ("wx") with a numeric suffix on EEXIST: the stem alone
	// (ms timestamp + prompt slug) can collide for same-tick or same-prompt calls;
	// "wx" also wins the race between concurrent writers instead of overwriting.
	for (let attempt = 1; ; attempt++) {
		const fileName = attempt === 1 ? `${stem}.${outputFormat}` : `${stem}-${attempt}.${outputFormat}`;
		try {
			const filePath = join(dir, fileName);
			await writeFile(filePath, Buffer.from(image.data, "base64"), { flag: "wx" });
			return filePath;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
	}
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
			"Generate or edit an image with the SenseNova U1.5 model and save it to a local file; returns the saved file path (plus the image block when the image_in_result setting is on). Omit image_paths to generate an image from the prompt. To edit images, pass local file paths in image_paths (absolute, or relative to the working directory): the first image is the main edit target and up to 5 images are allowed; describe the desired result and what to keep unchanged in the prompt. Use model \"sensenova-u1.5-lite\" for higher quality or \"sensenova-u1.5-fast\" (default) for quicker results.",
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
			const run = await runImageGeneration(ctx, {
				prompt: params.prompt,
				imagePaths,
				explicitModel: params.model,
				configPath: options.configPath ?? defaultConfigPath(),
				fetch: options.fetch,
				now: options.now ? options.now() : new Date(),
				signal,
			});
			if (run.status === "error") {
				return toolError(run.message);
			}
			const configWarning = run.configError ? ` (${run.configError}; using defaults)` : "";
			const content = [
				{
					type: "text",
					text: `Image ${imagePaths.length > 0 ? "edited" : "generated"} and saved to ${run.filePath}${configWarning}`,
				},
			];
			if (run.imageInResult) {
				content.push({ type: "image", mimeType: run.imageMimeType, data: run.imageData });
			}
			return {
				content,
				details: { model: run.modelId, path: run.filePath },
			};
		},
	};
}

// --- sensenova-compat.json config file ---

export function validateImageConfig(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "config must be a JSON object" };
	}
	const config = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!CONFIG_KEYS.includes(key)) {
			return { ok: false, error: `unknown config key "${key}" (valid keys: ${CONFIG_KEYS.join(", ")})` };
		}
		const normalized = normalizeConfigValue(key, value);
		if (!normalized.ok) return normalized;
		config[key] = normalized.value;
	}
	return { ok: true, config };
}

function normalizeBoolean(key, value) {
	if (typeof value === "boolean") return { ok: true, value };
	if (value === "true" || value === "false") return { ok: true, value: value === "true" };
	return { ok: false, error: `${key} must be true or false` };
}

function normalizeConfigValue(key, value) {
	switch (key) {
		case "model":
			if (typeof value !== "string" || !IMAGE_MODELS.some((m) => m.id === value)) {
				return { ok: false, error: `model must be one of: ${IMAGE_MODELS.map((m) => m.id).join(", ")}` };
			}
			return { ok: true, value };
		case "size": {
			if (value === "auto") return { ok: true, value: "auto" };
			if (typeof value !== "string") return { ok: false, error: 'size must be "auto" or WxH (e.g. 1024x1024)' };
			const match = value.match(/^(\d{3,4})x(\d{3,4})$/);
			if (!match) return { ok: false, error: 'size must be "auto" or WxH (e.g. 1024x1024)' };
			const width = Number(match[1]);
			const height = Number(match[2]);
			if (width < SIZE_MIN || width > SIZE_MAX || height < SIZE_MIN || height > SIZE_MAX) {
				return { ok: false, error: `size dimensions must be ${SIZE_MIN}-${SIZE_MAX}` };
			}
			if (width % SIZE_STEP !== 0 || height % SIZE_STEP !== 0) {
				return { ok: false, error: `size dimensions must be multiples of ${SIZE_STEP}` };
			}
			if (Math.max(width, height) / Math.min(width, height) > SIZE_RATIO_MAX) {
				return { ok: false, error: `size aspect ratio must be at most ${SIZE_RATIO_MAX}:1` };
			}
			return { ok: true, value: `${width}x${height}` };
		}
		case "output_format":
			if (!OUTPUT_FORMATS.includes(value)) {
				return { ok: false, error: `output_format must be one of: ${OUTPUT_FORMATS.join(", ")}` };
			}
			return { ok: true, value };
		case "watermark":
			return normalizeBoolean("watermark", value);
		case "image_in_result":
			return normalizeBoolean("image_in_result", value);
		case "output_dir":
			if (typeof value !== "string" || value.trim().length === 0) {
				return { ok: false, error: "output_dir must be a non-empty path" };
			}
			return { ok: true, value };
		default:
			return { ok: false, error: `unknown config key "${key}"` };
	}
}

export async function loadImageConfig(configPath) {
	let text;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { ok: true, config: {} };
		return { ok: false, error: `cannot read config file ${configPath}: ${error instanceof Error ? error.message : String(error)}` };
	}
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, error: `config file ${configPath} is not valid JSON` };
	}
	return validateImageConfig(raw);
}

export async function writeImageConfig(configPath, config) {
	const validated = validateImageConfig(config);
	if (!validated.ok) return validated;
	const dir = dirname(configPath);
	const tmpPath = join(dir, `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`);
	const sorted = {};
	for (const key of Object.keys(validated.config).sort()) sorted[key] = validated.config[key];
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(tmpPath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
		await rename(tmpPath, configPath);
		return { ok: true };
	} catch (error) {
		try {
			await rm(tmpPath, { force: true });
		} catch {}
		return { ok: false, error: `cannot write config file ${configPath}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// --- /sensenova-image argument parsing ---

/** Split arguments into tokens. Quotes group a token only at its start (or right after a bare @, for @"C:\..." paths);
 * backslash escapes a quote char or backslash anywhere, so Windows paths and apostrophes stay literal. */
export function tokenizeArgs(args) {
	const tokens = [];
	let current = null;
	let quote = null;
	for (let i = 0; i < args.length; i++) {
		const ch = args[i];
		if (ch === "\\") {
			const next = args[i + 1];
			if (next === quote || next === '"' || next === "'" || next === "\\") {
				current ??= "";
				current += next;
				i++;
				continue;
			}
		}
		if (quote) {
			if (ch === quote) {
				quote = null;
				continue;
			}
			current += ch;
			continue;
		}
		if ((ch === '"' || ch === "'") && (current === null || current === "@")) {
			quote = ch;
			current ??= "";
			continue;
		}
		if (/\s/.test(ch)) {
			if (current !== null) {
				tokens.push(current);
				current = null;
			}
			continue;
		}
		current ??= "";
		current += ch;
	}
	if (current !== null) tokens.push(current);
	return tokens;
}

export function parseImageCommand(args, cwd) {
	const { model, rest: tokens, error } = extractModelFlag(tokenizeArgs(args));
	if (error) return { kind: "error", error };
	const first = tokens[0];
	if (!first) {
		return { kind: "error", error: "usage: /sensenova-image gen|edit|settings …" };
	}
	const subcommand = first;
	if (subcommand === "settings") {
		if (model) return { kind: "error", error: "--model applies only to gen and edit" };
		const settingsTokens = tokens.slice(1);
		if (settingsTokens.length === 0) return { kind: "settings", action: "show" };
		const [keyToken, ...valueTokens] = settingsTokens;
		const key = keyToken;
		if (key === "reset") {
			if (valueTokens.length > 0) return { kind: "error", error: "settings reset takes no value" };
			return { kind: "settings", action: "reset" };
		}
		if (!CONFIG_KEYS.includes(key)) {
			return { kind: "error", error: `unknown setting "${key}" (valid keys: ${CONFIG_KEYS.join(", ")})` };
		}
		if (valueTokens.length === 0) return { kind: "error", error: `missing value for "${key}"` };
		if (valueTokens.length > 1) {
			return { kind: "error", error: `settings ${key} takes one value; quote values containing spaces` };
		}
		return { kind: "settings", action: "set", key, value: valueTokens[0] };
	}
	if (subcommand !== "gen" && subcommand !== "edit") {
		return { kind: "error", error: `unknown subcommand "${subcommand}" (use gen, edit, or settings)` };
	}
	const paths = [];
	const promptParts = [];
	for (const token of tokens.slice(1)) {
		if (token.startsWith("@")) {
			if (subcommand === "gen") {
				return {
					kind: "error",
					error: 'gen is text-to-image; image references need edit (e.g. /sensenova-image edit @file.png "prompt")',
				};
			}
			paths.push(token.slice(1));
		} else if (subcommand === "edit" && isExistingImageFile(token, cwd)) {
			paths.push(token);
		} else {
			promptParts.push(token);
		}
	}
	const prompt = promptParts.join(" ");
	if (subcommand === "edit") {
		if (paths.length === 0) {
			return { kind: "error", error: "edit requires at least one image path; use gen for text-only generation" };
		}
		if (paths.length > MAX_EDIT_IMAGES) {
			return { kind: "error", error: `at most ${MAX_EDIT_IMAGES} images, got ${paths.length}` };
		}
	}
	if (!prompt.trim()) {
		return { kind: "error", error: "a text prompt is required" };
	}
	return { kind: subcommand, prompt, paths, model };
}

function extractModelFlag(tokens) {
	let model;
	const rest = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--model") {
			const value = tokens[i + 1];
			if (!value) return { error: "--model requires a value (e.g. --model sensenova-u1.5-lite)" };
			model = value;
			i++;
			continue;
		}
		rest.push(token);
	}
	if (model) {
		model = { lite: "sensenova-u1.5-lite", fast: "sensenova-u1.5-fast" }[model] ?? model;
		if (!IMAGE_MODELS.some((m) => m.id === model)) {
			return { error: `unknown model "${model}" (use sensenova-u1.5-lite, sensenova-u1.5-fast, lite, or fast)` };
		}
	}
	return { model, rest };
}

function isExistingImageFile(token, cwd) {
	const extension = extname(token).slice(1).toLowerCase();
	if (!IMAGE_FILE_EXTENSIONS.includes(extension)) return false;
	const filePath = isAbsolute(token) ? token : join(cwd, token);
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

// --- command argument completions (subcommands and settings keys/values; @-paths handled by pi's built-in) ---

export function completeImageCommand(prefix) {
	const trimmed = prefix.trimStart();
	const tokens = trimmed === "" ? [] : trimmed.split(/\s+/).filter(Boolean);
	const atTokenStart = /\s$/.test(prefix);
	const [first, ...rest] = tokens;
	if (tokens.length === 0) {
		return SUBCOMMANDS.map((subcommand) => ({
			value: `${subcommand} `,
			label: subcommand,
			description: SUBCOMMAND_DESCRIPTIONS[subcommand],
		}));
	}
	if (atTokenStart) {
		if (first === "settings" && rest.length === 0) {
			return SETTING_ARGS.map((key) => ({ value: `settings ${key} `, label: key }));
		}
		if (first === "settings" && rest.length === 1) {
			return completeSettingValue(rest[0], "");
		}
		return null;
	}
	if (rest.length === 0) {
		const items = SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(first)).map((subcommand) => ({
			value: `${subcommand} `,
			label: subcommand,
			description: SUBCOMMAND_DESCRIPTIONS[subcommand],
		}));
		return items.length > 0 ? items : null;
	}
	if (first === "settings" && rest.length === 1) {
		const items = SETTING_ARGS.filter((key) => key.startsWith(rest[0])).map((key) => ({
			value: `settings ${key} `,
			label: key,
		}));
		return items.length > 0 ? items : null;
	}
	if (first === "settings" && rest.length === 2) {
		return completeSettingValue(rest[0], rest[1]);
	}
	return null;
}

function completeSettingValue(key, prefix) {
	const values = {
		model: IMAGE_MODELS.map((m) => m.id),
		size: ["auto", "1024x1024"],
		output_format: OUTPUT_FORMATS,
		watermark: ["true", "false"],
		image_in_result: ["true", "false"],
	}[key];
	if (!values) return null;
	const items = values
		.filter((value) => value.startsWith(prefix))
		.map((value) => ({ value: `settings ${key} ${value}`, label: value }));
	return items.length > 0 ? items : null;
}

const SETTING_ARGS = [...CONFIG_KEYS, "reset"];

// --- /sensenova-image command ---

async function resolveModelAndAuth(ctx, modelId) {
	const model = ctx.modelRegistry.getModelOfType("image", PROVIDER_ID, modelId);
	if (!model) return { error: `image model "${modelId}" is not in the catalog` };
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return {
			error: `no API key for provider "${PROVIDER_ID}"; run /login and choose "SenseNova Images", or set $SENSENOVA_API_KEY`,
		};
	}
	return { model, apiKey: auth.apiKey };
}

// Shared by the chat tool and the command.
async function runImageGeneration(ctx, { prompt, imagePaths, explicitModel, configPath, fetch, now, signal, onStart }) {
	const loaded = await loadImageConfig(configPath);
	const config = loaded.ok ? loaded.config : {};
	const imageConfig = resolveImageConfig(config);
	const modelId = explicitModel ?? config.model ?? DEFAULT_MODEL;
	const resolved = await resolveModelAndAuth(ctx, modelId);
	if (resolved.error) return { status: "error", message: resolved.error };
	const input = [{ type: "text", text: prompt }];
	if (imagePaths.length > 0) {
		try {
			input.push(...(await readImageBlocks(imagePaths, ctx.cwd)));
		} catch (error) {
			return { status: "error", message: error instanceof Error ? error.message : String(error) };
		}
	}
	onStart?.(modelId);
	const result = await generateImages(
		resolved.model,
		{ input },
		{ apiKey: resolved.apiKey, signal, fetch, config: imageConfig },
	);
	if (result.stopReason === "aborted") return { status: "error", message: "image generation aborted" };
	if (result.stopReason === "error" && result.errorMessage) return { status: "error", message: result.errorMessage };
	const image = result.output[0];
	if (!image || image.type !== "image") return { status: "error", message: "image generation returned no image data" };
	try {
		const filePath = await saveImageFile(
			ctx.cwd,
			prompt,
			image,
			now,
			imageConfig.output_format,
			config.output_dir ?? IMAGE_DIR_NAME,
		);
		return {
			status: "ok",
			modelId,
			filePath,
			configError: loaded.ok ? null : loaded.error,
			imageInResult: imageConfig.image_in_result,
			imageData: image.data,
			imageMimeType: image.mimeType,
		};
	} catch (error) {
		return { status: "error", message: `failed to save image: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function createGenerateImageCommand(options = {}) {
	return {
		description:
			'Generate or edit images with SenseNova U1.5: gen "a white seal" (text-to-image), edit @photo.png "make it winter" (image-to-image, up to 5 @-paths, first is the main edit target), or settings to view or change saved defaults (model, size, output_format, watermark, output_dir, image_in_result). --model sensenova-u1.5-lite gives higher quality for one call.',
		getArgumentCompletions: (prefix) => completeImageCommand(prefix),
		async handler(args, ctx) {
			const parsed = parseImageCommand(args, ctx.cwd);
			if (parsed.kind === "error") {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const configPath = options.configPath ?? defaultConfigPath();
			if (parsed.kind === "settings") {
				await handleSettings(parsed, configPath, ctx);
				return;
			}
			const startedAt = Date.now();
			let run;
			try {
				run = await runImageGeneration(ctx, {
					prompt: parsed.prompt,
					imagePaths: parsed.paths,
					explicitModel: parsed.model,
					configPath,
					fetch: options.fetch,
					now: options.now ? options.now() : new Date(),
					signal: ctx.signal,
					onStart: (modelId) => {
						if (ctx.hasUI) ctx.ui.setStatus("sensenova", `Generating image (${modelId})…`);
					},
				});
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("sensenova", undefined);
			}
			if (run.status === "error") {
				ctx.ui.notify(run.message, "error");
				return;
			}
			if (run.configError) {
				ctx.ui.notify(`${run.configError} — using defaults for this call`, "warning");
			}
			const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
			ctx.ui.notify(
				`Image ${parsed.kind === "edit" ? "edited" : "generated"} and saved to ${run.filePath} (${run.modelId}, ${elapsed}s)`,
				"info",
			);
		},
	};
}

async function handleSettings(parsed, configPath, ctx) {
	if (parsed.action === "show") {
		const loaded = await loadImageConfig(configPath);
		const config = loaded.ok ? loaded.config : {};
		const display = (key, fallback) => {
			const value = key in config ? config[key] : fallback;
			return `${value}${key in config ? " (saved)" : " (default)"}`;
		};
		const lines = [
			"SenseNova image defaults (effective):",
			`  model:           ${display("model", DEFAULT_MODEL)}`,
			`  size:            ${display("size", IMAGE_CONSTANTS.size)}`,
			`  output_format:   ${display("output_format", IMAGE_CONSTANTS.output_format)}`,
			`  watermark:       ${display("watermark", IMAGE_CONSTANTS.watermark)}`,
			`  output_dir:      ${display("output_dir", IMAGE_DIR_NAME)}`,
			`  image_in_result: ${display("image_in_result", IMAGE_CONSTANTS.image_in_result)}`,
			`Config file: ${configPath}`,
		];
		if (!loaded.ok) lines.push(`${loaded.error} — using defaults`);
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}
	if (parsed.action === "reset") {
		const result = await writeImageConfig(configPath, {});
		if (!result.ok) {
			ctx.ui.notify(result.error, "error");
			return;
		}
		ctx.ui.notify(`Reset: image defaults restored (${configPath})`, "info");
		return;
	}
	const existing = await loadImageConfig(configPath);
	if (!existing.ok) {
		ctx.ui.notify(`${existing.error} — overwriting with a fresh config`, "warning");
	}
	const base = existing.ok ? existing.config : {};
	const normalized = normalizeConfigValue(parsed.key, parsed.value);
	if (!normalized.ok) {
		ctx.ui.notify(normalized.error, "error");
		return;
	}
	const result = await writeImageConfig(configPath, { ...base, [parsed.key]: normalized.value });
	if (!result.ok) {
		ctx.ui.notify(result.error, "error");
		return;
	}
	ctx.ui.notify(`Saved ${parsed.key} = ${String(normalized.value)} in ${configPath}`, "info");
}

export default function (pi) {
	pi.registerProvider(PROVIDER_ID, {
		name: "SenseNova Images",
		apiKey: "$SENSENOVA_API_KEY",
		models: IMAGE_MODELS.map(({ id, name }) => imageModel(id, name)),
		images: { "sensenova-images": { generateImages } },
	});
	pi.registerTool(createGenerateImageTool());
	pi.registerCommand("sensenova-image", createGenerateImageCommand());
}