# pi-sensenova-compat

[简体中文](README.zh-CN.md)

Make pi 0.99.1 talk to SenseNova (TokenPlan gateway, `token.sensenova.cn/v1`). Two layers:

- **Chat**: the 5 SenseNova chat models as `models.json` config on an `openai-completions` provider (`sensenova`). Purely declarative, no extension code.
- **Image**: the 2 U-series models (`sensenova-u1.5-lite`, `sensenova-u1.5-fast`) through a thin extension that registers the `sensenova-images` provider and the in-conversation `sensenova_generate_image` tool.

Both providers accept the same API key.

- Architecture and tradeoffs: `docs/adr/0001-sensenova-integration-architecture.md`, `docs/adr/0002-pi-package-layout.md`
- Domain glossary (中文术语表): `CONTEXT.md`
- Spec: GitHub issue #1 (`ready-for-agent`)
- Official API snapshot: `docs/LLM API 服务平台.md`

## Layout

This repo is a pi package (`package.json` carries the `pi-package` keyword and a `pi.extensions` manifest):

```text
pi-sensenova-compat/
├── package.json                    # pi package manifest
├── extensions/
│   └── sensenova-images.ts         # extension layer: provider + tool, single file
├── test/
│   └── sensenova-images.test.mjs   # main seam unit tests
├── sensenova.models.json           # chat-layer config fragment (manual merge, not a package resource)
├── docs/                           # ADRs, issue-tracker docs, official API snapshot
└── README.md / README.zh-CN.md
```

## Requirements

- pi 0.99.1 (every schema and behavior is verified against the local 0.99.1 build; no fields appear that the local schema lacks)
- Node >= 22.18 (only to run the tests)

## Install

