import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BASE_URL,
	fetchRecorder,
	makeModel,
	okResponse,
	TINY_JPEG,
	TINY_PNG,
	withTempCwd,
} from "./helpers.mjs";
import {
	completeImageCommand,
	createGenerateImageCommand,
	createGenerateImageTool,
	loadImageConfig,
	parseImageCommand,
	resolveAgentDir,
	resolveImageConfig,
	tokenizeArgs,
	validateImageConfig,
	writeImageConfig,
} from "../extensions/sensenova-images.ts";

// --- tokenizeArgs ---

test("tokenizeArgs splits on whitespace and keeps quoted phrases intact", () => {
	assert.deepEqual(tokenizeArgs('gen "a white seal" on ice'), ["gen", "a white seal", "on", "ice"]);
});

test("tokenizeArgs preserves backslashes in Windows paths", () => {
	assert.deepEqual(tokenizeArgs('edit @"C:\\Users\\Hue\\photo.png" "make it winter"'), [
		"edit",
		"@C:\\Users\\Hue\\photo.png",
		"make it winter",
	]);
});

test("tokenizeArgs escapes only the active quote and backslash inside quotes", () => {
	assert.deepEqual(tokenizeArgs('gen "say \\"hi\\""'), ["gen", 'say "hi"']);
	assert.deepEqual(tokenizeArgs("gen 'it\\'s' it\\'s"), ["gen", "it's", "it's"]);
});

// --- parseImageCommand ---

test("gen parses a quoted prompt", () => {
	assert.deepEqual(parseImageCommand('gen "a white seal"', "C:/work"), {
		kind: "gen",
		prompt: "a white seal",
		paths: [],
		model: undefined,
	});
});

test("gen joins unquoted words into one prompt", () => {
	assert.deepEqual(parseImageCommand("gen a white seal on ice", "C:/work"), {
		kind: "gen",
		prompt: "a white seal on ice",
		paths: [],
		model: undefined,
	});
});

test("gen strips --model at any position", () => {
	const withModelFirst = parseImageCommand('--model sensenova-u1.5-lite gen "a seal"', "C:/work");
	const withModelLast = parseImageCommand('gen "a seal" --model sensenova-u1.5-lite', "C:/work");
	assert.deepEqual(withModelFirst, { kind: "gen", prompt: "a seal", paths: [], model: "sensenova-u1.5-lite" });
	assert.deepEqual(withModelLast, { kind: "gen", prompt: "a seal", paths: [], model: "sensenova-u1.5-lite" });
});

test("gen rejects --model without a value", () => {
	const parsed = parseImageCommand('gen "a seal" --model', "C:/work");
	assert.equal(parsed.kind, "error");
	assert.match(parsed.error, /--model requires a value/);
});

test("gen accepts the lite and fast shorthands for --model", () => {
	assert.deepEqual(parseImageCommand('gen "a seal" --model lite', "C:/work"), {
		kind: "gen",
		prompt: "a seal",
		paths: [],
		model: "sensenova-u1.5-lite",
	});
	assert.deepEqual(parseImageCommand('--model fast gen "a seal"', "C:/work"), {
		kind: "gen",
		prompt: "a seal",
		paths: [],
		model: "sensenova-u1.5-fast",
	});
});

test("settings rejects --model with a clear error", () => {
	const parsed = parseImageCommand("settings --model sensenova-u1.5-lite", "C:/work");
	assert.equal(parsed.kind, "error");
	assert.match(parsed.error, /--model applies only to gen and edit/);
});

test("gen rejects an unknown model", () => {
	const parsed = parseImageCommand('gen "a seal" --model gpt-4', "C:/work");
	assert.equal(parsed.kind, "error");
	assert.match(parsed.error, /unknown model/);
	assert.match(parsed.error, /sensenova-u1\.5-lite/);
});

test("gen rejects @-tokens with a hint to use edit", () => {
	const parsed = parseImageCommand('gen @photo.png "a seal"', "C:/work");
	assert.equal(parsed.kind, "error");
	assert.match(parsed.error, /edit/);
});

test("gen with no prompt is an error", () => {
	const parsed = parseImageCommand("gen", "C:/work");
	assert.equal(parsed.kind, "error");
	assert.match(parsed.error, /prompt/);
});

