# 仓库重构为标准 pi 包布局（可发布到 npm）

决定：把仓库从"根目录单文件扩展 + 散落文档"重构为 pi 官方包格式——`package.json`（`pi.extensions` 显式 manifest + `pi-package` keyword）+ 约定 `extensions/` 目录 + 标准 `test/` 目录。动机是后续发布到 npm（`pi install npm:...`），让安装路径从手动复制文件升级为包管理器管理。

## 为什么是 pi 包格式而非继续手动复制

- pi 0.99.1 用 `pi install`（npm / git / 本地路径三源）安装与更新包，按包名/URL/路径识别身份、提供资源选择（settings 对象过滤）与依赖管理；手动复制 `.ts` 到 `~/.pi/agent/extensions/` 仍是合法兜底，但无法版本化与更新。
- 发布物是包的源（`extensions/` 内 .ts），pi 运行期用 jiti 直接加载 TypeScript，**无需构建步骤**（`package.json` 不设 build，`files` 白名单只发源码）。

## 关键取舍

- **零运行时依赖**：扩展只 import node 内置模块，不 import 任何 host 包（`@earendil-works/pi-*`、`typebox`）。因此不声明 `peerDependencies`（声明它们仅当扩展 import 宿主时才有意义），也**没有**"误把 host 包放进 `dependencies` 导致重复实例"的风险（packages.md 专门警告的坑）。将来若扩展要 import 宿主包的**运行期入口**（例如 `detectSupportedImageMimeTypeFromFile`），需同步改为 `peerDependencies: { "@earendil-works/pi-coding-agent": "*" }`——但注意这只是让 **pi 运行期**能解析：仓库测试 seam 以裸 `node --test` 直跑（见 ADR 0001 生图节），host 包的 peer 依赖在该环境下不会 materialize，测试路径依旧无法解析该包，需另行处理（如把宿主相关逻辑藏在注入 seam 之外）。
- **`sensenova.models.json` 不是包资源**：chat 层是 models.json 纯配置，随包自动加载会污染项目配置；保持"手动合并片段"为交付物，README 说明。
- **显式 manifest 而非约定发现**：`pi.extensions: ["./extensions/sensenova-images.ts"]`——单扩展场景两种写法等价，显式声明让包内容一目了然、防止未来新增扩展被意外发现。
- **`files: ["extensions/"]` 白名单**：npm 发布不含 docs/、测试、AGENTS 等仓库元文件（npm 自动附带 README/LICENSE 除外），保持 tarball 最小。

## 测试与验证

- 重构保持 seam 不变：`test/sensenova-images.test.mjs` 以相对路径 import 扩展源码，`npm test`（`node --test test/`）仍零依赖直跑。
- 安装方式变更（`pi install` / `pi -e`）属 pi 侧行为，真实装载验证为手动项（需在 pi 会话内执行）。

**Status**: accepted