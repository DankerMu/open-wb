# demo-parity-acceptance Specification

## Purpose
TBD - created by archiving change ui-shots-script. Update Purpose after archive.
## Requirements
### Requirement: ui-shots 截图对产物
`make ui-shots`（配方 `npm run --silent ui-shots --workspace web`：`--silent` 压掉 npm 失败横幅中的本机绝对路径，退出码不变）→ `web/e2e/ui-shots.mjs`（Playwright chromium，取自 `@playwright/test`，与 ui-walk 同一依赖）SHALL 只消费由 caller 启动、可从 `UI_SHOTS_BASE_URL`（缺省 `http://127.0.0.1:3000`）访问的真实服务与仓库内 `resource/workbuddy-live-demo.html`（`file://`），不得 build/start/stop 服务、不得安装或下载浏览器、不得清理 caller 的 DB/沙箱/temp；启动时 `GET /api/healthz` 非 200 即非零退出且不截图。目标 SHALL 对六个格（视口 `1440×900`、`1024×768`、`390×844` × `light`/`dark`）截取五个态，态名固定为 `login-default`（登录前）、`chat-welcome`（登录后 `/` 无会话）、`chat-done`（一次已完成回合的会话）、`files-readme`（已选 `smoke-fixture` 且预览 `readme.md`）、`settings-default`：app 侧主题经 `addInitScript` 预置 `localStorage.workbuddy-theme`，以 `zhangsan`/`demo` 登录；`smoke-fixture` 工作空间经 `GET /api/workspaces` 查找、缺失时经 `POST /api/workspaces` 创建；`chat-done` 由脚本在首格新建会话、发送固定提示 `请用一句话介绍你自己` 并等待会话 status 为 `已完成`（上限 60s）后复用该会话 id 于其余各格；demo 侧（`resource/workbuddy-live-demo.html`，`file://`）以 `addInitScript` 预置其主题存储键、以 `[data-quick="zhangsan"]` 快捷登录，`files-readme` 取 demo 首个工作空间的首个 `.md`，`chat-done` 取 demo 预置会话中当前账号首个已完成会话（所选 id、文件路径与主题键为脚本常量并注明 demo 行号）；`390` 格的 demo 在登录后折叠其浮层侧栏。输出到 `UI_SHOTS_OUT`（相对路径以仓库根解析；未设置或为空串时由脚本取 `var/ui-shots/<UTC 时间戳>/`）：每张 PNG 命名 `<app|demo>-<state>-<width>-<theme>.png`，并生成 `index.html` 对照表（每行 demo 左、app 右，标注格与态，缺失图标注 `缺失`）。app 侧 SHALL 走 `?ws=` 与真实 REST，不注入假数据；每张 app 截图前 SHALL 断言 `document.documentElement.scrollWidth <= window.innerWidth` 且（若存在 `main`）`main.scrollWidth <= main.clientWidth`。非 chat 态（`login-default`、`files-readme`、`settings-default`）的 app 截图前 SHALL 另断言 `document.title`、DOM 文本、`title` 与 `aria-*` 属性值不含任何 workspace `root` 绝对路径值（失败消息不回显该值）；chat 态按 ADR-0011 不做该断言。任一页面导航失败、断言失败或 console/page error（app 未登录时 `GET /api/auth/me` 401 的资源错误除外，条数不超过该响应数）SHALL 使目标非零并保留已产出文件。

#### Scenario: 六格产物齐全
- WHEN caller 以 fresh DB、真实 `web/dist`、夹具已复制到 `<SANDBOX_ROOT>/u1/`、`OMP_BIN` 指向已校验 omp 且模型上游可用（`.github/scripts/ci-fake-upstream.sh` 假上游或调用方自有真实上游）启动服务后执行 `make ui-shots`（或直接 `npm run ui-shots --workspace web`）
- THEN `UI_SHOTS_OUT` 下恰有 6 格 × 5 态 × 2 源 = 60 张 PNG 与一个 `index.html`，退出码 0；任何一张缺失、任一格横向溢出、非 chat 态（`login-default`、`files-readme`、`settings-default`）截图前 DOM 含 workspace `root` 值（chat 态按 ADR-0011 不做该断言）或页面 console error 时非零，且已产出文件保留

#### Scenario: 目标边界
- WHEN Playwright/Chromium 缺失或 `UI_SHOTS_BASE_URL` 不可达
- THEN 目标非零、不 silent skip、不下载依赖、不改动 caller 的 DB/temp；`make test` 不发现 `web/e2e/**`

### Requirement: 控制面同步
`Makefile` SHALL 新增 `ui-shots` 目标（`.PHONY`、头注释同步；`UI_SHOTS_BASE_URL` 采用与 `UI_WALK_BASE_URL` 相同的 `?=` 缺省 + `override … := $(value …)` 冻结 + export 三行；`UI_SHOTS_OUT` 不设缺省（无 `?=`），同样以 `override … := $(value …)` 冻结后 `export`——命令行值中的 `$` 不被 Make 展开；未设置时导出空串，缺省时间戳目录由脚本计算，Make 不使用 `$(shell)`）；`AGENTS.md` Verification Matrix SHALL 增行 `| demo 一致性截图对 | Playwright Chromium（调用方拥有已运行服务） | \`make ui-shots\` | 退出码 0；60 张截图 + index.html，人工按清单签收 |`，Enforcement Index 增行 `| demo 一致性截图对 | 本文件 Verification Matrix | \`make ui-shots\` | review-only |`；`constraints.yaml verification.surfaces` 增 `ui-shots`（`command: "make ui-shots"`、`evidence: "exit-code; demo-vs-app screenshot pairs for manual checklist sign-off"`、`required_at: "manual"`）；`scripts/test-ci-harness.sh` 的 AGENTS 行期望、surfaces 元组、Makefile 受保护目标集、`safe_overrides` 白名单（新增 `UI_SHOTS_BASE_URL ?=` 与两条 `override … := $(value …)`）、ui-shots 变量块五行（含两条 export）恰各一次按序紧邻 `ui-shots:` 的存在性检查、`recipes("ui-shots", …)` 配方期望与 `.PHONY` 整行锚点 SHALL 同 PR 更新，并对 `ui-shots :` duplicate/redefinition、变量块任一行删除/移位与页头 ui-shots 职责句篡改的 mutation 非零。CI 不新增 job、不新增第三方 action（四 action 白名单不变——截图产物为人工验收输入，由本地或验收机运行）。

#### Scenario: 三处一致且 oracle 覆盖
- WHEN 执行 `make test-guardrails`
- THEN AGENTS.md 两新行、`constraints.yaml` 十一条 surfaces、Makefile `ui-shots` 目标逐字一致；`ui-shots :` duplicate mutation 用例为 PASS（rc=1）；workflow 无新增 job 与 action

