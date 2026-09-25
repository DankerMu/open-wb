# Design: ui-walk-dual-project（#295）

Fixture level：expanded（Playwright config 与 CI block 级 ui-walk 变更；父组 6 声明）。Review priority：decision-dense——唯一真实浏览器 seam 的矩阵形状。

Risk packs：Config/project setup（`playwright.config.ts` projects/timeout）、Resource limits（`globalTimeout` 与 CI 15 分钟预算、共享沙箱/DB 的跨 project 状态）、Legacy compatibility（既有 journey、auth oracle、#302 挂起焦点断言、#296 夹具断言）、Concurrency/ordering（两 project 串行共用同一服务与 gate 上游；覆盖层开合与模态 `aria-hidden` 的定位时序）。

## Governing invariants

1. verification-harness「UI 走查（Playwright）」（目标文本 = 父 delta `openspec/changes/s1e-frontend-parity/specs/verification-harness/spec.md` 同名块）：目标只消费 caller 服务；两 project 各自全新 context 串行；每路由无横向溢出；401 恰两次与零非预期 console/page error 的预算按 project 独立。
2. 真实回合不得伪造（真正回合中刷新 Scenario）：不以 sleep/伪造响应/fake EventSource 冒充；gate UUID 每 project 独立（`randomUUID()` 已在 `walkHeldDialogue` 内）。
3. 目标边界不变：不 build/start/stop/install、不清理 caller 状态；`make test` 不跑 `web/e2e/**`。

## Sibling surfaces

- `web/playwright.config.ts:8-34`（`globalTimeout: 60_000`、单 `chromium` project、`testMatch: "ui-walk.spec.ts"`）。
- `web/e2e/ui-walk.spec.ts`（788 行）：`walkProductionOrigin` `:61-119`（登录、四路由循环、files、dialogue、settings、collapse、主题、退出）、`walkSidebarCollapse` `:142-152`、`expectDesktopLayout` `:154-170`、oracle `:172-365`、`expectAuthenticatedRoute` `:366-387`、`sidebarFooter`/`expectPrincipalFooter` `:393-401`、`expectDarkTheme` `:403-408`、`walkFiles` `:423-490`（`WALK_OUT` `:29,444,475,488,497`）、`createWalkOutWhileHeld` `:494-510`、`walkHeldDialogue` `:518-568`、会话辅助 `:570-788`。
- `web/e2e/route-hold.ts`、`web/e2e/ui-walk-gate.ts`（Node 侧 fetch，不产生浏览器请求——不计入跨源 oracle）。
- 外壳：`web/src/routes/shell/app-shell.tsx:27-29`（≤760 时 `Drawer side="left" title="导航"` 内 `Sidebar variant="overlay"`）、`sidebar.tsx:42-66`（overlay 无 `折叠侧栏`、选路由即关闭）、`topbar.tsx:7-27`（`打开导航` 为 banner 首子节点，欢迎态窄条也有）。
- `web/src/features/files/files.css`（树栏 280 / `max-width: 900px` 210 / `max-width: 760px` 纵向；`.files-tree-name` 单行省略）。
- `web/src/ui/motion.css:74,89`（`.ui-pulse` 与 reduced-motion 块）；`.ui-pulse` 挂在 running 会话项与 running 步骤卡（`web/src/features/chat/conversation-view.tsx:53,82`）。
- 子目录创建走 `POST /api/workspaces/:id/dirs`（`server/src/workspaces/rest.ts:128-151` → sandbox resolve），无 64 码点上限，只受文件系统 NAME_MAX 255 字节约束；`server/src/workspaces/store.ts:54-56` 的 64 上限只作用于工作空间名/dir。walk-out 名固定 64 ASCII 字符。
- 以文本读取 `ui-walk.spec.ts` 的 jsdom 测试：`web/test/chat-composer.test.tsx:220-226`（spec 须含 `toHaveText("运行中")`、`toHaveText("已完成")`）、`web/test/chat-steps.test.tsx:125-135`（spec 须含 `name: "bash 已完成"`、`name: "bash 运行中"`、`from "./ui-walk-gate.js";`、≤800 行、无 `assistant.locator("p")`）。
- CI：`.github/workflows/ci.yml` ui-walk job（`timeout-minutes: 15`）、`.github/scripts/ci-compiled-server.sh ui-walk`、`scripts/test-ci-harness.sh`（只校验 workflow 形状，不读 playwright 配置）——均不改。
- 当前单 project 实测：CI `1 passed (10.5s)`（run 36143413196）。

