# Attribution —— 归属与许可清单

按「保留归属」原则整理。以下为依据仓库内文件记录的归属清单；**不构成法律意见**,若与上游正式许可文件冲突,以上游为准。

## 1. 上游应用：WorkBuddy AI

- 名称/版本：WorkBuddy AI, v5.4.2（Bundle 5.4.2）；bundle id：`com.workbuddy.workbuddy-ai`
- 位置：`app-reference/WorkBuddyAI.app/`（原始应用包）、`app-reference/app_asar/`（app.asar 解包副本）
- 版权声明（来自应用自身元数据）：
  `Copyright © 2026 Tencent Technology (Shenzhen) Company Limited`
  —— 依据 `app-reference/WorkBuddyAI.app/Contents/Info.plist` 的 `NSHumanReadableCopyright`
- 内嵌组件：`@tencent-ai/codebuddy-code` v2.132.0-dev（CodeBuddy Code,腾讯）,作为内置 agent CLI 随应用分发（见 `app-reference/analysis/03-cli-backend.md`）

## 2. 捆绑第三方库（仓库内观察到的版权注释）

- **xterm.js** `© 2014-2024 The xterm.js authors. All rights reserved. @license MIT`
- **Fabrice Bellard** `© 2011`（FFmpeg/QuickJS 相关代码,以注释原文为准）
- 位置：`app-reference/WorkBuddyAI.app/Contents/Resources/app.asar.unpacked/cli/dist/web-ui/assets/index-DaT8fnwQ.js:733-737`

> 注：以上为仓库内可观察到的注释,并非完整清单。应用内还包含其它组件（如 `turing_sdk`、`@tencent/qimei-node` 等原生模块、`default_app.asar`、Electron 运行时);分发前请以应用自带的许可/供应商协议为准。

## 3. 参照/派生的开源项目

- **RAGFlow** —— `Apache License 2.0`,版权归 InfiniFlow 及其贡献者（https://github.com/infiniflow/ragflow）
  - 用途：`resource/workbuddy-live-demo.html` 的知识库功能,其**切片模板划分**（`naive`/`qa`/`manual`/`paper`/`book`/`laws`/`presentation`/`table`/`one`/`picture`/`email`/`tag`,即 RAGFlow 的 `chunk_method`）与**深度版面解析 + 模板化切片 + 召回/重排**的管线设计参照 RAGFlow 实现。
  - 义务：Apache-2.0 要求保留版权声明、许可证副本与变更说明。**若后续实际吸收 RAGFlow 源码**（而非仅参照设计）,须在仓库内附 `LICENSE-RAGFlow`（Apache-2.0 全文）与 `NOTICE`,并在被派生的文件头标注来源与修改点。当前仅为原型层面的概念参照,尚未纳入其源码。

- **oh-my-pi (omp)** —— `MIT License`,版权链：Mario Zechner (2025) → Can Bölük (2025-2026) → Stencil Labs, Inc. (2026)（https://github.com/can1357/oh-my-pi）
  - 用途：规划中的 agent 后端。决策（2026-08-29）：**fork 并定死在 v18.0.10 / commit `33cc6b9a`**,后续不跟进上游;减肥与集成方案见 `resource/backend-research.md` §2。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本。fork 仓库须保留其 `LICENSE`;**若 omp 派生二进制进入本项目发行物**,发行物内须附带该 MIT 声明。当前仅为本地参考副本（`resource/oh-my-pi`,已 gitignore）,未分发。

- **lucide / lucide-react** —— `ISC License`,版权归 Lucide Icons and Contributors（部分图标派生自 Feather,© Cole Bemis,MIT,声明同在该包 `LICENSE`）（https://github.com/lucide-icons/lucide）
  - 用途：`web/` 前端图标,经 `web/src/ui/icon.tsx` 单一 `Icon` 组件取用,构建时打包进 `web/dist`,运行时零网络请求。
  - 义务：ISC 要求在副本中保留版权与许可声明;`lucide-react` 包自带 `LICENSE`,**若 `web/dist` 进入本项目发行物**,发行物须附带该 ISC 声明。

- **Radix UI Primitives** —— `MIT License`,版权归 WorkOS（https://github.com/radix-ui/primitives）
  - 用途：`web/src/ui/` 无样式交互基元。已安装 `@radix-ui/react-switch`（#276,`Switch` 基元）、`@radix-ui/react-dialog`（#277,`Dialog`/`ConfirmDialog`/`Drawer` 基元）、`@radix-ui/react-dropdown-menu`、`@radix-ui/react-popover`、`@radix-ui/react-tooltip`、`@radix-ui/react-radio-group`（#278,`Menu`/`Popover`/`Tooltip`/`SegmentedControl` 基元）、`@radix-ui/react-toast`（#279,`ToastProvider`/`useToast` 基元）。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本;安装后随打包产物分发时须附带该 MIT 声明。

- **radix-ui** —— `MIT License`,版权归 WorkOS（https://github.com/radix-ui/primitives）
  - 用途：Radix UI Primitives 的合包（单一入口再导出各基元）,只供拷入层 `web/src/components/ui/` 导入;与上条保留的各 `@radix-ui/*` 单包并存到旧基元层退役。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本;随打包产物分发时须附带该 MIT 声明。

