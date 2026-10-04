# pi-sensenova-compat

[English](README.md)

为 [pi](https://pi.dev) 接入商汤 SenseNova 的 U 系列图像模型：一个轻量扩展注册对话内工具 **`sensenova_generate_image`**（provider `sensenova-images`），安装、认证后即可在对话里直接生图/改图。

包还附带 5 个 SenseNova chat 模型的 `models.json` 配置片段——**这部分是手动的**：需要你自己把它合并进 `~/.pi/agent/models.json`（见下方安装第 1 步）。chat 层不在本包的自动化范围内。

chat 思考档位注意：官方文档对 `sensenova-6.8-flash-lite` / `deepseek-v4-flash` 的档位表有误——文档写 `max`，实际发送 `reasoning_effort:"max"` 会被服务端拒绝（400），合法档为 low/medium/high/xhigh/none，本包把 `max`/`xhigh` 档都映射到 `xhigh`（实测结论，详见 ADR 0001）。

**兼容立场**：图片工具只走 SenseNova 官方公开端点（`/v1/images/generations`、`/v1/images/edits`）；chat 配置用 pi 自带的 `openai-completions` provider 与 `models.json` 官方 schema。不引入私有协议、不自写流解析、不改动 pi 内部。官方文档快照存在 `docs/LLM API 服务平台.md`，所有行为决策记录在 ADR——两者都可对照上游复核。

## 快速开始

1. **安装**

   ```sh
   pi install npm:pi-sensenova-compat
   ```

   （git：`pi install git:github.com/hu3rror/pi-sensenova-compat`；本地：`pi install C:/绝对/路径/pi-sensenova-compat`——相对路径从 settings 文件所在目录解析，用绝对路径；手动兜底：把 `extensions/sensenova-images.ts` 复制到 `~/.pi/agent/extensions/`。）

2. **认证**：`/login` 录入 `SenseNova Images`（图片工具用）；只用 chat 模型时才需要再录 `SenseNova`。或 `export SENSENOVA_API_KEY=sk-...`（两 provider 共用）。

3. **在对话里直接用**

   - 文生图：让 agent 调用 `sensenova_generate_image`，如「画一只白色海豹的插画」。PNG 写入 `<cwd>/.sensenova/`，工具返回本地路径。
   - 图生图：`image_paths` 传本地图片（第 1 张为主编辑图、至多 5 张），如「把 C:/.../photo.png 的背景改成冬天，保留主体」。工具以完整 Data URL（`data:image/{format};base64,…`）发送给 `/v1/images/edits`——完整流程见[对话内生图](#对话内生图)。
   - 安装完成后 `/reload` 一次：`SenseNova Images` 由扩展注册，装包即出现；`SenseNova`（chat）只有在你合并配置片段（安装第 1 步）之后才会出现。某 provider 缺失通常是该 provider 的凭据未配置。

## 安装

1. **合并配置**：把 `sensenova.models.json` 中 `providers.sensenova` 合入 `~/.pi/agent/models.json`（文件不存在则复制整文件）。
2. **安装 pi 包**（四选一）：
   - 本地目录（开发期）：`pi install C:/绝对/路径/pi-sensenova-compat`，或 `pi -e ./` 单次试跑；
   - git：`pi install git:github.com/hu3rror/pi-sensenova-compat`；
   - npm：`pi install npm:pi-sensenova-compat`；
   - 手动兜底：把 `extensions/sensenova-images.ts` 复制到 `~/.pi/agent/extensions/`（pi 扩展自动发现只认 `.ts`/`.js` 文件）。
3. **认证**（二选一）：`/login` 两次录入同一个 key（`SenseNova` + `SenseNova Images`），或设 `SENSENOVA_API_KEY`（两 provider 共用）。
4. **重载** `/model` 并验证。新扩展/新工具需重启 pi 或 `/reload` 后生效。

## 斜杠命令

扩展同时注册 **`/sensenova-image`** 命令——确定性直通通道，不经 agent 决策（上面的对话内工具保留给 agent 编排生图；两者共享同一核心）。

- `gen "<prompt>"`——文生图（等同省略 `image_paths`）。
- `edit @a.png @b.png "<prompt>"`——图生图：至多 5 个 `@` 前缀路径，第 1 张为主编辑图；不带 `@` 的已存在图片文件同样算路径。输入 `@` 后 Tab 即用 pi 内置模糊文件补全。
- `settings`——显示当前生效默认值与配置文件路径；`settings <key> <value>`——校验并持久化；`settings reset`——清空配置。
- `--model sensenova-u1.5-lite`——单次调用的临时覆盖（任意位置）。
- 优先级：显式 `--model` flag > 配置文件 > 硬编码常量。命令结果不写入 transcript。

保存的默认值在 `~/.pi/agent/extensions/sensenova-compat.json`（agent 目录遵循 `PI_CODING_AGENT_DIR`），键：

| 键 | 取值 |
| --- | --- |
| `model` | `sensenova-u1.5-fast`（默认）/ `sensenova-u1.5-lite` |
| `size` | `auto`（默认）或 `WxH`，32 的倍数、512–4096、比例 ≤3:1 |
| `output_format` | `png`（默认）/ `jpeg` / `webp` |
| `watermark` | `true` / `false`（默认） |
| `output_dir` | 相对 cwd（默认 `.sensenova`）或绝对路径 |
| `image_in_result` | `true` / `false`（默认） | 是否把生成图作为图片块附到对话内工具结果。支持内联图片的终端（kitty/iTerm2 协议）会在对话里直接显示；同时该图片块会进入模型上下文，在视觉模型上增加输入 token，因此默认关闭，工具只返回保存路径。 |

这些同样作用于对话内工具。配置文件不含凭据（认证仍走 `/login` 或 `$SENSENOVA_API_KEY`）。

## 对话内生图

扩展注册对话内工具 **`sensenova_generate_image`**，对话里直接调用即可生图（如「画一张架构图」），无需切换模型或手动调接口。

- 参数：
  - `prompt`（必填）：图片描述；图生图时写编辑指令，说明要改什么、保留什么。
  - `model`（可选）：`sensenova-u1.5-fast`（默认，较快）或 `sensenova-u1.5-lite`（更高质量）。
  - `image_paths`（可选）：本地图片路径数组，绝对路径或相对 cwd；带 1 张以上即走 `/v1/images/edits` 图生图，第 1 张为主编辑图、至多 5 张；省略则纯文生图。
- 图生图流程：工具读取各文件 → 按文件头嗅探 mime（png/jpeg/gif/webp/bmp）→ 拼完整 Data URL（`data:image/{format};base64,…`）→ 发 `/v1/images/edits`。坏路径/非图片/超 5 张在工具层拦截，返回错误且不发网络请求。服务端接受 PNG/JPEG/WebP、≤10MB、宽高 [256,4096] px、比例 ≤2:1，超分辨率图需客户端先降采样。
- 产物：PNG 写入 `<cwd>/.sensenova/`，文件名 `时间戳-描述slug.png`；工具返回本地路径（不用会过期的 URL）。图生图返回 `Image edited and saved to …`，文生图返回 `Image generated and saved to …`。开启 `image_in_result: true` 时，工具额外把图片作为图片块返回，支持内联图片的终端会在对话中直接渲染（见[斜杠命令](#斜杠命令)）。
- 凭据：与 provider 共用 `SenseNova Images` 的 `/login` 密钥或 `$SENSENOVA_API_KEY`；缺凭据时返回错误并说明配置方法。

## 仓库结构

本仓库即一个 pi 包（`package.json` 带 `pi-package` keyword 与 `pi.extensions` 显式声明）：

```text
pi-sensenova-compat/
├── package.json                    # pi 包清单
├── extensions/
│   └── sensenova-images.ts         # 扩展层：provider + 工具，单文件
├── test/
│   ├── sensenova-images.test.mjs   # 主 seam 单元测试（工具 + 核心）
│   └── sensenova-command.test.mjs  # 命令/配置单元测试
├── sensenova.models.json           # chat 层配置片段（手动合并，非包资源）
├── docs/                           # ADR / 官方快照
└── README.md / README.zh-CN.md
```

## 生图常量与官方可调字段

| 字段 | 本期值 | 官方默认/说明 |
| --- | --- | --- |
| `watermark` | `false` | 官方默认 `true`（SenseNova Logo）；`false` 当前公测免费无水印 |
| `output_format` | `"png"` | `png` / `jpeg` / `webp` |
| `size` | `"auto"` | 显式常量需 32 的倍数、512–4096、比例 ≤3:1；`auto` 时 edits 自动适配主图 |
| `response_format` | `"b64_json"` | `b64_json` / `url`（`url` 链接 24 小时过期，故用 `b64_json` 直传） |

以上是**默认值**；`watermark` / `output_format` / `size` / `image_in_result` 可经 `settings` 按用户覆盖（见[斜杠命令](#斜杠命令)），`model` / `output_dir` 同理。官方可调但本期不改：`prompt_extend`（默认 `true`，自动润色 prompt）、`n`（仅 `1`）、参考图（`/v1/images/edits` 必带 ≥1 张、至多 5 张）。改这些字段 = 改 `extensions/sensenova-images.ts` 常量。

## 测试

```sh
npm test
```

零依赖：测试文件直接 import 扩展 `.ts`，经注入的 fetch/now seam 验证请求构造、响应映射、错误路径。

## 文档

- 架构与取舍：`docs/adr/0001-sensenova-integration-architecture.md`、`docs/adr/0002-pi-package-layout.md`、`docs/adr/0003-sensenova-image-command-and-config.md`、`docs/adr/0004-pi-1.0.2-revalidation.md`
- 域术语：`GLOSSARY.md`
- 规格：GitHub issue #1、#2
- 官方文档快照：`docs/LLM API 服务平台.md`