## Decisions

- **D1 projects**：`[{ name: "desktop-light", use: { browserName: "chromium", viewport: { width: 1440, height: 900 }, colorScheme: "light" } }, { name: "mobile-dark", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, colorScheme: "dark" } }]`；不使用 `devices[...]` 预设（避免 isMobile/hasTouch/UA 改变交互语义）。`workers: 1`、`fullyParallel: false`、`globalTimeout: 150_000`；其余 config 字段不变。
- **D2 project 分支**：spec 内以 `test.info().project.name` 取名，收窄为 `"desktop-light" | "mobile-dark"` 联合，未知名直接 throw（不做默认分支）。分支集中在少量辅助函数（布局、导航、主题、desktop 专属断言），journey 主干保持一条。
- **D3 覆盖层导航（mobile）**：`openNav(page)` 点击 banner 内 `打开导航`，等待 `dialog` 名 `导航` 可见后返回其 locator；所有侧栏断言（当前导航项、用户区 `zhangsan`/`成员`、`用户菜单`）与路由点击都在该 dialog 内定位。路由点击后断言覆盖层关闭（`dialog 导航` 计数 0）。只做断言不点路由时，断言后按 Escape 并等待覆盖层关闭，保证后续页面定位不受 Radix `hideOthers` 的 `aria-hidden` 影响。每路由在打开覆盖层前断 `打开导航` 可见、覆盖层默认关闭。desktop 的侧栏定位保持 `complementary 侧栏` 文档流。
- **D4 布局断言**：
  - 两 project 每路由：`document.documentElement.scrollWidth <= innerWidth`、`main` 可见。
  - desktop：沿用 `expectDesktopLayout`（侧栏 ≥160、主区起点 ≥ 侧栏右缘）；四路由遍历中每路由 `setViewportSize(1024×768)` → 断无横向溢出与 `main` 可见 → 恢复 1440×900；`/files` 时另 `setViewportSize(880×800)` → 断树栏（`complementary 工作空间文件`）宽 210（±1）、预览区在其右侧、`scrollWidth <= innerWidth` → 恢复；`walkFiles` 创建 walk-out 之后再做一次 880×800：长名行 `scrollWidth <= clientWidth` 且无横向溢出 → 恢复；1440 下 `/files` 树栏 280（±1）且预览区在其右侧。
  - mobile：`/files` 树栏在预览区之上（树 bottom ≤ 预览 top + 1）。
- **D5 walk-out 名**：`walkOutName(project)` = `walk-out-<project>-` 后以 `x` 补齐到恰 64 字符（两 project 都 ≥48，且不超服务端 64 上限）。创建后断言：该目录行按钮 `title` 为全名；行内 `.files-tree-name` 的 `scrollWidth > clientWidth`（被省略）；行按钮 `scrollWidth <= clientWidth`（行不溢出）。reload 后以同名恢复断言（原 `展开 walk-out` 断言改为该名）。"不存在"前置断言只针对本 project 的名字（兄弟 project 的目录可以存在）。若 mobile 下 64 字符仍未省略，停下报告（不改产品 CSS、不加长到超 64）。
- **D6 主题**：登录后记录 `main` 背景色 `initialBackground`。desktop 选 `深色`、断 `data-theme=dark`、`workbuddy-theme=dark`、`当前生效：深色`；mobile 选 `浅色`、断 `light` 与 `当前生效：浅色`；两者 `main` 背景色 ≠ `initialBackground`，reload 后仍然成立。侧栏折叠步骤（`walkSidebarCollapse`）只在 desktop。
- **D7 reduced-motion（desktop）**：在 `walkHeldDialogue` 内 gate 为 `held`、页面已显示运行前缀之后（reload 之前），取第一个可见 `.ui-pulse`：`emulateMedia({ reducedMotion: "reduce" })` 后 `animationName` 为 `none`；`emulateMedia({ reducedMotion: "no-preference" })` 后不为 `none`。必须在 `releaseGate` 之前完成。
- **D8 静态资源与跨源（desktop）**：登录前（首个 `goto` 前）挂 `requestfailed` 与 `request` 监听：`requestfailed` 中 `resourceType ∈ {image, font, stylesheet, script}` 且 `failure()?.errorText !== "net::ERR_ABORTED"` 记为失败；`request` 中 URL 协议为 `http(s)` 且 origin ≠ `baseURL` origin 记为跨源（`data:`/`blob:` 不计）。journey 结束（退出并 reload 之后）断两个列表为空，失败消息列出 URL。实现可并入现有 oracle 的失败汇总（`collectOracleFailures`）或独立断言，但只在 desktop 启用。
- **D9 预览容器溢出策略**：`walkFiles` 中 CSV 表格与源码视图可见时，断其预览容器计算样式 `overflow-x` 为 `auto`（两 project）。
- **D10 文件拆分**：`ui-walk.spec.ts` ≤ 800 行（唯一机械约束是 `chat-steps.test.tsx:133`；`size-guard.sh` 不扫 `web/e2e`、knip 不含 e2e，新 helper 模块 ≤800 只靠 PR 中 `wc -l` 证据）。会话/对话辅助（`:570-788`）与 `ui-walk-gate.js` 导入留在 spec 内，以保持上述两个文本测试为绿。把 auth/console oracle（`:172-365`）移到 `web/e2e/ui-walk-oracle.ts`，project/布局/导航辅助放 `web/e2e/ui-walk-layout.ts`（文件名可调，须过 naming-guard 与 knip）；`testMatch` 仍只匹配 `ui-walk.spec.ts`，helper 模块不含 `test(`。移动的代码行为不变。