- **shadcn/ui** —— `MIT License`,版权归 shadcn（https://github.com/shadcn-ui/ui）
  - 用途：`web/src/components/ui/` 的组件源码由其 registry（`radix-nova` 版式,配置见 `web/components.json`）拷入,拷入后只做颜色变量、中文文案、格式化、`cn` 导入归一（`@/lib/utils`）、严格 TS 选项下的纯类型适配与把被原文丢弃的调用方 `children` 或属性原样透传给底层基元（只转发、不写默认值）六类修改;`dialog` 随会话页的 html 产物预览拷入（s1f-chat-surface 任务 7.2）,未新增依赖;`resizable` 随 s1f-files-page 任务 23.1 拷入,新增依赖 `react-resizable-panels`;组件依赖 `class-variance-authority`（Apache-2.0）、`clsx`（MIT）、`tailwind-merge`（MIT）。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本;拷入的源码随打包产物分发时须附带该 MIT 声明。

- **react-resizable-panels** —— `MIT License`,版权归 Brian Vaughn（https://github.com/bvaughn/react-resizable-panels）
  - 用途：shadcn/ui `resizable` 的依赖（可拖拽、键盘可达的分栏与分隔线）,只供拷入层 `web/src/components/ui/resizable.tsx` 导入,会话页工作空间侧边栏的分隔线用;随 s1f-files-page 任务 23.1 加入,此刻尚无应用层调用方。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本;包自带 `LICENSE.md`,随打包产物分发时须附带该 MIT 声明。

- **Tailwind CSS** —— `MIT License`,版权归 Tailwind Labs, Inc.（https://github.com/tailwindlabs/tailwindcss）
  - 用途：`web/` 样式引擎。`tailwindcss`（theme / preflight / utilities 三段,经 `web/src/styles.css` 分层导入）与构建插件 `@tailwindcss/vite`;生成的 CSS 构建时打包进 `web/dist`,运行时零网络请求。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本;preflight 等样式随打包产物分发时须附带该 MIT 声明。

- **tw-animate-css** —— `MIT License`,版权归 Wombosvideo（https://github.com/Wombosvideo/tw-animate-css）
  - 用途：Tailwind 4 的进出场动画工具类（shadcn/ui 组件依赖）,经 `web/src/styles.css` 导入,构建时打包进 `web/dist`。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本;随打包产物分发时须附带该 MIT 声明。

- **tw-shimmer** —— `MIT License`,版权归 AgentbaseAI Inc.（https://github.com/assistant-ui/assistant-ui,`packages/tw-shimmer`）
  - 用途：Tailwind 4 的闪光（shimmer）工具类（assistant-ui registry 的 `reasoning`、`tool-group` 组件依赖,会话页深度思考折叠块在回合进行中的标题、工具调用组在有步骤运行时的摘要行用它）,经 `web/src/styles.css` 导入,构建时打包进 `web/dist`。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本;随打包产物分发时须附带该 MIT 声明。

- **assistant-ui** —— `MIT License`,版权归 AgentbaseAI Inc.（https://github.com/assistant-ui/assistant-ui）
  - 用途：会话页消息线程的运行时与无样式基元。`@assistant-ui/react`（`useExternalStoreRuntime`、`ThreadPrimitive`、`MessagePrimitive`）与 `@assistant-ui/react-markdown`（助手正文的 Markdown 渲染,内含 `react-markdown`,MIT,版权归 Espen Hovlandsdal）;`web/src/components/assistant-ui/` 的组件源码由其 registry 拷入（`markdown-text` 及其依赖 `tooltip-icon-button`、`use-copy-to-clipboard`;`reasoning` 及其依赖 `elements/reasoning`;`tool-group`;两者用到的 shadcn/ui `collapsible` 拷入 `web/src/components/ui/`）,拷入后的修改限制同 shadcn/ui 条目。构建时打包进 `web/dist`,不启用其云服务适配,运行时零网络请求。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本;拷入的源码与打包产物分发时须附带该 MIT 声明。

- **remark-gfm** —— `MIT License`,版权归 Titus Wormer（https://github.com/remarkjs/remark-gfm）
  - 用途：助手正文 Markdown 的 GFM 扩展（表格、删除线、任务列表、自动链接）,由拷入的 `markdown-text` 使用,构建时打包进 `web/dist`。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本;随打包产物分发时须附带该 MIT 声明。

- **yauzl** —— `MIT License`,版权归 Josh Wolfe（https://github.com/thejoshwolfe/yauzl）
  - 用途：`server/` 压缩包列表读取 zip 的中央目录（`server/src/workspaces/archive.ts`,s1f-files-page 任务 10.2）,只列成员名与大小,不解压任何成员;运行时依赖,随 server 安装。其唯一的间接依赖 `pend`（MIT,版权归 Andrew Kelley）随之安装;类型声明 `@types/yauzl`（MIT）只在开发期使用。
  - 义务：MIT 要求在副本或实质部分中保留版权声明与许可文本;两个包各自带 `LICENSE`,**若 server 的 `node_modules` 进入本项目发行物**,发行物须附带这两份 MIT 声明。

## 4. 本仓库自有内容

- `app-reference/analysis/*.md` —— 结构分析文档（仓库作者）
- `resource/workbuddy-live-demo.html` —— 功能演示原型（仓库作者）；知识库部分的参照实现见第 3 节；其中设计 token 取自 WorkBuddy 5.3.11 的设计 token 文件（`wb-design-tokens-master.css` / `design-tokens.json`）,文件头注释已标注来源。
- `resource/backend-research.md` —— 后端选型研究（仓库作者）。
- **许可**：本仓库自有内容以根级 `LICENSE`（**Apache License 2.0**）发布——选型依据是未来将吸收的 RAGFlow 源码即为 Apache-2.0,MIT 的 omp 内容与之兼容（保留其声明即可）。该许可**不**延及第 1、2 节的上游应用与捆绑第三方内容,也不延及 `resource/` 下 gitignore 的上游参考副本。