test("empty args are an error naming the subcommands", () => {
	const parsed = parseImageCommand("", "C:/work");
	assert.equal(parsed.kind, "error");
	assert.match(parsed.error, /gen|edit|settings/);
});

test("an unknown subcommand is an error", () => {
	const parsed = parseImageCommand("draw a seal", "C:/work");
	assert.equal(parsed.kind, "error");
	assert.match(parsed.error, /unknown subcommand/);
});

test("edit treats @-tokens as paths (first is main target) and the rest as prompt", async () => {
	await withTempCwd(async (cwd) => {
		await writeFile(join(cwd, "main.png"), TINY_PNG);
		await writeFile(join(cwd, "ref.jpg"), TINY_JPEG);
		const parsed = parseImageCommand('edit @main.png @ref.jpg "make the background winter, keep the pose"', cwd);
		assert.deepEqual(parsed, {
			kind: "edit",
			paths: ["main.png", "ref.jpg"],
			prompt: "make the background winter, keep the pose",
			model: undefined,
		});
	});
});

test("edit also treats existing image files without @ as paths", async () => {
	await withTempCwd(async (cwd) => {
		await writeFile(join(cwd, "photo.png"), TINY_PNG);
		const parsed = parseImageCommand('edit photo.png "make it winter"', cwd);
		assert.equal(parsed.kind, "edit");
		assert.deepEqual(parsed.paths, ["photo.png"]);
		assert.equal(parsed.prompt, "make it winter");
	});
});

test("edit keeps non-image and missing files in the prompt", async () => {
	await withTempCwd(async (cwd) => {
		await writeFile(join(cwd, "notes.txt"), "not an image");
		const parsed = parseImageCommand('edit @photo.png notes.txt missing.png "make it winter"', cwd);
		assert.deepEqual(parsed, {
			kind: "edit",
			paths: ["photo.png"],
			prompt: "notes.txt missing.png make it winter",
			model: undefined,
		});
	});
});

test("edit splits @-paths even when the prompt contains an apostrophe", async () => {
	await withTempCwd(async (cwd) => {
		await writeFile(join(cwd, "a.png"), TINY_PNG);
		await writeFile(join(cwd, "b.png"), TINY_PNG);
		const parsed = parseImageCommand('edit @a.png it\'s @b.png "make it winter"', cwd);
		assert.deepEqual(parsed, {
			kind: "edit",
			paths: ["a.png", "b.png"],
			prompt: "it's make it winter",
			model: undefined,
		});
	});
});

test("edit rejects more than 5 images", async () => {
	await withTempCwd(async (cwd) => {
		const parsed = parseImageCommand('edit @1.png @2.png @3.png @4.png @5.png @6.png "x"', cwd);
		assert.equal(parsed.kind, "error");
		assert.match(parsed.error, /at most 5 images, got 6/);
	});
});

test("edit with no image paths is an error", () => {
	const parsed = parseImageCommand('edit "make a picture of a seal"', "C:/work");
	assert.equal(parsed.kind, "error");
	assert.match(parsed.error, /at least one image path/);
});

test("edit with paths but no prompt is an error", async () => {
	await withTempCwd(async (cwd) => {
		await writeFile(join(cwd, "main.png"), TINY_PNG);
		const parsed = parseImageCommand("edit @main.png", cwd);
		assert.equal(parsed.kind, "error");
		assert.match(parsed.error, /prompt/);
	});
});

// --- settings parsing ---

test("settings with no arguments is a show action", () => {
	assert.deepEqual(parseImageCommand("settings", "C:/work"), { kind: "settings", action: "show" });
});

test("settings <key> <value> is a set action", () => {
	assert.deepEqual(parseImageCommand("settings watermark true", "C:/work"), {
		kind: "settings",
		action: "set",
		key: "watermark",
		value: "true",
	});
});

test("settings output_dir accepts a quoted multi-word value", () => {
	assert.deepEqual(parseImageCommand('settings output_dir "my images"', "C:/work"), {
		kind: "settings",
		action: "set",
		key: "output_dir",
		value: "my images",
	});
});

test("settings reset is a reset action and rejects extra tokens", () => {
	assert.deepEqual(parseImageCommand("settings reset", "C:/work"), { kind: "settings", action: "reset" });
	const extra = parseImageCommand("settings reset now", "C:/work");
	assert.equal(extra.kind, "error");
	assert.match(extra.error, /takes no value/);
});

