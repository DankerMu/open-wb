# open-workbuddy

内网多用户 AI Agent Web 服务。三个自研/组装组件：**app-server**（业务后端，TS/Fastify）、
**web SPA**（React + Vite）、**kbservice**（知识库，Python）；agent 执行由 **omp**（冻结 v18.0.10）
以每会话子进程 `--mode rpc` 承担。行为基准是 `resource/workbuddy-live-demo.html`（demo 能点出来的行为就是需求）。

## 从哪里读起

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 工程契约：命令面、验证矩阵、边界、执行索引 |
| [CONTEXT.md](CONTEXT.md) | 领域术语、限界上下文、不变量 |
| [docs/architecture/system.md](docs/architecture/system.md) | 顶层架构基准；决策账本在 [docs/adr/](docs/adr/) |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | 功能清单（稳定 F-ID）与 13 个子阶段 |
| [PLAN.md](PLAN.md) | 建设方案与阶段账本 |

## 目录结构

```
server/         app-server（业务后端：SSO/会话/工作空间/权限/沙箱/审计）
web/            浏览器 SPA（Playwright UI 走查在 web/e2e）
kbservice/      知识库服务（P2 起吸收 RAGFlow，Apache-2.0，义务见 ATTRIBUTION.md §3）
smoke/          Hurl HTTP 冒烟用例
openspec/       OpenSpec 规格与变更（含归档）
docs/           架构基准、ADR、流水线问责日志
resource/       行为基准原型 + 后端选型研究 +（gitignore 的）上游参考克隆
app-reference/  上游应用只读副本（gitignore；仅 analysis/ 可写）
scripts/        守卫脚本    .githooks/  git hooks    .github/    CI
```

## 开发

```bash
make setup   # 安装依赖与 hooks
make check   # lint + typecheck + test + anti-drift（合入前必须绿）
make dev     # 起 app-server
```

完整命令面与验证矩阵见 `AGENTS.md`。合入只走 feature 分支 → PR → `all-checks-passed`。

## 归属与许可

- **本仓库代码**：Apache-2.0，见 [LICENSE](LICENSE)。
- **上游应用**：WorkBuddy AI 及其内部代码版权归版权持有者所有 —— `Copyright © 2026 Tencent Technology (Shenzhen) Company Limited`（见 `app-reference/WorkBuddyAI.app/Contents/Info.plist` 的 `NSHumanReadableCopyright`）。`app-reference/` 全树只读、不入库、不进任何产物。
- **捆绑第三方库**：上游应用内捆绑的第三方代码保留各自版权与许可（如 xterm.js、相关 FFmpeg/QuickJS 代码的注释声明，见 `ATTRIBUTION.md`）。
- **demo 原型**：`resource/workbuddy-live-demo.html` 为本仓库作者所写，设计 token 来源于上游设计 token 文件，已在文件头标注。
- 完整归属清单与观察到的版权注释见 **[ATTRIBUTION.md](ATTRIBUTION.md)**。
