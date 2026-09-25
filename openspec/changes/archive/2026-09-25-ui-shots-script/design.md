# Design: ui-shots-script（#297）

Fixture level：expanded（新增脚本入口、消费真实服务；父组 6 声明）。Review priority：decision-dense——demo 侧状态选择常量与态名一次定调，6.4 清单与签收都引用这些文件名。

Risk packs：Public API / script entry（`npm run ui-shots --workspace web`、env、文件名契约）、File IO / path safety / overwrite（`UI_SHOTS_OUT` 解析与写入范围）、Auth / permissions / secrets（产物进公开 PR：不得含沙箱绝对路径）、Error handling / partial outputs（逐张失败汇总、非零、保留产物）。

## Governing invariants

1. 目标文本 = 本 change `specs/demo-parity-acceptance/spec.md`「ui-shots 截图对产物」（父 delta 同名块的脚本部分；溢出断言比父文本更严，归档时回写父 delta）。
2. 脚本只消费 caller 已启动的服务与仓库内 demo 文件：不 build/start/stop 服务、不安装/下载浏览器、不删除或清理 caller 的 DB/沙箱/temp。
3. app 侧不注入假数据：不 `page.route` 改写响应、不写 app 的 localStorage 除主题键外的任何键、不伪造会话；`chat-done` 是一次真实回合。
4. 公开产物纪律：截图与 `index.html` 不得出现 workspace `root` 绝对路径（每张 app 截图前机械断言）；证据只用假上游，模型标识最多出现 `MODEL_ID`。

## Sibling surfaces

- demo（`resource/workbuddy-live-demo.html`，只读）：
  - 主题 `Theme.get/set` 用 `localStorage['wb-demo-theme']`，取值 `light|dark|system`（`:1035-1039`）；`@media (prefers-reduced-motion: reduce)`（`:228`）。
  - 用户 `u1` = `zhangsan`/`demo`（`:1401`）；快捷登录按钮 `[data-quick="${u.account}"]`（`:1736`），点击填 `demo` 并提交（`:1748-1749`）；登录成功 toast `欢迎回来，…`（`:1743`），toast 2400ms + 260ms 后移除（`:1051`）。
  - `u1` 首个工作空间 `w1` `workbuddy-demo`（`:1414`）→ 挂载 `r1` 根 `/data/workbuddy/zhangsan/workbuddy-demo`（`:1519`）；`r1` 首个 `.md` = 目录 `out`（`:1531`）下 `周报-第31周.md`（`:1532`）。登录后 `wsId` 取首个空间（`:1675`）；`expandDefaultRoots` 只展开工作空间根（`:3827-3829`），`out` 需点击 `[data-dir]` 展开；`[data-dir]`/`[data-file]` 点击同步重渲（`:3943-3950`）。
  - 会话数组（`:1442-1453`）：`owner:'u1'` 且 `status:'done'` 的首个是 `c5`（`:1447`，ws `w1`）；`openConversation` 拒绝非本人会话（`:2053-2058`），故 `c2`（u3）不可用。会话无 hash 路由，入口是全局函数 `openConversation(id)`（`:2053`）。
  - 路由 = `location.hash`（`:1758-1762`），`hashchange` → `closePops/closeDrawer/render`（`:4139`）；页面 `/`、`/files`、`/settings`（`:1755-1756`）。
  - ≤760 时 `.sidebar` 为绝对定位浮层（`:307-309`），`sidebarCollapsed` 默认 `false`（`:1428`），折叠按钮 `[data-action="collapse"]`（`:1812`）。
- app：
  - 主题键 `THEME_STORAGE_KEY = "workbuddy-theme"`（`web/src/features/theme/provider.tsx:20`），原值字符串 `light|dark|system`（`web/src/lib/theme.ts:1-7`）。
  - 登录表单 `账号`/`密码`/`登录`、`POST /api/auth/login {account,password}`（`web/src/lib/api.ts:720-726`）；未登录首屏有一次 `GET /api/auth/me` 401，浏览器记为 console error（ui-walk oracle `web/e2e/ui-walk-oracle.ts:1-8,150`）。
  - `GET /api/workspaces` 返回 `{id,name,dir,root,createdAt}`（`web/src/lib/api.ts:210-226`；`server/src/workspaces/rest.ts:99`）；`POST /api/workspaces {name}`（`api.ts:601-615`）。
  - `/files?ws=<id>`（`web/src/features/files/page.tsx:270`），树 `nav[aria-label="工作空间目录树"]`（`tree.tsx:236`），预览 `section[aria-label="文件预览"]`（`tree.tsx:275`）。
  - 会话：`/?session=<id>`（`web/src/features/chat/page.tsx:35`）；`nav[aria-label="会话列表"]` 与 `新建会话`（`conversation-view.tsx:179,185`）；输入框 `给助手发消息`（`composer.tsx:30`）；已完成/生成中状态定位同 ui-walk（`ui-walk.spec.ts:443-453`）。
  - 健康探针 `GET /api/healthz`（`server/src/app.ts:170`）。
