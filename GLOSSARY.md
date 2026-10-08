# pi-sensenova-compat

把商汤 SenseNova（TokenPlan，`token.sensenova.cn/v1`）接入 pi 编码代理的适配层：chat 走配置、生图走扩展。

## Language

**SenseNova**:
商汤的 LLM API 服务平台（TokenPlan 网关）。OpenAI 兼容 chat 端点 + 独立 `/v1/images/*` 生图端点，Bearer 认证。
_Avoid_: 商汤大模型（泛指）、SenseTime

**配置层（models.json provider）**:
在 `~/.pi/agent/models.json` 里用 `providers.sensenova` 声明的 chat 模型集合（5 个），`api:"openai-completions"` 委托 pi 内置实现；只许配置元数据与 compat，不许代码。
_Avoid_: provider 配置、兼容层

**扩展层（sensenova-images provider）**:
通过扩展注册的 provider `sensenova-images`，承载 U 系列图像模型（2 个）与 `generateImages` 实现；是唯一允许放代码的地方。
_Avoid_: 生图扩展、images provider（口语可）

**chat 模型**:
`deepseek-flash`、`deepseek-v4-flash`、`glm-5.2`、`kimi-k3`、`sensenova-6.8-flash-lite`。均默认思考、支持 tools；仅 deepseek 两兄弟要求工具轮回传 `reasoning_content`。
_Avoid_: 对话模型（与 pi 内置 provider 的"对话模型"混淆）

**U 系列**:
图像创作模型 `sensenova-u1.5-lite` / `sensenova-u1.5-fast`。不是 chat 模型；走 `/v1/images/generations`（文生图）与 `/v1/images/edits`（图生图），仅 `n=1`，URL 返回 24 小时过期。
_Avoid_: 文生图模型、U 模型

**思考档位（reasoning_effort）**:
官方思考强度取值；pi 侧档位（off…max）经 `thinkingLevelMap` 映射到官方值；`off` 映射 `"none"`，未选档不发参数、保留官方默认思考。**注意档位值以实测为准而非官方列表**：flash-lite / deepseek-v4 服务端合法值是 low/medium/high/**xhigh**/none（文档写 max，实测 `"max"` 返 400），故其 `max` 与 `xhigh` 档均映射 `"xhigh"`。
_Avoid_: thinking 开关（GLM 拒绝 `thinking.type:"disabled"`，一条路走 `reasoning_effort`）

**max tokens 字段名**:
`max_tokens`（4 个 chat 模型 + 默认）与 `max_completion_tokens`（仅 `kimi-k3`）——通过包口 `maxTokensField` compat 选择的请求字段名。
_Avoid_: 输出上限、token 上限

**思考历史回传**:
pi 在流式解析时识别 `reasoning_content` / `reasoning` / `reasoning_text` 任一增量字段，回传历史时按原字段名写回 assistant 消息（deepseek 系工具轮必须回传，否则 400）。
_Avoid_: 思考留档

**reasoning_effort 兼容映射（仅 deepseek-flash）**:
官方将 minimal→low、medium/xhigh→high、ultra→max 的档位归一，`thinkingLevelMap` 显式落档。
_Avoid_: 官方映射表（口语）

**生图常量**:
`watermark:false`、`output_format:"png"`、`size:"auto"`、`response_format:"b64_json"`。硬编码默认值，可被「命令配置」覆盖（见「覆盖优先级」）。README 保留官方默认与可调字段说明。
_Avoid_: 默认水印（指 `watermark:true`）

**图片命令（sensenova-image 命令）**:
`/sensenova-image` 命令：用户直达生图通道，不经模型决策。子命令 `gen`（文生图）/ `edit`（图生图）/ `settings`（管理「命令配置」）。与「工具」（`sensenova_generate_image`，agent 编排入口）共享同一核心，是两个入口而非两个实现。
_Avoid_: 命令工具（把两入口混为一谈）

**命令配置（sensenova-compat.json）**:
用户级配置文件（agent 目录下 `extensions/sensenova-compat.json`），覆盖「生图常量」默认值，键为 `model` / `size` / `output_format` / `watermark` / `output_dir`；同时作用于命令与工具两个入口。
_Avoid_: 扩展配置（与 pi 自身 settings 混淆）、配置文件（太泛）

**覆盖优先级**:
显式参数（命令 `--model` flag）> 命令配置 > 生图常量。
_Avoid_: 优先级（太泛）

**图生图路径引用**:
`edit` 子命令中以 `@` 前缀 token 引用本地图片路径（触发 pi 内置文件补全），解析时剥 `@`；至多 5 张。
_Avoid_: @ 语法（口语可）

**发布流**:
push `v*` tag 触发 `.github/workflows/publish.yml`（Trusted Publisher / OIDC，零 token），**直接流**——CI 经 OIDC 直接 `npm publish`，tag push 即发布，全自动无人工闸门；回滚 `npm unpublish <version>`（72 小时内，需本地登录态；超期 `npm deprecate`）。首发（包尚未存在于 registry）由维护者本地 `npm publish` 后绑定 Trusted Publisher，CI 自下一版本启用。
_Avoid_: 暂存流（模式 A）、token 认证（误把 npm token 放进 CI）