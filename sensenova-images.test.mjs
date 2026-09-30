import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGenerateImageTool, generateImages } from "./sensenova-images.ts";

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
	const { impl } = fetchRecorder(null, { throwOnCall: abortException() });
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

// --- sensenova_generate_image tool ---

const NOW = new Date(2026, 8, 30, 10, 15, 30);

function abortException() {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

function toolContext({ model = makeModel("sensenova-u1.5-fast"), apiKey = "sk-test", cwd }) {
	return {
		cwd,
		modelRegistry: {
			getModelOfType: (_type, _provider, modelId) => (model && model.id === modelId ? model : undefined),
			getApiKeyAndHeaders: async () => (apiKey ? { ok: true, apiKey } : { ok: false, error: "No API key found" }),
		},
	};
}

async function withTempCwd(run) {
	const cwd = await mkdtemp(join(tmpdir(), "sensenova-test-"));
	try {
		return await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function makeTool(impl) {
	return createGenerateImageTool({ fetch: impl, now: () => NOW });
}

test("tool generates with the default model and saves the PNG under .sensenova/", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	const tool = makeTool(impl);
	await withTempCwd(async (cwd) => {
		const result = await tool.execute("call-1", { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd }));

		assert.equal(result.isError, undefined);
		assert.equal(result.details.model, "sensenova-u1.5-fast");
		const expectedPath = join(cwd, ".sensenova", "20260930-101530-000-a-white-seal.png");
		assert.equal(result.details.path, expectedPath);
		assert.equal(result.content[0].text, `Image generated and saved to ${expectedPath}`);

		const written = await readFile(expectedPath);
		assert.deepEqual(written, Buffer.from("iVBORw0KGgo=", "base64"));
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, `${BASE_URL}/images/generations`);
		const body = JSON.parse(calls[0].init.body);
		assert.equal(body.model, "sensenova-u1.5-fast");
		assert.equal(body.prompt, "a white seal");
		assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
	});
});

test("tool honors an explicit model parameter", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	const tool = makeTool(impl);
	await withTempCwd(async (cwd) => {
		const result = await tool.execute(
			"call-1",
			{ prompt: "a white seal", model: "sensenova-u1.5-lite" },
			undefined,
			undefined,
			toolContext({ cwd, model: makeModel("sensenova-u1.5-lite") }),
		);

		assert.equal(result.details.model, "sensenova-u1.5-lite");
		const body = JSON.parse(calls[0].init.body);
		assert.equal(body.model, "sensenova-u1.5-lite");
	});
});

test("tool filenames slug the prompt and fall back to image for non-ASCII prompts", async () => {
	const { impl } = fetchRecorder(okResponse());
	const tool = makeTool(impl);
	await withTempCwd(async (cwd) => {
		const ascii = await tool.execute("call-1", { prompt: "A 白 seal, Arch!" }, undefined, undefined, toolContext({ cwd }));
		assert.equal(ascii.details.path, join(cwd, ".sensenova", "20260930-101530-000-a-seal-arch.png"));

		const chinese = await tool.execute("call-2", { prompt: "一只白色海豹" }, undefined, undefined, toolContext({ cwd }));
		assert.equal(chinese.details.path, join(cwd, ".sensenova", "20260930-101530-000-image.png"));
	});
});

test("tool reports a missing API key without calling the network", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	const tool = makeTool(impl);
	await withTempCwd(async (cwd) => {
		const result = await tool.execute("call-1", { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd, apiKey: null }));

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /API key/);
		assert.equal(calls.length, 0);
	});
});

test("tool reports a missing catalog model without calling the network", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	const tool = makeTool(impl);
	await withTempCwd(async (cwd) => {
		const result = await tool.execute("call-1", { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd, model: null }));

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /catalog/);
		assert.equal(calls.length, 0);
	});
});

test("tool surfaces a provider error and does not write a file", async () => {
	const { calls, impl } = fetchRecorder({ error: { message: "invalid prompt" } }, { status: 400 });
	const tool = makeTool(impl);
	await withTempCwd(async (cwd) => {
		const result = await tool.execute("call-1", { prompt: "x" }, undefined, undefined, toolContext({ cwd }));

		assert.equal(result.isError, true);
		assert.equal(result.content[0].text, "SenseNova Images: HTTP 400 invalid prompt");
		assert.equal(calls.length, 1);
		assert.equal(result.details, undefined);
	});
});

test("tool reports an aborted generation as an error result", async () => {
	const { impl } = fetchRecorder(null, { throwOnCall: abortException() });
	const tool = makeTool(impl);
	await withTempCwd(async (cwd) => {
		const result = await tool.execute("call-1", { prompt: "a white seal" }, AbortSignal.abort(), undefined, toolContext({ cwd }));

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /aborted/i);
	});
});