- 工具面：`web/vitest.config.ts:8` 排除 `e2e/**`（`make test` 不发现）；`web/playwright.config.ts:10` `testMatch: "ui-walk.spec.ts"`（ui-walk 不会拾取本脚本）；`web/tsconfig.json` 无 `allowJs`（`.mjs` 不进 typecheck）；biome、jscpd、semgrep（CI `sast`：`semgrep scan --config p/default --error … web …`）覆盖 `web/e2e`；`var/` 已 gitignore（`.gitignore:33`）。

## Decisions

- **D1 入口与依赖**：`web/e2e/ui-shots.mjs`，`import { chromium } from "@playwright/test"`（与 ui-walk 同一依赖，不新增包、不调用 install）。`web/package.json` `"ui-shots": "node e2e/ui-shots.mjs"`。脚本自包含：`.mjs` 不导入 e2e 的 `.ts` 辅助模块；与 ui-walk 重复的只允许几行定位器常量（`.jscpd.json` 只匹配 `ts/tsx/py`、size-guard 同样不扫 `.mjs`，行数靠证据 7 的 `wc -l`）。biome 覆盖 `.mjs` 且 `noExcessiveCognitiveComplexity` 上限 15（`biome.json:25-28`）：按格/源/态拆小函数，不写单个大函数。
- **D2 env 与输出目录**：`UI_SHOTS_BASE_URL` 缺省 `http://127.0.0.1:3000`（解析为 URL，非法即非零）。`UI_SHOTS_OUT` 未设置时 = `<repoRoot>/var/ui-shots/<UTC YYYYMMDDTHHMMSSZ>/`；设置为相对路径时相对 `<repoRoot>` 解析（npm workspace 会把 cwd 设为 `web/`，Make 的 cwd 是仓库根——以仓库根为准才不漂移）。`<repoRoot>` 由 `import.meta.dirname` 上溯两级得到。`mkdir -p`，已存在的同名文件被覆盖，其余文件不动；脚本启动与结束各打印一次输出目录——位于仓库内时打印相对仓库根的路径（如 `var/ui-shots/<ts>/`），仓库外才打印绝对路径（仍经 D2a 脱敏，故家目录下显示为 `~/…`）。
- **D2a 输出脱敏**：所有打印到 stdout/stderr 的失败原因与写入 `index.html` 的文本，先把 `<repoRoot>` 绝对路径替换为 `<repo>`（Playwright 的超时/导航错误会带 demo 的 `file:///<repoRoot>/resource/…`），并按 D8 不回显任何 workspace `root` 值（出现即替换为 `<workspace-root>`）；最后把 `os.homedir()`（长度 >1 时）替换为 `~`（#390 评审 r1 security note，Playwright 启动错误含浏览器缓存路径）。
- **D3 预检与顺序**：严格按 `GET <base>/api/healthz` → `chromium.launch()` → `mkdir(UI_SHOTS_OUT)` → 登录与 fixture → 截图矩阵，使前三步任一失败都不写 caller 的 DB/沙箱（Scenario「目标边界」；#390 评审 r1 修正了先登录后启动浏览器的原顺序）。healthz 非 200（含连接失败）→ 立即非零、打印原因、不启动浏览器。浏览器 `chromium.launch()` 失败（未安装）→ 非零、原样打印 Playwright 错误（"原样"指不改写措辞，仍经 D2a 脱敏），不重试不下载。随后用 Playwright `request.newContext({ baseURL })` 以 `zhangsan`/`demo` `POST /api/auth/login`，`GET /api/workspaces`（响应体 `{ workspaces: [...] }`，`server/src/workspaces/rest.ts:99-101`）：若无 `name === "smoke-fixture"` 则 `POST /api/workspaces {name:"smoke-fixture"}` 后重取；记录其 `id` 与**全部** workspace 的 `root` 值（泄漏断言的禁止串集合，D8）。启动浏览器之后的任一预检失败都先关闭浏览器，再非零退出，且不写 `index.html`（输出目录已建时可留空目录）。
- **D4 矩阵与上下文**：格顺序固定 `1440-light, 1440-dark, 1024-light, 1024-dark, 390-light, 390-dark`；每格每源一个新 context：`viewport`、`colorScheme` = 该格主题、`reducedMotion: "reduce"`，`addInitScript` 预置主题键（app `workbuddy-theme`，demo `wb-demo-theme`，值 = 该格主题原串）。同一 context 内按 `login-default → chat-welcome → chat-done → files-readme → settings-default` 顺序推进。一个浏览器实例贯穿全程。
- **D5 app 态**：
  - `login-default`：`goto("/")`，`登录 WorkBuddy` 一级标题可见。
  - `chat-welcome`：表单填 `账号`/`密码` 点 `登录`，URL 路径 `/` 且无 `session` 参数、主区可见。
  - `chat-done`：首格（1440-light）点 `新建会话`，等 URL 出现 `session`，在 `给助手发消息` 填 `请用一句话介绍你自己` 并提交，等待 `nav[aria-label="会话列表"]` 中 `aria-current="true"` 项的 status 文本为 `已完成`（上限 60s；`失败` 或超时即该张失败）；记下 session id。其余格 `goto("/?session=<id>")`，等 `助手` article 可见且表单内无 `生成中` status。首格未得到 id 时其余格该态直接记失败（原因注明依赖首格）。
  - `files-readme`：`goto("/files?ws=<smokeId>")`，在 `工作空间目录树` 内点名为 `readme.md` 的按钮（exact），等 `文件预览` 区含 `smoke-fixture` 一级标题。
  - `settings-default`：`goto("/settings")`，`设置` 标题可见。
