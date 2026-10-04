import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	abortException,
	BASE_URL,
	fetchRecorder,
	makeModel,
	NOW,
	okResponse,
	TINY_GIF,
	TINY_JPEG,
	TINY_PNG,
	TINY_WEBP,
	withTempCwd,
} from "./helpers.mjs";
import { createGenerateImageTool, generateImages, readImageBlocks } from "../extensions/sensenova-images.ts";

function imageBlock(mimeType = "image/png", data = "AAAA") {
	return { type: "image", mimeType, data };
}

test("text-only input posts to /images/generations with the agreed constants", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	const result = await generateImages(
		makeModel("sensenova-u1.5-lite"),
		{ input: [{ type: "text", text: "a white seal" }] },
		{ apiKey: "sk-test", fetch: impl },
	);

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
		makeModel("sensenova-u1.5-lite"),
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

function toolContext({ model = makeModel("sensenova-u1.5-fast"), apiKey = "sk-test", cwd }) {
	return {
		cwd,
		modelRegistry: {
			getModelOfType: (_type, _provider, modelId) => (model && model.id === modelId ? model : undefined),
			getApiKeyAndHeaders: async () => (apiKey ? { ok: true, apiKey } : { ok: false, error: "No API key found" }),
		},
	};
}

function makeTool(impl, configPath) {
	return createGenerateImageTool({ fetch: impl, now: () => NOW, configPath });
}

test("tool generates with the default model and saves the PNG under .sensenova/", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const result = await tool.execute("call-1", { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd }));

		assert.equal(result.isError, undefined);
		assert.equal(result.details.model, "sensenova-u1.5-fast");
		const expectedPath = join(cwd, ".sensenova", "20260930-101530-000-a-white-seal.png");
		assert.equal(result.details.path, expectedPath);
		assert.equal(result.content.length, 1); // image_in_result defaults to off: text only
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

test("tool includes the image block when image_in_result is enabled", async () => {
	const { impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeFile(configPath, JSON.stringify({ image_in_result: true }), "utf8");
		const tool = makeTool(impl, configPath);
		const result = await tool.execute("call-1", { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd }));

		assert.equal(result.content.length, 2);
		assert.equal(result.content[0].type, "text");
		assert.deepEqual(result.content[1], { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
	});
});

test("tool omits the image block when image_in_result is explicitly false", async () => {
	const { impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeFile(configPath, JSON.stringify({ image_in_result: false }), "utf8");
		const tool = makeTool(impl, configPath);
		const result = await tool.execute("call-1", { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd }));

		assert.equal(result.content.length, 1);
		assert.equal(result.content[0].type, "text");
	});
});

test("tool honors an explicit model parameter", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
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

test("tool does not overwrite on same-ms same-prompt calls: distinct files with a numeric suffix", async () => {
	const { impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const first = await tool.execute("call-1", { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd }));
		const second = await tool.execute("call-2", { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd }));

		const files = await readdir(join(cwd, ".sensenova"));
		assert.equal(files.length, 2);
		assert.equal(first.details.path, join(cwd, ".sensenova", "20260930-101530-000-a-white-seal.png"));
		assert.equal(second.details.path, join(cwd, ".sensenova", "20260930-101530-000-a-white-seal-2.png"));
	});
});

test("tool does not overwrite under concurrent calls racing for the same path", async () => {
	const { impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const results = await Promise.all(
			Array.from({ length: 4 }, (_v, i) => tool.execute(`call-${i}`, { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd }))),
		);

		const files = await readdir(join(cwd, ".sensenova"));
		assert.equal(files.length, 4);
		assert.equal(new Set(results.map((r) => r.details.path)).size, 4);
	});
});

test("tool filenames slug the prompt and fall back to image for non-ASCII prompts", async () => {
	const { impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const ascii = await tool.execute("call-1", { prompt: "A 白 seal, Arch!" }, undefined, undefined, toolContext({ cwd }));
		assert.equal(ascii.details.path, join(cwd, ".sensenova", "20260930-101530-000-a-seal-arch.png"));

		const chinese = await tool.execute("call-2", { prompt: "一只白色海豹" }, undefined, undefined, toolContext({ cwd }));
		assert.equal(chinese.details.path, join(cwd, ".sensenova", "20260930-101530-000-image.png"));
	});
});

test("tool reports a missing API key without calling the network", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const result = await tool.execute("call-1", { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd, apiKey: null }));

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /API key/);
		assert.equal(calls.length, 0);
	});
});

test("tool reports a missing catalog model without calling the network", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const result = await tool.execute("call-1", { prompt: "a white seal" }, undefined, undefined, toolContext({ cwd, model: null }));

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /catalog/);
		assert.equal(calls.length, 0);
	});
});

test("tool surfaces a provider error and does not write a file", async () => {
	const { calls, impl } = fetchRecorder({ error: { message: "invalid prompt" } }, { status: 400 });
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const result = await tool.execute("call-1", { prompt: "x" }, undefined, undefined, toolContext({ cwd }));

		assert.equal(result.isError, true);
		assert.equal(result.content[0].text, "SenseNova Images: HTTP 400 invalid prompt");
		assert.equal(calls.length, 1);
		assert.equal(result.details, undefined);
	});
});