test("settings with an unknown key is an error", () => {
	const parsed = parseImageCommand("settings secret 42", "C:/work");
	assert.equal(parsed.kind, "error");
	assert.match(parsed.error, /unknown setting "secret"/);
	assert.match(parsed.error, /output_dir/);
});

test("settings with a key but no value is an error", () => {
	const parsed = parseImageCommand("settings size", "C:/work");
	assert.equal(parsed.kind, "error");
	assert.match(parsed.error, /missing value for "size"/);
});

// --- validateImageConfig ---

test("validateImageConfig accepts a full valid config", () => {
	const result = validateImageConfig({
		model: "sensenova-u1.5-lite",
		size: "1024x1024",
		output_format: "jpeg",
		watermark: true,
		output_dir: "images",
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.config, {
		model: "sensenova-u1.5-lite",
		size: "1024x1024",
		output_format: "jpeg",
		watermark: true,
		output_dir: "images",
	});
});

test("validateImageConfig accepts a partial config and coerces string booleans", () => {
	const result = validateImageConfig({ watermark: "true" });
	assert.equal(result.ok, true);
	assert.deepEqual(result.config, { watermark: true });
});

test("validateImageConfig rejects unknown keys", () => {
	const result = validateImageConfig({ n: 2 });
	assert.equal(result.ok, false);
	assert.match(result.error, /unknown config key "n"/);
});

test("validateImageConfig rejects invalid models, sizes, formats, watermarks, and output_dir", () => {
	assert.equal(validateImageConfig({ model: "gpt-4" }).ok, false);
	assert.equal(validateImageConfig({ model: "sensenova-u1.5-fast" }).ok, true);

	assert.equal(validateImageConfig({ size: "auto" }).ok, true);
	assert.equal(validateImageConfig({ size: "1024x700" }).ok, false); // not a multiple of 32
	assert.equal(validateImageConfig({ size: "512x8192" }).ok, false); // out of range
	assert.equal(validateImageConfig({ size: "4096x512" }).ok, false); // ratio 8:1
	assert.equal(validateImageConfig({ size: "banana" }).ok, false);

	assert.equal(validateImageConfig({ output_format: "png" }).ok, true);
	assert.equal(validateImageConfig({ output_format: "gif" }).ok, false);

	assert.equal(validateImageConfig({ watermark: false }).ok, true);
	assert.equal(validateImageConfig({ watermark: "false" }).ok, true);
	assert.equal(validateImageConfig({ watermark: "yes" }).ok, false);

	assert.equal(validateImageConfig({ output_dir: "img" }).ok, true);
	assert.equal(validateImageConfig({ output_dir: "" }).ok, false);
	assert.equal(validateImageConfig({ output_dir: "   " }).ok, false);
});

test("validateImageConfig rejects non-object input", () => {
	assert.equal(validateImageConfig(null).ok, false);
	assert.equal(validateImageConfig([1, 2]).ok, false);
	assert.equal(validateImageConfig("png").ok, false);
});

// --- loadImageConfig / writeImageConfig ---

test("loadImageConfig returns an empty config for a missing file", async () => {
	const result = await loadImageConfig(join(tmpdir(), "no-such-config.json"));
	assert.deepEqual(result, { ok: true, config: {} });
});

test("loadImageConfig reads a valid file", async () => {
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeFile(configPath, JSON.stringify({ model: "sensenova-u1.5-lite", watermark: true }));
		const result = await loadImageConfig(configPath);
		assert.deepEqual(result, { ok: true, config: { model: "sensenova-u1.5-lite", watermark: true } });
	});
});

test("loadImageConfig reports corrupt JSON as an error", async () => {
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeFile(configPath, "{ not json");
		const result = await loadImageConfig(configPath);
		assert.equal(result.ok, false);
		assert.match(result.error, /not valid JSON/);
	});
});

test("loadImageConfig reports an invalid schema as an error", async () => {
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeFile(configPath, JSON.stringify({ model: "gpt-4" }));
		const result = await loadImageConfig(configPath);
		assert.equal(result.ok, false);
		assert.match(result.error, /model must be one of/);
	});
});

