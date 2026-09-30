# `/sensenova-image` 命令与用户级默认配置（命令配置层）

决定：注册 `/sensenova-image` 命令作为用户直达生图通道，与 chat 工具 `sensenova_generate_image` **共享同一生成核心**；新增用户级配置文件 `<agent dir>/extensions/sensenova-compat.json`（`model` / `size` / `output_format` / `watermark` / `output_dir`），命令与工具共同读取；优先级 显式 flag（`--model`）> 命令配置 > 生图常量；命令结果**不写入 transcript**。

## 为什么需要命令与配置

- chat 工具是 agent 编排入口：每次生图都经模型决策，有延迟与不确定性（选错模型、路径表述错误、可能跳过调用），且需向模型叙述文件路径。
- 命令提供确定性直通：`/sensenova-image gen "prompt"` 一步完成；`edit` 用 `@`-token 引用路径，直接复用 pi 内置文件补全（命令参数区内仍生效，已在 pi 0.99.1 源码核实），零自研补全代码。
- 配置持久化让可调字段（此前是硬编码常量，改需动源码）变成用户可控默认值。

## 关键取舍

- **单命令 + 子命令**（gen / edit / settings）而非多个命令：适配 pi 命令菜单与补全机制；`getArgumentCompletions` 只补全子命令与 settings 键/值（返回项整体替换参数段文本，故 value 带完整前缀），路径补全完全交给 pi 内置 `@`。
- **配置同时作用于命令与工具**：单一事实源；代价是工具每次执行读一次配置文件（可忽略）。
- **agent 目录解析**用 `PI_CODING_AGENT_DIR ?? ~/.pi/agent`，不 import 宿主包——延续 ADR 0002 的零运行时依赖。
- **原子写**（临时文件 + rename）且校验通过才落盘；配置损坏 → 报错并回退生图常量，生图可用性不中断。
- **配置文件不含凭据**：认证仍走 `/login` 或 `$SENSENOVA_API_KEY`。
- **命令结果不入 transcript**：命令是纯工具，不参与模型上下文（与工具结果进 transcript 的语义不同）。

**Status**: accepted
