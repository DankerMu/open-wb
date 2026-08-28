# open-workbuddy

WorkBuddy AI 桌面应用（macOS arm64, v5.4.2）的参考副本、结构分析文档与功能演示原型。

## 目录结构

```
open-workbuddy/
├── app-reference/                  # WorkBuddy AI 参考副本（上游应用）
│   ├── WorkBuddyAI.app/            # 原始应用包（v5.4.2, com.workbuddy.workbuddy-ai）
│   ├── app_asar/                   # app.asar 解包副本（源码可读, 含 //#region 源路径）
│   └── analysis/                   # 只读结构分析文档（主进程/渲染层/CLI/原生层）
├── resource/
│   └── workbuddy-live-demo.html    # 功能演示原型（设计 token 取自 WorkBuddy 5.3.11, 见文件头注释）
└── .omp/                           # 本地 harness 技能目录（开发工具链, 非仓库发布物）
```

## 归属与许可

- **上游应用**：WorkBuddy AI 及其内部代码版权归版权持有者所有 —— `Copyright © 2026 Tencent Technology (Shenzhen) Company Limited`（见 `app-reference/WorkBuddyAI.app/Contents/Info.plist` 的 `NSHumanReadableCopyright`）。
- **捆绑第三方库**：应用内捆绑的第三方代码保留各自版权与许可（如 xterm.js、相关 FFmpeg/QuickJS 代码的注释声明, 见 `ATTRIBUTION.md`）。
- **本仓库内容**：`app-reference/analysis/` 与 `resource/workbuddy-live-demo.html` 为本仓库作者所写, 其中 demo 的设计 token 来源于上游设计 token 文件, 已在文件头标注。
- 完整归属清单与观察到的版权注释见 **[ATTRIBUTION.md](ATTRIBUTION.md)**。

> 仓库暂未设置根级 LICENSE 文件；如需公开发布, 请先补充许可声明并对上游材料按 ATTRIBUTION.md 保留归属。
