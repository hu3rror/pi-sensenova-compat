# pi-sensenova-compat

[English](README.md)

让 [pi](https://pi.dev) 0.99.1 接上商汤 SenseNova（TokenPlan 网关，`token.sensenova.cn/v1`）。分两层：

- **Chat 层**：5 个 SenseNova chat 模型，以 `models.json` 纯配置落在 `openai-completions` provider（`sensenova`）上，无扩展代码。
- **图像层**：2 个 U 系列模型（`sensenova-u1.5-lite` / `sensenova-u1.5-fast`），由薄扩展注册 `sensenova-images` provider 与对话内工具 `sensenova_generate_image`。

两个 provider 共用同一个 key。

## 快速开始

1. **安装**

   ```sh
   pi install npm:pi-sensenova-compat
   ```

   （git：`pi install git:github.com/hu3rror/pi-sensenova-compat`；本地：`pi install C:/绝对/路径/pi-sensenova-compat`——相对路径从 settings 文件所在目录解析，用绝对路径；手动兜底：把 `extensions/sensenova-images.ts` 复制到 `~/.pi/agent/extensions/`。）

2. **认证**：`/login` 录入两个 provider（chat 的 `SenseNova` 与图像的 `SenseNova Images`，同一个 key 即可），或 `export SENSENOVA_API_KEY=sk-...`。

3. **在对话里直接用**

   - 文生图：让 agent 调用 `sensenova_generate_image`，如「画一只白色海豹的插画」。PNG 写入 `<cwd>/.sensenova/`，工具返回本地路径。
   - 图生图：`image_paths` 传本地图片（第 1 张为主编辑图、至多 5 张），如「把 C:/.../photo.png 的背景改成冬天，保留主体」。工具会把 base64 Data URL 发往 `/v1/images/edits`——完整流程见[对话内生图](#对话内生图)。
   - 若 `/model` 里没出现两个 provider，先 `/reload` 复查对应 provider 的凭据是否已配置（应出现 `SenseNova` 下 5 个 chat 模型、`SenseNova Images` 下 2 个图像模型）。

## 安装

1. **合并配置**：把 `sensenova.models.json` 中 `providers.sensenova` 合入 `~/.pi/agent/models.json`（文件不存在则复制整文件）。
2. **安装 pi 包**（四选一）：
   - 本地目录（开发期）：`pi install C:/绝对/路径/pi-sensenova-compat`，或 `pi -e ./` 单次试跑；
   - git：`pi install git:github.com/hu3rror/pi-sensenova-compat`；
   - npm：`pi install npm:pi-sensenova-compat`；
   - 手动兜底：把 `extensions/sensenova-images.ts` 复制到 `~/.pi/agent/extensions/`（pi 扩展自动发现只认 `.ts`/`.js` 文件）。若旧版 `sensenova-u1.ts` 仍在，删除它（废弃工具 `sensenova_draw_infographic` 对应已下线的 `sensenova-u1-fast` 模型 id，返回 1 小时过期 URL 且不落盘）。
3. **认证**（二选一）：`/login` 两次录入同一个 key（`SenseNova` + `SenseNova Images`），或设 `SENSENOVA_API_KEY`（两 provider 共用）。
4. **重载** `/model` 并验证。新扩展/新工具需重启 pi 或 `/reload` 后生效。

## 对话内生图

扩展注册对话内工具 **`sensenova_generate_image`**：agent 在对话中直接调用即可生图（如「画一张架构图」），无需切换模型或手动调接口。

- 参数：
  - `prompt`（必填）：图片描述；图生图时写编辑指令，说明要改什么、保留什么。
  - `model`（可选）：`sensenova-u1.5-fast`（默认，较快）或 `sensenova-u1.5-lite`（更高质量）。
  - `image_paths`（可选）：本地图片路径数组，绝对路径或相对 cwd；带 1 张以上即走 `/v1/images/edits` 图生图，第 1 张为主编辑图、至多 5 张；省略则纯文生图。
- 图生图流程：工具读取各文件 → 按文件头嗅探 mime（png/jpeg/gif/webp/bmp）→ 拼完整 Data URL（`data:image/{format};base64,…`）→ 发 `/v1/images/edits`。坏路径/非图片/超 5 张在工具层拦截，返回错误且不发网络请求。服务端只接受 PNG/JPEG/WebP、≤10MB、宽高 [256,4096] px、比例 ≤2:1（实测），超分辨率图需客户端先降采样。
- 产物：PNG 写入 `<cwd>/.sensenova/`，文件名 `时间戳-描述slug.png`；工具返回本地路径（不用会过期的 URL）。图生图返回 `Image edited and saved to …`，文生图返回 `Image generated and saved to …`。
- 凭据：与 provider 共用 `SenseNova Images` 的 `/login` 密钥或 `$SENSENOVA_API_KEY`；缺凭据时返回错误并说明配置方法。

仓库结构、生图常量、chat 层内部细节、测试与验证记录等对开发更重要的内容在文末。

## 仓库结构

本仓库即一个 pi 包（`package.json` 带 `pi-package` keyword 与 `pi.extensions` 显式声明）：

```text
pi-sensenova-compat/
├── package.json                    # pi 包清单
├── extensions/
│   └── sensenova-images.ts         # 扩展层：provider + 工具，单文件
├── test/
│   └── sensenova-images.test.mjs   # 主 seam 单元测试
├── sensenova.models.json           # chat 层配置片段（手动合并，非包资源）
├── docs/                           # ADR / issue-tracker 文档 / 官方快照
└── README.md / README.zh-CN.md
```

## 生图常量与官方可调字段

本期硬编码（依据 `docs/LLM API 服务平台.md` U1.5 章节）：

| 字段 | 本期值 | 官方默认/说明 |
| --- | --- | --- |
| `watermark` | `false` | 官方默认 `true`（SenseNova Logo）；`false` 当前公测免费无水印 |
| `output_format` | `"png"` | `png` / `jpeg` / `webp` |
| `size` | `"auto"` | 显式常量需 32 的倍数、512–4096、比例 ≤3:1；`auto` 时 edits 自动适配主图 |
| `response_format` | `"b64_json"` | `b64_json` / `url`（`url` 链接 24 小时过期，故用 `b64_json` 直传） |

官方可调但本期不改：`prompt_extend`（默认 `true`，自动润色 prompt）、`n`（仅 `1`）、参考图（`/v1/images/edits` 必带 ≥1 张、至多 5 张）。改这些字段 = 改 `extensions/sensenova-images.ts` 常量。

## chat 层内部细节

- 5 个模型均定义在配置层，字段与官方参数表逐项对齐（`contextWindow` / `maxTokens` / `thinkingLevelMap` / `compat`）。
- `kimi-k3` 发 `max_completion_tokens`（模型级 `compat` 覆盖）；其余 4 个发 `max_tokens`。
- `deepseek-v4-flash` / `deepseek-flash` 开启 `requiresReasoningContentOnAssistantMessages`（官方要求工具轮回传 `reasoning_content`）。
- `deepseek-v4-flash` 的 `maxTokens` 取 65536（官方「非思考默认 8K／思考默认 64K」的默认档上限；官方 max 思考档可达 128K，如需可上调，这不是官方上限）。
- 思考：`/thinking off` 发 `reasoning_effort:"none"`；未选档时不发参数、保留官方默认（flash-lite / deepseek-v4 默认 `high`，glm / kimi 默认 `max`）。档位按**服务端实测**暴露：flash-lite / deepseek-v4 合法档是 low/medium/high/xhigh/none——官方文档写 `max` 是错的，发送 `"max"` 会 400，其 `max`/`xhigh` 档均映射 `xhigh`；deepseek-flash 含官方兼容映射；glm-5.2 含原生 minimal/xhigh；kimi 为 low/medium/high/max/none 且偶发服务端间歇错误（限流/波动，非参数问题）。

## 要求

- **pi 0.99.1**（schema 与行为均对照本地 0.99.1 打包产物验证；不采用本地 schema 未出现的字段）
- Node ≥ 22.18（仅运行测试需要）

## 测试

```sh
npm test
# 或：node --test test/
```

零依赖：测试文件直接 import 扩展 `.ts`，经注入的 fetch/now seam 验证请求构造、响应映射、错误路径。

## 验证状态

- **已对齐**：pi 0.99.1 打包产物（models.json schema、openai-completions 实现、provider 合成）与官方快照（ADR 0001）。
- **已冒烟（2026-09-30，deepseek-flash 优先、后全矩阵）**：5 个 chat 模型 × 全部思考档位 wire 级验证通过——`reasoning_effort` 映射、`max_tokens`/`max_completion_tokens` 字段、`role:"system"`（supportsDeveloperRole:false）、无 `store` 字段（supportsStore:false）、usage/缓存映射、工具调用多轮回传（read 工具）。详见 ADR 0001。
- **结构历史验证（同日）**：多 system 消息折叠为单条（无 400）；空 `assistant`（无文本无工具）从请求跳过；带思考的 assistant 历史按原 wire 字段名（`reasoning_content`）回传；跨请求工具历史（`tool_calls → tool → toolResult`）完整回传。
- **生图冒烟（2026-09-30）**：`sensenova_generate_image` 实发请求通过——补录 `SenseNova Images` 凭据后成功生成 2048×1536 PNG（约 3.5MB）落盘 `<cwd>/.sensenova/`；vision 复检确认内容正确、无水印（`watermark:false` 生效）。非 ASCII prompt 的文件名 slug 回退为 `image`。

## 已知待实测项

- 工具多轮回传与思考字段名出处（官方示例 `reasoning` vs 响应 `reasoning_content`）：流式侧依赖 pi 三字段兼容，以实测为准。
- kimi-k3「必须原样回传完整 assistant 消息」：现为字段级等价重建，需实测确认。
- `supportsStore: false` 为保守关闭；若实测服务端接受 `store` 字段可改回 `true`。
- **edits 实发请求实测（2026-10）**：`image_paths` 图生图通路真实冒烟通过（桌面 7500×5000 JPG 先降采样到 4096 宽，改背景白昼化由复检确认）。服务端实测约束：仅接受 PNG/JPEG/WebP、≤10MB、宽高 [256,4096] px、比例 ≤2:1——超限直接返回 400（`invalid images[0].image_url: image should be PNG, JPEG, or WebP, no larger than 10MB, …`，官方快照未写这些数字）；gif/bmp 不在接受列表，未实测。数组上限按官方表「第 1 张为主编辑图，至多 5 张参考图」字面为 6 张，当前按交接确认的 >5 张拦截，以实测为准。

## 环境变量示例

仓库保护规则不允许直接存放 `.env.example` 文件（示例在此处）：

```sh
export SENSENOVA_API_KEY=sk-...
```