## Must preserve

- 单 test 的 journey 顺序与所有既有断言（登录、`/files` 选或建 smoke-fixture、三文件预览与 logo 256×256、walk-out 挂起焦点断言（#302）、真实回合刷新续流与精确完成、服务名/版本、退出挂起焦点断言（#315）、reload 未登录、恰两次 `/api/auth/me` 401 的 oracle 语义）在两个 project 各自成立。
- 第二个 project 走"选已有 smoke-fixture"分支；第一个 project（fresh 沙箱）走"创建"分支——两分支都保留，不因 project 顺序删改。
- `make ui-walk` 命令、CI job、`ci-compiled-server.sh` 不变；`make typecheck` 覆盖新 e2e 模块。

## Must add/change

- `playwright.config.ts` 按 D1。
- `ui-walk.spec.ts` + 新 helper 模块按 D2–D10。
- 本地证据（CI 环境变量命令，见 Required evidence）两 project 均 `passed`，列表 reporter 输出含 `[desktop-light]` 与 `[mobile-dark]` 各 1 条。

## Required evidence

- CI-env 本地 ui-walk exit 0，输出 `2 passed` 并记录总时长（须远小于 150s）；PR 贴出两行 project 结果。
- `make check` exit 0（新 e2e 模块由 typecheck（`web/tsconfig.json`）、biome、jscpd 覆盖；knip 与 size-guard 不覆盖 `web/e2e`）。
- 反向注入（各自单独施加、观察红、回退；均在 CI-env 本地 ui-walk 上）：
  1. `mobile-dark` 的 `colorScheme` 改为 `light` → mobile 主题断言红（选 `浅色` 后背景不变）。
  2. 去掉 mobile 的 `openNav()`（直接找 `主导航`）→ mobile 红（导航不可见）。
  3. 880 断言期望改为 280 → desktop 红（证明断言读到的是 210）。
  4. `walkOutName` 改为 `walk-out-<project>`（不补齐）→ 截断断言红。
  5. D7 中去掉 `emulateMedia reduce` 一步 → `animationName === "none"` 断言红。
  6. D8 跨源：在 `/settings` 期间由页面 `evaluate(() => fetch(location.origin.replace("127.0.0.1", "localhost") + "/", { mode: "no-cors" }).catch(() => {}))` 发起一个会应答、不产生 console error 的跨源请求 → desktop 跨源断言红；PR 证据须引用跨源失败行本身（不能是 console oracle）。
  8. D8 静态资源：临时 `page.route("**/__walk-miss.png", (r) => r.abort("failed"))` 并由页面 `new Image().src = "/__walk-miss.png"` → desktop `requestfailed` 断言红；PR 证据须引用 `image`/`net::ERR_FAILED` 行。
  7. 把 `globalTimeout` 暂设 5_000 → 运行以 global timeout 失败（证明配置生效）。
- 行数：`ui-walk.spec.ts` 与新模块 `wc -l` 记入 PR。

## Not yet specified

- files-web「三档宽度布局」中 1024 `/files` 格与 ui-shots 截图对（6.3a）；该父 Scenario 在 6.3a 完成后整体晋升。