- **D6 demo 态**（常量集中在文件头，逐个注明 demo 行号）：
  - `login-default`：`goto(file://…/resource/workbuddy-live-demo.html)`，`[data-quick="zhangsan"]` 可见。
  - `chat-welcome`：点 `[data-quick="zhangsan"]`，等登录页消失、`#page-root` 渲染。
  - `chat-done`：`page.evaluate(() => openConversation("c5"))`（demo 自身导航函数，会话无 hash 路由；`openConversation` 在无 `type=module` 的经典 `<script>`（`:921`）中，为全局函数），等顶栏 `.crumbs b` 文本恰为 `内部工具使用情况投票页`（c5 标题 `:1447`，顶栏渲染 `:1941`）——不用侧栏标题做锚点：侧栏在登录后即列出 c5，390 格折叠后侧栏仅被 `margin-left` 移出、Playwright 仍判可见。
  - `files-readme`：`location.hash = "/files"`，点 `[data-dir="/data/workbuddy/zhangsan/workbuddy-demo/out"]`（未展开时）再点 `[data-file="/data/workbuddy/zhangsan/workbuddy-demo/out/周报-第31周.md"]`，等 `.fs-preview` 含该文件名。
  - `settings-default`：`location.hash = "/settings"`，设置页渲染。
  - 390 两格：顺序为 登录 → 等 toast 清空 → 点一次 `[data-action="collapse"]`（`:1812`）折叠浮层侧栏 → 截 `chat-welcome`，与 app 窄屏"导航覆盖层默认关闭"同构；折叠状态存于 demo 内存（`DB.sidebarCollapsed`），后续态不再展开。1440/1024 不折叠。
- **D7 截图时刻**：每张截图前等待该态锚点可见、无瞬态 toast（demo `#toast-root` 无子节点，上限 5s；app `.ui-toast` 计数为 0（`web/src/ui/toast.tsx:60`），上限 10s），然后 `page.screenshot({ path, fullPage: false })`（视口截图，格尺寸即画幅）。文件名 `<app|demo>-<state>-<width>-<theme>.png`。
- **D8 app 断言（每张 app 截图前，包括 `login-default`）**：
  1. `document.documentElement.scrollWidth <= window.innerWidth`；且若存在 `main`，`main.scrollWidth <= main.clientWidth`（>760 时外壳 `overflow:hidden` 使前者恒真，#295 教训）。
  2. `document.title`、`document.body.textContent`、全部元素的 `title` 与全部 `aria-*` 属性值，均不含 D3 收集的任一 `root` 串。
  断言失败 → 该张不截图、记失败（消息含格/态/哪项断言，但**不**打印 root 值本身）。demo 侧不做这两项断言（demo 自身展示绝对路径是其设计）。
- **D9 console / 页面错误**：每页挂 `console`（`type() === "error"`）与 `pageerror`。app 侧唯一豁免：未登录阶段 `GET /api/auth/me` 401 的浏览器资源错误文本，条数不超过该页观察到的该 URL 401 响应数（与 ui-walk oracle 同语义）；其余一律计失败。demo 侧无豁免。错误归到发生时所在的态；一个态期间出现错误 → 该态失败（截图仍保留，便于诊断）。
- **D10 失败策略**：逐张继续（矩阵结束后依次 `writeIndex`、`browser.close()`，任一步抛错都不跳过后续步骤、保留最先出现的错误并非零）；单个 context 内某态失败后其后续态照常尝试（可能连锁失败，均记录）。结束时写 `index.html`、打印失败清单，任一失败 `process.exitCode = 1`；绝不删除已产出文件。预检失败（D3）例外：直接非零退出，不写 `index.html`。
- **D11 index.html**：纯静态单文件：每格一节（标题 `宽×高 · light|dark`），每态一行两列（左 demo、右 app，`<img src="相对文件名">` + 态名与文件名说明）；缺失图片的单元格显示 `缺失` 与失败原因摘要（不含 root 值）。不引用外部资源。文本经 HTML 转义。
- **D12 安全扫描**：不使用非字面量 `RegExp`、不拼接 shell、不 `eval` 字符串；`page.evaluate` 只传函数与序列化参数。semgrep `p/default` 对 `web/e2e/ui-shots.mjs` 零发现，不加 `nosemgrep`。

