import test from "node:test";
import assert from "node:assert/strict";
import { generateImages } from "./sensenova-images.mjs";

const BASE_URL = "https://token.sensenova.cn/v1";

function makeModel(id = "sensenova-u1.5-lite") {
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

function fetchRecorder(response, { status = 200, throwOnCall = null } = {}) {
	const calls = [];
	const impl = async (url, init = {}) => {
		calls.push({ url, init });
		if (throwOnCall) throw throwOnCall;
		return { ok: status >= 200 && status < 300, status, json: async () => response };
	};
	return { calls, impl };
}

function okResponse(payload = {}) {
	return {
		created: 1788849614,
		data: [{ b64_json: "iVBORw0KGgo=" }],
		output_format: "png",
		size: "2048x2048",
		usage: { input_tokens: 1540, output_tokens: 4096, total_tokens: 5636, images_count: 1 },
		...payload,
	};
}

function imageBlock(mimeType = "image/png", data = "AAAA") {
	return { type: "image", mimeType, data };
}

test("text-only input posts to /images/generations with the agreed constants", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	const result = await generateImages(makeModel(), { input: [{ type: "text", text: "a white seal" }] }, { apiKey: "sk-test", fetch: impl });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `${BASE_URL}/images/generations`);
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
	const body = JSON.parse(calls[0].init.body);
	assert.deepEqual(body, {
		model: "sensenova-u1.5-lite",
		prompt: "a white seal",
		n: 1,
		size: "auto",
		watermark: false,
		output_format: "png",
		response_format: "b64_json",
	});
	assert.equal(result.stopReason, "stop");
});

test("image input posts to /images/edits with reference images as base64 data URLs", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	const context = {
		input: [
			{ type: "text", text: "put it on a glacier" },
			imageBlock(),
			{ type: "text", text: "keep the pose" },
			imageBlock("image/jpeg", "BBBB"),
		],
	};
	const result = await generateImages(makeModel(), context, { apiKey: "sk-test", fetch: impl });

	assert.equal(calls[0].url, `${BASE_URL}/images/edits`);
	const body = JSON.parse(calls[0].init.body);
	assert.equal(body.prompt, "put it on a glacier\nkeep the pose");
	assert.deepEqual(body.images, [
		{ image_url: "data:image/png;base64,AAAA" },
		{ image_url: "data:image/jpeg;base64,BBBB" },
	]);
	assert.equal(result.stopReason, "stop");
});

test("b64_json response maps to an image output block with usage and zero cost", async () => {
	const { impl } = fetchRecorder(okResponse());
	const result = await generateImages(
		makeModel(),
		{ input: [{ type: "text", text: "a white seal" }] },
		{ apiKey: "sk-test", fetch: impl },
	);

	assert.equal(result.api, "sensenova-images");
	assert.equal(result.provider, "sensenova-images");
	assert.equal(result.model, "sensenova-u1.5-lite");
	assert.deepEqual(result.output, [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
	assert.equal(result.usage.input, 1540);
	assert.equal(result.usage.output, 4096);
	assert.equal(result.usage.totalTokens, 5636);
	assert.deepEqual(result.usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("non-2xx response becomes an error result with a readable message", async () => {
	const { impl } = fetchRecorder({ error: { message: "invalid prompt" } }, { status: 400 });
	const result = await generateImages(
		makeModel(),
		{ input: [{ type: "text", text: "x" }] },
		{ apiKey: "sk-test", fetch: impl },
	);

	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /400/);
	assert.match(result.errorMessage, /invalid prompt/);
});

test("aborted signal becomes an aborted result", async () => {
	const abortError = new Error("The operation was aborted");
	abortError.name = "AbortError";
	const { impl } = fetchRecorder(null, { throwOnCall: abortError });
	const signal = AbortSignal.abort();
	const result = await generateImages(
		makeModel(),
		{ input: [{ type: "text", text: "x" }] },
		{ apiKey: "sk-test", fetch: impl, signal },
	);

	assert.equal(result.stopReason, "aborted");
});

test("missing API key becomes an error result", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	const result = await generateImages(makeModel(), { input: [{ type: "text", text: "x" }] }, { fetch: impl });

	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /API key/);
	assert.equal(calls.length, 0);
});

test("missing prompt becomes an error result without a network call", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	const result = await generateImages(makeModel(), { input: [] }, { apiKey: "sk-test", fetch: impl });

	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /prompt/);
	assert.equal(calls.length, 0);
});