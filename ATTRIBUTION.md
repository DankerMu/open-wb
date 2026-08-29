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

## 4. 本仓库自有内容

- `app-reference/analysis/*.md` —— 结构分析文档（仓库作者）
- `resource/workbuddy-live-demo.html` —— 功能演示原型（仓库作者）；知识库部分的参照实现见第 3 节；其中设计 token 取自 WorkBuddy 5.3.11 的设计 token 文件（`wb-design-tokens-master.css` / `design-tokens.json`）,文件头注释已标注来源。
- `resource/backend-research.md` —— 后端选型研究（仓库作者）。
- **许可**：本仓库自有内容以根级 `LICENSE`（**Apache License 2.0**）发布——选型依据是未来将吸收的 RAGFlow 源码即为 Apache-2.0,MIT 的 omp 内容与之兼容（保留其声明即可）。该许可**不**延及第 1、2 节的上游应用与捆绑第三方内容,也不延及 `resource/` 下 gitignore 的上游参考副本。