## Must preserve

- `make test`/`make check`/`make ui-walk` 行为与发现范围不变（vitest 仍排除 `e2e/**`，playwright `testMatch` 仍只有 `ui-walk.spec.ts`）。
- `Makefile`、`AGENTS.md`、`constraints.yaml`、CI workflow、`scripts/test-ci-harness.sh` 不改（6.3b）。
- `resource/`、`app-reference/` 只读。

## Must add/change

- `web/e2e/ui-shots.mjs`（按 D1–D12）与 `web/package.json` script。

## Required evidence

本地运行面（orchestrator 在 Phase 2 执行，命令记入 PR；服务手工起停，与 `ci-compiled-server.sh` 同环境变量）：`npm run build --workspace web && npm run build --workspace server`；`RT=$(mktemp -d)`；复制 `smoke/fixtures/sandbox/u1/.` 到 `$RT/sandbox/u1/`；后台起 `FAKE_UPSTREAM_PORT=19017 bash .github/scripts/ci-fake-upstream.sh` 与 `HOST=127.0.0.1 PORT=18017 DB_PATH=$RT/app.db STATIC_ROOT=$PWD/web/dist OMP_BIN=$PWD/var/omp/omp OMP_STATE_DIR=$RT/omp-state SANDBOX_ROOT=$RT/sandbox MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:19017/v1 MODEL_UPSTREAM_API_KEY=fake node server/dist/server.js`，`/api/healthz` 就绪后运行脚本，结束后停两个进程并删 `$RT`。

1. 正向：`UI_SHOTS_BASE_URL=http://127.0.0.1:18017 npm run ui-shots --workspace web` exit 0；输出目录恰 60 个 `.png` + 1 个 `index.html`（`ls | wc -l`、按 `<src>-<state>-<width>-<theme>.png` 全集比对无缺无多）；PR 附文件清单与两张样例（经人工确认无绝对路径、无供应商名）。
2. 溢出注入：临时在 `web/dist/index.html` 注入 `<style>.app-content>main>*{min-width:1000px!important}</style>`（直接改 `main` 自身宽度会被 `.app-content > main` 的更高优先级与 `overflow:hidden` 吞掉，`web/src/styles.css:183-239`）后以新 `UI_SHOTS_OUT` 重跑 → 非零；1440 两格 app 全绿（main 约 1152 宽 > 1000）；1024 两格与 390 两格中已登录的 app 态失败，1024 的失败行指向 `main` 断言，390 的失败行指向 `main` 和/或 document 断言；`login-default` 与全部 demo 截图保留；回退 dist。
3. 缺上游：停掉假上游后以新 `UI_SHOTS_OUT` 重跑 → `chat-done` 失败、非零，其余态文件保留。
4. 不可达：`UI_SHOTS_BASE_URL=http://127.0.0.1:1` → 非零、打印预检原因、零截图、不 silent skip。
5. 浏览器缺失：`PLAYWRIGHT_BROWSERS_PATH=$RT/none` → 三条同时成立：退出码非零；运行后 `$RT/none` 仍不存在或为空；输出中无以 `Downloading ` 开头的下载进度行（Playwright 原样报错里的 `npx playwright install` 提示是允许的）。贴入 PR 前对报错中的本机路径脱敏。
6. root 泄漏断言有效性：临时在 `web/dist/index.html` 注入 `<div title="<某 root 值>">` 等价物（由 D3 的真实 root 取值，本地手工）→ 非零且失败消息不含该 root 值；回退。
7. `make check` exit 0；docker semgrep `p/default --error web` 零发现；naming-guard 对新文件通过；`wc -l web/e2e/ui-shots.mjs` 记入 PR。
8. `make test` 不发现 `web/e2e/**`：引用 `web/vitest.config.ts:8` 与 `web/playwright.config.ts:10`，并贴 `npx vitest list` 中无 `e2e/` 行的证据。

## Not yet specified

- 6.3b 为 `ci-compiled-server.sh` 或 Make 增加起服务并跑 ui-shots 的一体化入口与否，由 #298 决定；本刀证据用手工起停。