1. **Merge the config fragment**: add the `providers.sensenova` block from `sensenova.models.json` to `~/.pi/agent/models.json` (copy the whole file if it does not exist).
2. **Install the package** (pick one):
   - Local path (development): `pi install C:/path/to/pi-sensenova-compat` (relative paths resolve from the settings file's directory, so use an absolute path), or `pi -e ./` for a one-shot run.
   - Git: `pi install git:github.com/hu3rror/pi-sensenova-compat`.
   - npm (after publishing): `pi install npm:pi-sensenova-compat`.
   - Manual fallback: copy `extensions/sensenova-images.ts` to `~/.pi/agent/extensions/` (pi discovers `.ts`/`.js` files). If an old `sensenova-u1.ts` is still present, delete it: the retired `sensenova_draw_infographic` tool targets the offline `sensenova-u1-fast` model id and returns 1-hour-expiring URLs without saving files.
3. **Authenticate** (either):
   - `/login`, entering the key twice: provider `SenseNova` (chat) and provider `SenseNova Images` (image), same key is fine.
   - Or set the `SENSENOVA_API_KEY` environment variable (shared by both providers).
4. **Reload** `/model`: `SenseNova` should list the 5 chat models and `SenseNova Images` the 2 image models. If a model is missing, check that provider's credentials first. New extensions/tools require a pi restart or `/reload`.

## In-conversation image generation

The extension registers the **`sensenova_generate_image`** tool: the agent calls it directly in the conversation ("draw an architecture diagram"), no model switching or manual API calls.

- Parameters:
  - `prompt` (required): image description, or, for edits, the edit instruction stating what to keep unchanged.
  - `model` (optional): `sensenova-u1.5-fast` (default, quicker) or `sensenova-u1.5-lite` (higher quality).
  - `image_paths` (optional): local image paths, absolute or relative to the cwd. Passing 1+ paths switches to `/v1/images/edits`: the first image is the main edit target, at most 5 images. Omitting it generates from text only.
- Edit flow: the tool reads each file, sniffs the mime type (png/jpeg/gif/webp/bmp), builds a full Data URL (`data:image/{format};base64,…`), and posts it to `/v1/images/edits`. Bad paths, non-images, and more than 5 images are rejected at the tool layer with an error and no network request. The server only accepts PNG/JPEG/WebP, ≤10MB, width/height in [256,4096] px, aspect ratio ≤2:1 (measured) — downsample oversized images client-side first.
- Output: a PNG written to `<cwd>/.sensenova/` with a `timestamp-slug.png` filename; the tool returns the local path (no expiring URL). Edits report `Image edited and saved to …`, generation `Image generated and saved to …`.
- Credentials: same `SenseNova Images` `/login` key or `$SENSENOVA_API_KEY`; missing credentials produce an error explaining how to configure.
- Constants follow the table below (`watermark:false`, `output_format:"png"`, `size:"auto"`, `response_format:"b64_json"`, `n=1`).

## Constants and tunables

Hardcoded this round (per the U1.5 chapter of `docs/LLM API 服务平台.md`):

| Field | This round | Official default / notes |
| --- | --- | --- |
| `watermark` | `false` | Official default `true` (SenseNova logo); `false` is currently free in public beta |
| `output_format` | `"png"` | `png` / `jpeg` / `webp` |
| `size` | `"auto"` | Explicit constants must be multiples of 32, 512–4096, ratio ≤3:1; `auto` adapts to the main image on edits |
| `response_format` | `"b64_json"` | `b64_json` / `url` (`url` links expire after 24h, hence the inline base64) |

Officially tunable but unchanged this round: `prompt_extend` (default `true`, auto-polishes the prompt), `n` (only `1`), reference images (`/v1/images/edits` requires ≥1 input image, at most 5). Changing any of these means editing the constants in `extensions/sensenova-images.ts`.

## Chat layer notes

- All 5 models live in the config layer, field-by-field aligned with the official parameter tables (`contextWindow` / `maxTokens` / `thinkingLevelMap` / `compat`).
- `kimi-k3` sends `max_completion_tokens` (model-level `compat` override); the other 4 send `max_tokens`.
- `deepseek-v4-flash` and `deepseek-flash` enable `requiresReasoningContentOnAssistantMessages` (the official docs require replaying `reasoning_content` on tool-turn assistant messages).
- `deepseek-v4-flash` `maxTokens` is 65536 (the non-thinking default tier ceiling; the official max thinking tier goes to 128K — this is not an official cap).
- Thinking: `/thinking off` sends `reasoning_effort:"none"`; no selection sends no parameter and keeps the official default (flash-lite / deepseek-v4 default `high`, glm / kimi default `max`). Levels are exposed from **server-side measurements**: flash-lite / deepseek-v4 accept low/medium/high/xhigh/none — the official docs say `max`, which is wrong and returns 400, so their `max`/`xhigh` levels both map to `xhigh`. deepseek-flash carries the official compatibility mapping; glm-5.2 has native minimal/xhigh; kimi has low/medium/high/max/none and occasionally throws intermittent server errors (throttling/fluctuation, not a parameter issue).

## Tests

```sh
npm test
# or: node --test test/
```

Zero-dependency: the test file imports the extension's `.ts` directly with injected fetch/now seams (request construction, response mapping, error paths).

## Verification status

- **Aligned**: pi 0.99.1 build artifacts (models.json schema, openai-completions implementation, provider composition) and the official snapshot (ADR 0001).
- **Smoke-tested (2026-09-30, deepseek-flash first, then the full matrix)**: all 5 chat models × every thinking level verified at the wire level — `reasoning_effort` mapping, `max_tokens`/`max_completion_tokens` fields, `role:"system"` (supportsDeveloperRole:false), no `store` field (supportsStore:false), usage/cache mapping, multi-turn tool-call round-trips (read tool). Details in ADR 0001.
- **Structural history (same day)**: multiple system messages fold into one (no 400); empty `assistant` (no text, no tools) is skipped; assistant history with thinking is replayed under the original wire field name (`reasoning_content`); cross-request tool history (`tool_calls → tool → toolResult`) round-trips fully.
- **Image smoke (2026-09-30)**: `sensenova_generate_image` sent real requests — after adding the `SenseNova Images` credentials it generated a 2048×1536 PNG (~3.5MB) into `<cwd>/.sensenova/`; vision re-check confirmed correct content and no watermark (`watermark:false` effective). Non-ASCII prompts fall back to the `image` slug.

## Known open items

- Multi-turn tool history and the origin of the thinking field name (official example uses `reasoning`, responses use `reasoning_content`): streaming relies on pi's three-field compatibility; confirm by test.
- kimi-k3's "replay the exact assistant message" requirement: currently reconstructed field-by-field; needs a live test.
- `supportsStore: false` is a conservative off; can flip back if a live test shows the server accepts `store`.
- `/v1/images/edits` live constraints (2026-10): the flow works end-to-end (a 7500×5000 JPG was downsampled to 4096 wide client-side, background day-conversion confirmed by re-check). Server-side measured limits: only PNG/JPEG/WebP, ≤10MB, width/height in [256,4096], ratio ≤2:1 — out-of-range inputs return 400 (`invalid images[0].image_url: image should be PNG, JPEG, or WebP, no larger than 10MB, …`), numbers the official snapshot does not state; gif/bmp are not in the accepted list (not measured). Array cap: the docs table reads "1 main edit image + at most 5 reference images" (=6); the tool currently cuts off above 5 per the handoff; confirm by test.

## Environment variable example

The repo's protection rules forbid committing a `.env.example` file, so the example lives here:

```sh
export SENSENOVA_API_KEY=sk-...
```