test("writeImageConfig writes sorted JSON with a newline and creates parent dirs", async () => {
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "deep", "nested", "sensenova-compat.json");
		const result = await writeImageConfig(configPath, { watermark: true, model: "sensenova-u1.5-lite" });
		assert.equal(result.ok, true);
		const text = await readFile(configPath, "utf8");
		assert.equal(text, JSON.stringify({ model: "sensenova-u1.5-lite", watermark: true }, null, 2) + "\n");
	});
});

test("writeImageConfig overwrites an existing file and leaves no temp files", async () => {
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeFile(configPath, JSON.stringify({ size: "1024x1024" }));
		const result = await writeImageConfig(configPath, { size: "auto" });
		assert.equal(result.ok, true);
		const loaded = await loadImageConfig(configPath);
		assert.deepEqual(loaded.config, { size: "auto" });
		const leftovers = (await readDirSafe(cwd)).filter((name) => name.endsWith(".tmp"));
		assert.deepEqual(leftovers, []);
	});
});

test("writeImageConfig rejects invalid values without writing", async () => {
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		const result = await writeImageConfig(configPath, { size: "banana" });
		assert.equal(result.ok, false);
		await assert.rejects(readFile(configPath));
	});
});

async function readDirSafe(dir) {
	const { readdir } = await import("node:fs/promises");
	return readdir(dir);
}

// --- resolveAgentDir ---

test("resolveAgentDir honors PI_CODING_AGENT_DIR and falls back to ~/.pi/agent", () => {
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "C:/custom/agent" }), "C:/custom/agent");
	const fallback = resolveAgentDir({});
	assert.match(fallback, /\.pi[\\/]agent$/);
});

// --- completeImageCommand ---

test("completeImageCommand offers subcommands on empty or partial input", () => {
	const empty = completeImageCommand("");
	assert.deepEqual(empty.map((i) => i.label), ["gen", "edit", "settings"]);
	const partial = completeImageCommand("set");
	assert.deepEqual(partial.map((i) => i.label), ["settings"]);
	assert.equal(partial[0].value, "settings ");
});

test("completeImageCommand completes settings keys with the full replacement text", () => {
	const items = completeImageCommand("settings m");
	assert.deepEqual(items.map((i) => ({ label: i.label, value: i.value })), [
		{ label: "model", value: "settings model " },
	]);
});

test("completeImageCommand completes settings values", () => {
	assert.deepEqual(completeImageCommand("settings model sensenova-u1.5-l").map((i) => i.value), [
		"settings model sensenova-u1.5-lite",
	]);
	assert.deepEqual(completeImageCommand("settings output_format ").map((i) => i.label), ["png", "jpeg", "webp"]);
	assert.deepEqual(completeImageCommand("settings watermark t").map((i) => i.value), ["settings watermark true"]);
	assert.deepEqual(completeImageCommand("settings size ").map((i) => i.label), ["auto", "1024x1024"]);
});

test("completeImageCommand returns null where no completion applies", () => {
	assert.equal(completeImageCommand("gen a seal"), null);
	assert.equal(completeImageCommand("edit @main.png"), null);
	assert.equal(completeImageCommand("settings output_dir im"), null);
	assert.equal(completeImageCommand("settings model sensenova-u1.5-lite extra"), null);
	assert.equal(completeImageCommand("unknown sub"), null);
});

// --- resolveImageConfig ---

test("resolveImageConfig applies constants < config < explicit precedence", () => {
	const base = resolveImageConfig({});
	assert.deepEqual(base, { n: 1, size: "auto", watermark: false, output_format: "png", response_format: "b64_json" });

	const withConfig = resolveImageConfig({ size: "1024x1024", watermark: true, output_format: "jpeg" });
	assert.equal(withConfig.size, "1024x1024");
	assert.equal(withConfig.watermark, true);
	assert.equal(withConfig.output_format, "jpeg");

	const withExplicit = resolveImageConfig({ size: "1024x1024" }, { size: "2048x2048" });
	assert.equal(withExplicit.size, "2048x2048");
});

// --- /sensenova-image command handler ---

const NOW = new Date(2026, 8, 30, 10, 15, 30);

