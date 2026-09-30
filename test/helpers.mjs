import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BASE_URL = "https://token.sensenova.cn/v1";

export const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);
export const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
export const TINY_WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
export const TINY_GIF = Buffer.from("GIF89a".padEnd(16, "\0"));

export async function withTempCwd(run) {
	const cwd = await mkdtemp(join(tmpdir(), "sensenova-test-"));
	try {
		return await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

export function fetchRecorder(response, { status = 200, throwOnCall = null } = {}) {
	const calls = [];
	const impl = async (url, init = {}) => {
		calls.push({ url, init });
		if (throwOnCall) throw throwOnCall;
		return { ok: status >= 200 && status < 300, status, json: async () => response };
	};
	return { calls, impl };
}

export function okResponse(payload = {}) {
	return {
		created: 1788849614,
		data: [{ b64_json: "iVBORw0KGgo=" }],
		output_format: "png",
		size: "2048x2048",
		usage: { input_tokens: 1540, output_tokens: 4096, total_tokens: 5636, images_count: 1 },
		...payload,
	};
}

export function makeModel(id = "sensenova-u1.5-fast") {
	return {
		provider: "sensenova-images",
		api: "sensenova-images",
		id,
		name: id,
		baseUrl: BASE_URL,
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

export function abortException() {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}
