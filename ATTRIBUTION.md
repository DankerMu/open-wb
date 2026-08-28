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

## 3. 本仓库自有内容

- `app-reference/analysis/*.md` —— 结构分析文档（仓库作者）
- `resource/workbuddy-live-demo.html` —— 功能演示原型（仓库作者）；其中设计 token 取自 WorkBuddy 5.3.11 的设计 token 文件（`wb-design-tokens-master.css` / `design-tokens.json`）,文件头注释已标注来源。
