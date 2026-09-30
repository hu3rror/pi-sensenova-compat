# SenseNova 接入架构：chat 走 models.json、生图走 images 扩展

SenseNova（TokenPlan 网关，`token.sensenova.cn/v1`）提供标准 OpenAI 兼容 Chat Completions 与独立的 `/v1/images/*` 生图接口。决定：chat 模型只进 `models.json`（纯配置，不留自定义 stream），U 系列图像模型只进扩展的 `images` 层；两者分属**两个 provider id**（`sensenova` 与 `sensenova-images`）。

## 为什么两个 provider 而非一个

本地 pi 0.99.1 的合成规则（`dist/core/provider-composer.js` `applyExtension`）：扩展一旦注册 `models`，会**整批替换**该 provider 下 models.json 定义的模型。混放在同一 provider 名下会导致 chat 模型静默丢失；同时 models.json 的模型定义是 chat-only（无 `type` 字段），无法表达 image 模型。因此 chat（models.json）+ image（扩展）必须拆成两个 provider id。代价是 `/model` 出现两个条目，换取 chat 元数据保持"纯配置"、可对官方参数表逐项复核。

## 关键 compat 覆写（pi 0.99.1 `detectCompat` 默认值对 SenseNova 是错的）

- `supportsDeveloperRole: false`：默认 true 会让首条指令消息用 `role:"developer"`；SenseNova 官方只接受 system/user/assistant/tool。
- `maxTokensField: "max_tokens"`（provider 级）；`kimi-k3` 模型级覆盖为 `"max_completion_tokens"`（官方仅 kimi 用该字段名）。
- `supportsStore: false`：默认会发 `store:false`，官方文档无此字段且无法验证服务端是否容忍，保守关闭；若日后实测服务端接受该字段，可再打开。
- `requiresReasoningContentOnAssistantMessages: true` 仅 `deepseek-v4-flash` 与 `deepseek-flash`（官方要求携带 tools 的历史轮次必须回传 `reasoning_content`）。

## 思考模式

保持默认 `thinkingFormat: "openai"`（顶层 `reasoning_effort`），不使用 `string-thinking`：GLM 官方拒绝 `thinking.type:"disabled"`，而所有 5 个 chat 模型都接受 `reasoning_effort`（设 `none` 即关思考）。`thinkingLevelMap.off` 一律 `"none"`，用户未选档时不发参数、保留官方默认思考。deepseek-flash 按官方兼容映射设档（minimal→low、medium→high、xhigh→high）。

maxTokens 取值：`deepseek-v4-flash` 取 65536（官方「非思考默认 8K／思考默认 64K」的默认档上限；官方 max 思考档可达 128K，后续可按需上调——不要误读为官方上限只有 64K）。其余：flash-lite 65536（\[1,65536\]）、deepseek-flash 131072（默认）、glm-5.2 65536（\[1,128K\]，取官方默认档）、kimi-k3 131072（`max_completion_tokens` 默认 128K）。

思考字段名：官方文档的工具回传示例与响应结构对思考字段名（`reasoning` vs `reasoning_content`）有出入；流式侧依赖 pi 0.99.1 内置实现对 `reasoning_content`/`reasoning`/`reasoning_text` 的兼容识别，工具调用多轮回传是否完全无坑以实测为准。

档位实测修正（2026-09 全矩阵冒烟，wire 级验证）：`sensenova-6.8-flash-lite` 与 `deepseek-v4-flash` 的官方文档写低/中/高/max/none，但服务端实际合法值为 low/medium/high/xhigh/none——`reasoning_effort:"max"` 返回 400（`invalid_request_error`）。两模型据此把 `max` 档与 `xhigh` 档都映射到 `"xhigh"`，7 个 pi 档全部指向合法值（文档错误，以实测为准）。其余模型档位 wire 验证均正确：deepseek-flash 兼容映射（minimal→low、medium→high、xhigh→high）与原生 none/low/high/max、glm-5.2 原生 7 档、kimi-k3 的 low/medium/high/max/none。`kimi-k3` 偶发服务端间歇错误（同参数时成时败），非参数问题。

结构历史实测：多 system 消息折叠为单条；空 assistant（无文本无工具）从请求跳过；带思考历史的 assistant 按原 wire 字段名（`reasoning_content`）回传；跨会话工具历史（tool_calls→tool→toolResult）完整回传，均无 400。

## 生图

- 用 `response_format:"b64_json"`：Pi 的 `AssistantImages.output` 契约就是 `{type:"image", mimeType, data}`（无前缀 base64），与官方 `data[].b64_json` 一一对应，规避 URL 24 小时过期问题，无需自行下载。
- 分流：`context.input` 含图像块 → `/v1/images/edits`；纯文本 → `/v1/images/generations`（官方 edits 必带输入图、至多 5 张参考图）。
- 工具形态：扩展现有 `sensenova_generate_image` 增加可选 `image_paths`（≥1 即走 edits）而非独立 `sensenova_edit_image`——edits 分流已在 provider seam 完整实现并单测，共享认证/模型/落盘/错误前缀，新引入的可测逻辑只有文件读取与嗅探；参考图只能来自磁盘路径（工具参数是 LLM 生成的 JSON，拿不到对话消息里的图片内容）。
- 文件嗅探自实现（对齐 pi `dist/utils/mime.js` 字节规则）而非在扩展里 import `detectSupportedImageMimeTypeFromFile`：该导出只能在 pi 运行时经 jiti alias 解析；仓库测试 seam 用裸 `node --test` 直接 import 扩展，无 node_modules 依赖且 ESM 不走 NODE_PATH，无法解析该包。自实现保持零依赖、可单测。
- 拦截规则：`image_paths` 非字符串数组 / 空项 / >5 张 / 文件不存在 / 非图片 → 工具层 `toolError`（沿用 `ERROR_PREFIX`），不发网络请求。
- 常量：`watermark:false`（当前公测免费去水印）、`output_format:"png"`、`size:"auto"`；本期不做可配置（README 写明官方默认与可调字段）。
- 计费：usage 映射官方 `input_tokens/output_tokens/total_tokens`，cost 置 0（TokenPlan 积分制，不映射美元成本）。

实现细节：provider 显示名 `SenseNova` / `SenseNova Images`（与 id `sensenova` / `sensenova-images` 区分），/model 更易辨识。

## 版本与验证

- 全部依据锁 pi **0.99.1** 本地打包产物（`dist/core/model-config.js` schema、`dist/bundle/chunks/openai-completions-*.js`、`dist/core/provider-composer.js`）与仓库内官方文档快照（`docs/LLM API 服务平台.md`，与桌面源文件一致、仅精简 frontmatter；正文行号 = 桌面版 − 5）；不采用未在本地 schema 出现的字段。
- 认证两种途径：`/login`（凭据存 `agent-dir/auth.json`，不应读取）或 `$SENSENOVA_API_KEY` 环境变量；提供 `.env.example`（无真实密钥）。

## 明确不做

- Anthropic `/v1/messages` 与 Responses 兼容端点（本需求聚焦 Chat Completions）。
- U 系列作为对话模型（官方明示不支持，且走独立图像接口）。
- `GET /v1/models` 动态刷新（官方模型总览为固定 7 个）。
- 无官方依据、无复现错误的兼容猜测（如"response_format 一律拒收"类断言）。

**Status**: accepted