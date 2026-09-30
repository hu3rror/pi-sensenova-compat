# pi-sensenova-compat

让 [pi](https://pi.dev) 0.99.1 使用商汤 SenseNova（TokenPlan 网关）的 5 个 chat 模型与 2 个 U 系列生图模型。配置优先：chat 层纯 `models.json`，生图层一个薄扩展。

- 架构与取舍：`docs/adr/0001-sensenova-integration-architecture.md`
- 域术语：`CONTEXT.md`
- 规格：GitHub issue #1（`ready-for-agent`）
- 官方文档快照：`docs/LLM API 服务平台.md`（正文 = 桌面源版 − 5 行，frontmatter 已精简）

## 交付物

| 文件 | 说明 |
| --- | --- |
| `sensenova.models.json` | chat 层配置片段，合并进 pi 的 `models.json` |
| `sensenova-images.ts` | 生图扩展（U1.5 Lite / Fast）：注册 provider `sensenova-images`，并注册对话内工具 `sensenova_generate_image` |
| `sensenova-images.test.mjs` | 主 seam 单元测试（请求构造 / 响应映射 / 错误路径） |
| 本 README | 安装、认证、常量与验证说明 |

## 要求

- **pi 0.99.1**（所有 schema 与行为依据本地 0.99.1 打包产物验证；不采用未在本地 schema 出现的字段）
- Node ≥ 20（仅运行测试需要）

## 安装

1. **合并配置**：把 `sensenova.models.json` 中 `providers.sensenova` 合入 `~/.pi/agent/models.json`（若文件不存在则复制整文件）。
2. **安装扩展**：复制 `sensenova-images.ts` 到 `~/.pi/agent/extensions/`（pi 扩展自动发现只认 `.ts`/`.js` 文件）。若旧版 `sensenova-u1.ts` 仍在，删除它（旧工具 `sensenova_draw_infographic` 已废弃：模型 id `sensenova-u1-fast` 早已下线，返回 1 小时过期 URL 且不落盘）。
3. **认证**（二选一）：
   - `/login`：先后录入两个 provider 的密钥——`SenseNova`（chat）与 `SenseNova Images`（生图），同一个 key 即可；
   - 或设环境变量 `SENSENOVA_API_KEY`（两 provider 共用）。
4. **重载** `/model`：应出现 `SenseNova` 下 5 个 chat 模型、`SenseNova Images` 下 2 个生图模型。模型不出现时先确认对应 provider 的凭据已配置。新扩展/新工具需要重启 pi 或 `/reload` 后生效。

## 对话内生图

扩展注册对话内工具 **`sensenova_generate_image`**：agent 在对话中直接调用即可生图（如「画一张架构图」），无需切换模型或手动调接口。

- 参数：`prompt`（必填，图片描述）；`model`（可选，`sensenova-u1.5-fast` 默认、`sensenova-u1.5-lite` 更高画质）。
- 产物：PNG 写入 `<cwd>/.sensenova/`，文件名 `时间戳-描述slug.png`；工具返回本地路径（不用会过期的 URL）。
- 凭据：与 provider 共用 `SenseNova Images` 的 `/login` 密钥或 `$SENSENOVA_API_KEY`；缺凭据时工具返回错误提示并说明配置方法。
- 常量沿用下表（`watermark:false`、`output_format:"png"`、`size:"auto"`、`response_format:"b64_json"`、`n=1`）。

## 生图常量与官方可调字段

本期硬编码（依据 `docs/LLM API 服务平台.md` U1.5 章节）：

| 字段 | 本期值 | 官方默认/说明 |
| --- | --- | --- |
| `watermark` | `false` | 官方默认 `true`（商汤 Logo 水印）；`false` 当前公测免费无水印 |
| `output_format` | `"png"` | 官方 `png` / `jpeg` / `webp` |
| `size` | `"auto"` | 官方常量需 32 倍数、512–4096、比例 ≤3:1；`auto` 时 edits 自动适配主图 |
| `response_format` | `"b64_json"` | 官方 `b64_json` / `url`（`url` 链接 24 小时过期，故用 `b64_json` 直传） |

官方可调但本期不改：`prompt_extend`（默认 `true`，prompt 自动润色）、`n`（仅 `1`）、参考图（`/v1/images/edits` 必带 ≥1 张、至多 5 张）。改这些字段 = 改 `sensenova-images.ts` 常量。

## chat 模型要点

- 5 个模型均定义在配置层，字段与官方参数表逐项对齐（`contextWindow` / `maxTokens` / `thinkingLevelMap` / `compat`）。
- `kimi-k3` 使用 `max_completion_tokens`（模型级 `compat` 覆盖）；其余 4 个用 `max_tokens`。
- `deepseek-v4-flash` / `deepseek-flash` 开启 `requiresReasoningContentOnAssistantMessages`（官方要求工具轮回传 `reasoning_content`）。
- `deepseek-v4-flash` 的 `maxTokens` 取 65536（官方「非思考默认 8K／思考默认 64K」的默认档上限；**官方 max 思考档可达 128K**，如需可上调，这不是官方上限）。
- 思考：`/thinking off` 发送 `reasoning_effort:"none"`；未选档时不发参数、保留官方默认（flash-lite / deepseek-v4 默认 `high`，glm / kimi 默认 `max`）。思考档位按**服务端实测**暴露：flash-lite / deepseek-v4 合法档是 low/medium/high/xhigh/none（**官方文档写 max 是错的，发送 `"max"` 会 400**，其 `max`/`xhigh` 档都映射 `xhigh`）；deepseek-flash 含官方兼容映射档；glm-5.2 含原生 minimal/xhigh；kimi 为 low/medium/high/max/none 且偶发服务端间歇错误（限流/波动，非参数问题）。

## 测试

```sh
node --test sensenova-images.test.mjs
```

## 验证状态

- 已对齐：pi 0.99.1 打包产物（models.json schema、openai-completions 实现、provider 合成）与官方快照（ADR 0001）。
- **已冒烟（2026-09-30，deepseek-flash 优先、后全矩阵）**：5 个 chat 模型 × 全部思考档位 wire 级验证通过——`reasoning_effort` 档位映射、`max_tokens`/`max_completion_tokens` 字段、`role:"system"`（supportsDeveloperRole:false）、无 `store` 字段（supportsStore:false）、usage/缓存映射、工具调用多轮回传（read 工具）均验证。详见 ADR 0001「档位实测修正」。
- **结构历史验证（同日）**：多 system 消息 → 折叠为单条（无 400）；`assistant. content:null` 无工具 → 从请求跳过；带思考的 assistant 历史 → 按原 wire 字段名（`reasoning_content`）回传；跨请求工具历史（`tool_calls→tool→toolResult`）完整回传。
- 待验证：生图链路（U1.5）实发请求——对话内入口已就绪（`sensenova_generate_image`），需 `sensenova-images` 凭据后在 TUI 中触发生图。

## 已知待实测项

- 工具多轮回传与思考字段名出处（官方示例 `reasoning` vs 响应 `reasoning_content`）：流式侧依赖 pi 三字段兼容，以实测为准。
- kimi-k3「必须原样回传完整 assistant 消息」：现为字段级等价重建，需实测确认。
- `supportsStore: false` 为保守关闭；若实测服务端接受 `store` 字段可改回 `true`。

## 环境变量示例

仓库保护规则不允许直接存放 `.env.example` 文件（示例在此处）：

```sh
export SENSENOVA_API_KEY=sk-...
```