test("tool reports an aborted generation as an error result", async () => {
	const { impl } = fetchRecorder(null, { throwOnCall: abortException() });
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const result = await tool.execute("call-1", { prompt: "a white seal" }, AbortSignal.abort(), undefined, toolContext({ cwd }));

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /aborted/i);
	});
});

// --- readImageBlocks (edits reference images) ---

function tinyBmp() {
	const bmp = Buffer.alloc(54);
	bmp.write("BM", 0, "ascii");
	bmp.writeUInt32LE(0, 2); // declared file size: 0 means unset, checks skipped
	bmp.writeUInt32LE(54, 10); // pixel data offset
	bmp.writeUInt32LE(40, 14); // BITMAPINFOHEADER
	bmp.writeUInt32LE(1, 18); // width
	bmp.writeUInt32LE(1, 22); // height
	bmp.writeUInt16LE(1, 26); // color planes
	bmp.writeUInt16LE(24, 28); // bits per pixel
	return bmp;
}

test("readImageBlocks maps file bytes to mime types and base64 data", async () => {
	await withTempCwd(async (cwd) => {
		const files = [
			["photo.png", TINY_PNG, "image/png"],
			["photo.jpg", TINY_JPEG, "image/jpeg"],
			["photo.webp", TINY_WEBP, "image/webp"],
			["photo.gif", TINY_GIF, "image/gif"],
			["photo.bmp", tinyBmp(), "image/bmp"],
		];
		const targets = [];
		for (const [name, bytes] of files) {
			const filePath = join(cwd, name);
			await writeFile(filePath, bytes);
			targets.push(filePath);
		}

		const blocks = await readImageBlocks(targets, cwd);

		assert.deepEqual(
			blocks.map(({ type, mimeType, data }) => ({ type, mimeType, data: Buffer.from(data, "base64") })),
			files.map(([_name, bytes, mimeType]) => ({ type: "image", mimeType, data: bytes })),
		);
	});
});

test("tool edits reference images via /images/edits and reports the saved path", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		await writeFile(join(cwd, "main.png"), TINY_PNG);
		await writeFile(join(cwd, "ref.jpg"), TINY_JPEG);
		const result = await tool.execute(
			"call-1",
			{ prompt: "put it on a glacier", image_paths: ["main.png", "ref.jpg"] },
			undefined,
			undefined,
			toolContext({ cwd }),
		);

		assert.equal(result.isError, undefined);
		assert.equal(
			result.content[0].text,
			`Image edited and saved to ${join(cwd, ".sensenova", "20260930-101530-000-put-it-on-a-glacier.png")}`,
		);
		assert.equal(result.details.path, join(cwd, ".sensenova", "20260930-101530-000-put-it-on-a-glacier.png"));
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, `${BASE_URL}/images/edits`);
		const body = JSON.parse(calls[0].init.body);
		assert.deepEqual(body.images, [
			{ image_url: `data:image/png;base64,${TINY_PNG.toString("base64")}` },
			{ image_url: `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}` },
		]);
	});
});

test("tool rejects more than 5 image_paths without a network call", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const result = await tool.execute(
			"call-1",
			{ prompt: "x", image_paths: ["1.png", "2.png", "3.png", "4.png", "5.png", "6.png"] },
			undefined,
			undefined,
			toolContext({ cwd }),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /at most 5 images, got 6/);
		assert.equal(calls.length, 0);
	});
});

test("tool rejects malformed image_paths without a network call", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const nonArray = await tool.execute("call-1", { prompt: "x", image_paths: "main.png" }, undefined, undefined, toolContext({ cwd }));
		const emptyEntry = await tool.execute("call-1", { prompt: "x", image_paths: [""] }, undefined, undefined, toolContext({ cwd }));

		assert.equal(nonArray.isError, true);
		assert.match(nonArray.content[0].text, /array of non-empty file paths/);
		assert.equal(emptyEntry.isError, true);
		assert.match(emptyEntry.content[0].text, /array of non-empty file paths/);
		assert.equal(calls.length, 0);
	});
});

test("tool reports a missing image file without a network call", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		const result = await tool.execute(
			"call-1",
			{ prompt: "x", image_paths: ["missing.png"] },
			undefined,
			undefined,
			toolContext({ cwd }),
		);

		assert.equal(result.isError, true);
		assert.equal(result.content[0].text, 'SenseNova Images: cannot read image file "missing.png"');
		assert.equal(calls.length, 0);
	});
});

test("tool reports a non-image file without a network call", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const tool = makeTool(impl, join(cwd, "sensenova-compat.json"));
		await writeFile(join(cwd, "notes.txt"), "not an image");
		// A RIFF container that is not WEBP must not pass the webp sniff.
		await writeFile(
			join(cwd, "sound.wav"),
			Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)]),
		);
		const notes = await tool.execute("call-1", { prompt: "x", image_paths: ["notes.txt"] }, undefined, undefined, toolContext({ cwd }));
		const wav = await tool.execute("call-2", { prompt: "x", image_paths: ["sound.wav"] }, undefined, undefined, toolContext({ cwd }));

		assert.equal(notes.isError, true);
		assert.match(notes.content[0].text, /not a supported image/);
		assert.equal(wav.isError, true);
		assert.match(wav.content[0].text, /not a supported image/);
		assert.equal(calls.length, 0);
	});
});