function fakeContext({ cwd, model = makeModel(), apiKey = "sk-test" }) {
	const notify = [];
	const status = [];
	const ctx = {
		cwd,
		hasUI: true,
		signal: undefined,
		ui: {
			notify: (message, type = "info") => notify.push({ message, type }),
			setStatus: (key, text) => status.push({ key, text }),
		},
		modelRegistry: {
			getModelOfType: (_type, _provider, modelId) => (model && model.id === modelId ? model : undefined),
			getApiKeyAndHeaders: async () => (apiKey ? { ok: true, apiKey } : { ok: false, error: "no key" }),
		},
	};
	return { ctx, notify, status };
}

function makeCommand(impl, configPath) {
	return createGenerateImageCommand({ fetch: impl, now: () => NOW, configPath });
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("command generates with defaults, sets then clears the status, and notifies the saved path", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const command = makeCommand(impl, join(cwd, "sensenova-compat.json"));
		const { ctx, notify, status } = fakeContext({ cwd });
		await command.handler('gen "a white seal"', ctx);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, `${BASE_URL}/images/generations`);
		const body = JSON.parse(calls[0].init.body);
		assert.equal(body.model, "sensenova-u1.5-fast");
		assert.equal(body.size, "auto");
		assert.equal(body.watermark, false);
		assert.deepEqual(status, [
			{ key: "sensenova", text: "Generating image (sensenova-u1.5-fast)…" },
			{ key: "sensenova", text: undefined },
		]);
		const success = notify.find((n) => n.message.includes("Image generated and saved to"));
		assert.ok(success);
		assert.equal(success.type, "info");
		assert.match(success.message, new RegExp(escapeRegExp(join(cwd, ".sensenova", "20260930-101530-000-a-white-seal.png"))));
		assert.match(success.message, /sensenova-u1\.5-fast/);
	});
});

test("command honors the saved config for model, size, output_format, watermark, and output_dir", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeImageConfig(configPath, {
			model: "sensenova-u1.5-lite",
			size: "1024x1024",
			output_format: "jpeg",
			watermark: true,
			output_dir: "out",
		});
		const command = makeCommand(impl, configPath);
		const { ctx, notify } = fakeContext({ cwd, model: makeModel("sensenova-u1.5-lite") });
		await command.handler('gen "a seal"', ctx);

		const body = JSON.parse(calls[0].init.body);
		assert.equal(body.model, "sensenova-u1.5-lite");
		assert.equal(body.size, "1024x1024");
		assert.equal(body.output_format, "jpeg");
		assert.equal(body.watermark, true);
		const success = notify.find((n) => n.message.includes("Image generated"));
		assert.match(success.message, new RegExp(escapeRegExp(join(cwd, "out", "20260930-101530-000-a-seal.jpeg"))));
	});
});

test("command --model flag overrides the saved config model for one call", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeImageConfig(configPath, { model: "sensenova-u1.5-fast" });
		const command = makeCommand(impl, configPath);
		const { ctx } = fakeContext({ cwd, model: makeModel("sensenova-u1.5-lite") });
		await command.handler('--model sensenova-u1.5-lite gen "a seal"', ctx);

		assert.equal(JSON.parse(calls[0].init.body).model, "sensenova-u1.5-lite");
	});
});

test("command edit reads @-paths and posts to /images/edits", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		await writeFile(join(cwd, "main.png"), TINY_PNG);
		const command = makeCommand(impl, join(cwd, "sensenova-compat.json"));
		const { ctx, notify } = fakeContext({ cwd });
		await command.handler('edit @main.png "make the background winter"', ctx);

		assert.equal(calls[0].url, `${BASE_URL}/images/edits`);
		const body = JSON.parse(calls[0].init.body);
		assert.deepEqual(body.images, [{ image_url: `data:image/png;base64,${TINY_PNG.toString("base64")}` }]);
		assert.ok(notify.find((n) => n.message.includes("Image edited and saved to")));
	});
});

test("command reports missing auth as an error without a network call", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const command = makeCommand(impl, join(cwd, "sensenova-compat.json"));
		const { ctx, notify } = fakeContext({ cwd, apiKey: null });
		await command.handler('gen "a seal"', ctx);

		assert.equal(calls.length, 0);
		const error = notify.find((n) => n.type === "error");
		assert.ok(error);
		assert.match(error.message, /API key/);
	});
});

