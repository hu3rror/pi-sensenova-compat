# pi-sensenova-compat

[简体中文](README.zh-CN.md)

A thin extension that brings SenseNova's U-series image models to pi: it registers the in-conversation `sensenova_generate_image` tool (provider `sensenova-images`) — install, authenticate, and it just works in the chat.

The package also carries the 5 SenseNova chat models as a `models.json` fragment — that part is **manual**: merge it into `~/.pi/agent/models.json` yourself (Install step 1). Nothing about chat is automated here.

Thinking-level note: the official doc's table for `sensenova-6.8-flash-lite` / `deepseek-v4-flash` is wrong — it lists `max`, but the server rejects `reasoning_effort:"max"` with 400; the valid levels are low/medium/high/xhigh/none, so this package maps both the `max` and `xhigh` levels to `xhigh` (measured, see ADR 0001).

**Compatibility stance**: the image tool talks only to SenseNova's official public endpoints (`/v1/images/generations`, `/v1/images/edits`); the chat config uses pi's stock `openai-completions` provider and the `models.json` schema. No private protocols, no custom stream parsing, no patched internals. The official SenseNova doc snapshot lives in `docs/LLM API 服务平台.md`, and every behavior decision is recorded in the ADRs — both stay reviewable against upstream.

## Quickstart

1. **Install**

   ```sh
   pi install npm:pi-sensenova-compat
   ```

   (Git: `pi install git:github.com/hu3rror/pi-sensenova-compat`. Local: `pi install C:/path/to/pi-sensenova-compat` — relative paths resolve from the settings file's directory, so use an absolute path. Manual fallback: copy `extensions/sensenova-images.ts` to `~/.pi/agent/extensions/`.)

2. **Authenticate** — `/login` for provider `SenseNova Images` (the image tool). Only add `SenseNova` too if you also use the chat models. Or set `export SENSENOVA_API_KEY=sk-...` (shared by both providers).

3. **Use it in the conversation**

   - Text to image: tell the agent to call `sensenova_generate_image`, e.g. "generate an illustration of a white seal". A PNG lands in `<cwd>/.sensenova/` and the tool returns its local path.
   - Image to image: pass local files in `image_paths` (first image is the main edit target, at most 5), e.g. "turn the background of C:/.../photo.png into winter, keep the subject". The tool posts base64 data URLs to `/v1/images/edits` — see [In-conversation image generation](#in-conversation-image-generation) for the full flow.
   - Reload `/model` once after installing: `SenseNova Images` comes from the extension and appears immediately. The `SenseNova` chat provider only appears after you merged the config fragment (Install step 1). A missing entry usually means that provider's credentials are not configured.

## Install

1. **Merge the config fragment**: add the `providers.sensenova` block from `sensenova.models.json` to `~/.pi/agent/models.json` (copy the whole file if it does not exist).
2. **Install the package** (pick one):
   - Local path (development): `pi install C:/path/to/pi-sensenova-compat`, or `pi -e ./` for a one-shot run.
   - Git: `pi install git:github.com/hu3rror/pi-sensenova-compat`.
   - npm: `pi install npm:pi-sensenova-compat`.
   - Manual fallback: copy `extensions/sensenova-images.ts` to `~/.pi/agent/extensions/`.
3. **Authenticate** (either): `/login` for both providers with the same key, or set `SENSENOVA_API_KEY` (shared).
4. **Reload** `/model` and verify. New extensions/tools require a pi restart or `/reload`.

## In-conversation image generation

The extension registers the **`sensenova_generate_image`** tool: the agent calls it directly in the conversation ("draw an architecture diagram"), no model switching or manual API calls.

- Parameters:
  - `prompt` (required): image description, or, for edits, the edit instruction stating what to keep unchanged.
  - `model` (optional): `sensenova-u1.5-fast` (default, quicker) or `sensenova-u1.5-lite` (higher quality).
  - `image_paths` (optional): local image paths, absolute or relative to the cwd. Passing 1+ paths switches to `/v1/images/edits`: the first image is the main edit target, at most 5 images. Omitting it generates from text only.
- Edit flow: the tool reads each file, sniffs the mime type (png/jpeg/gif/webp/bmp), builds a full Data URL (`data:image/{format};base64,…`), and posts it to `/v1/images/edits`. Bad paths, non-images, and more than 5 images are rejected at the tool layer with an error and no network request. The server accepts PNG/JPEG/WebP, ≤10MB, width/height in [256,4096] px, aspect ratio ≤2:1 — downsample oversized images client-side first.
- Output: a PNG written to `<cwd>/.sensenova/` with a `timestamp-slug.png` filename; the tool returns the local path (no expiring URL). Edits report `Image edited and saved to …`, generation `Image generated and saved to …`.
- Credentials: same `SenseNova Images` `/login` key or `$SENSENOVA_API_KEY`; missing credentials produce an error explaining how to configure.

## Repository layout

This repo is a pi package (`package.json` carries the `pi-package` keyword and a `pi.extensions` manifest):

```text
pi-sensenova-compat/
├── package.json                    # pi package manifest
├── extensions/
│   └── sensenova-images.ts         # extension layer: provider + tool, single file
├── test/
│   └── sensenova-images.test.mjs   # main seam unit tests
├── sensenova.models.json           # chat-layer config fragment (manual merge, not a package resource)
├── docs/                           # ADRs, official API snapshot
└── README.md / README.zh-CN.md
```

## Image constants and tunables

| Field | This round | Official default / notes |
| --- | --- | --- |
| `watermark` | `false` | Official default `true` (SenseNova logo); `false` is currently free in public beta |
| `output_format` | `"png"` | `png` / `jpeg` / `webp` |
| `size` | `"auto"` | Explicit constants must be multiples of 32, 512–4096, ratio ≤3:1; `auto` adapts to the main image on edits |
| `response_format` | `"b64_json"` | `b64_json` / `url` (`url` links expire after 24h, hence the inline base64) |

Officially tunable but unchanged this round: `prompt_extend` (default `true`, auto-polishes the prompt), `n` (only `1`), reference images (`/v1/images/edits` requires ≥1 input image, at most 5). Changing any of these means editing the constants in `extensions/sensenova-images.ts`.

## Tests

```sh
npm test
```

Zero-dependency: the test file imports the extension's `.ts` directly with injected fetch/now seams (request construction, response mapping, error paths).

## Docs

- Architecture and tradeoffs: `docs/adr/0001-sensenova-integration-architecture.md`, `docs/adr/0002-pi-package-layout.md`
- Domain glossary (中文术语表): `CONTEXT.md`
- Spec: GitHub issue #1
- Official API snapshot: `docs/LLM API 服务平台.md`