const SENSENOVA_BASE_URL = "https://token.sensenova.cn/v1";

const IMAGE_CONSTANTS = {
	n: 1,
	size: "auto",
	watermark: false,
	output_format: "png",
	response_format: "b64_json",
};

const ERROR_PREFIX = "SenseNova Images: ";

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

export default function (pi) {
	pi.registerProvider("sensenova-images", {
		name: "SenseNova Images",
		apiKey: "$SENSENOVA_API_KEY",
		models: [imageModel("sensenova-u1.5-lite", "SenseNova U1.5 Lite"), imageModel("sensenova-u1.5-fast", "SenseNova U1.5 Fast")],
		images: { "sensenova-images": { generateImages } },
	});
}