test("command rejects an invalid --model before any network call", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const command = makeCommand(impl, join(cwd, "sensenova-compat.json"));
		const { ctx, notify } = fakeContext({ cwd });
		await command.handler('gen "a seal" --model gpt-4', ctx);

		assert.equal(calls.length, 0);
		assert.match(notify.find((n) => n.type === "error").message, /unknown model/);
	});
});

test("command warns and falls back to defaults on a corrupt config file", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeFile(configPath, "{ not json");
		const command = makeCommand(impl, configPath);
		const { ctx, notify } = fakeContext({ cwd });
		await command.handler('gen "a seal"', ctx);

		const warning = notify.find((n) => n.type === "warning");
		assert.ok(warning);
		assert.match(warning.message, /not valid JSON/);
		assert.equal(JSON.parse(calls[0].init.body).size, "auto");
		assert.ok(notify.find((n) => n.message.includes("Image generated")));
	});
});

test("settings shows the effective config including the file path", async () => {
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeImageConfig(configPath, { model: "sensenova-u1.5-lite", watermark: true });
		const command = makeCommand(noopFetch(), configPath);
		const { ctx, notify } = fakeContext({ cwd });
		await command.handler("settings", ctx);

		const info = notify.find((n) => n.type === "info");
		assert.ok(info);
		assert.match(info.message, /model: +sensenova-u1\.5-lite \(saved\)/);
		assert.match(info.message, /watermark: +true \(saved\)/);
		assert.match(info.message, /output_format: +png \(default\)/);
		assert.match(info.message, new RegExp(escapeRegExp(configPath)));
	});
});

test("settings set persists a validated value and notifies", async () => {
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		const command = makeCommand(noopFetch(), configPath);
		const { ctx, notify } = fakeContext({ cwd });
		await command.handler("settings watermark true", ctx);

		assert.match(notify.find((n) => n.type === "info").message, /Saved watermark = true/);
		const loaded = await loadImageConfig(configPath);
		assert.deepEqual(loaded.config, { watermark: true });
	});
});

test("settings set rejects an invalid value without writing", async () => {
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		const command = makeCommand(noopFetch(), configPath);
		const { ctx, notify } = fakeContext({ cwd });
		await command.handler("settings size banana", ctx);

		assert.match(notify.find((n) => n.type === "error").message, /size/);
		await assert.rejects(readFile(configPath));
	});
});

test("settings reset clears the config file and notifies", async () => {
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeImageConfig(configPath, { size: "1024x1024" });
		const command = makeCommand(noopFetch(), configPath);
		const { ctx, notify } = fakeContext({ cwd });
		await command.handler("settings reset", ctx);

		assert.match(notify.find((n) => n.type === "info").message, /Reset/);
		assert.deepEqual((await loadImageConfig(configPath)).config, {});
	});
});

function noopFetch() {
	return async () => {
		throw new Error("network should not be called");
	};
}

// --- tool shared-config integration ---

test("tool honors the saved config for model and output_dir", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeImageConfig(configPath, { model: "sensenova-u1.5-lite", output_dir: "out" });
		const tool = createGenerateImageTool({ fetch: impl, now: () => NOW, configPath });
		const ctx = {
			cwd,
			modelRegistry: {
				getModelOfType: () => makeModel("sensenova-u1.5-lite"),
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }),
			},
		};
		const result = await tool.execute("call-1", { prompt: "a seal" }, undefined, undefined, ctx);

		assert.equal(JSON.parse(calls[0].init.body).model, "sensenova-u1.5-lite");
		assert.equal(result.details.model, "sensenova-u1.5-lite");
		assert.equal(result.details.path, join(cwd, "out", "20260930-101530-000-a-seal.png"));
	});
});

test("tool warns in the result text and uses defaults on a corrupt config", async () => {
	const { calls, impl } = fetchRecorder(okResponse());
	await withTempCwd(async (cwd) => {
		const configPath = join(cwd, "sensenova-compat.json");
		await writeFile(configPath, "{ not json");
		const tool = createGenerateImageTool({ fetch: impl, now: () => NOW, configPath });
		const ctx = {
			cwd,
			modelRegistry: {
				getModelOfType: () => makeModel("sensenova-u1.5-fast"),
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }),
			},
		};
		const result = await tool.execute("call-1", { prompt: "a seal" }, undefined, undefined, ctx);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0].text, /using defaults/);
		assert.equal(JSON.parse(calls[0].init.body).size, "auto");
	});
});
