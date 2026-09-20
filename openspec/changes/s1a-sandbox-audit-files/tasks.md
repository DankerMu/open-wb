# Tasks: s1a-sandbox-audit-files

> 执行序按依赖排列；TDD：每条实现任务先写失败测试再实现。组 1/2 可并行且不依赖 S0b；组 3 依赖 1、2 与 S0b 的 #84（七码基线）/#101（配置 seam 与 `STARTUP_MODULES` 基线）/#102（启动期 `agent` 目录）；组 4 的 jsdom 单测可对 REST 契约 mock 并行开工，但 4.3 合并需 3.5/3.6 先落地（`/files` 真实页对编译服务发请求，否则 `make ui-walk` 红）；组 5 依赖 1 与 S0b 的 #85/#87/#96/#101/#105；组 6 依赖 3、4、5 与 S0b 的 #107。本地持久化 `var/dev.db` 若迁移落地顺序与文件序不一致（`030/031` 先于 `020`），删库重建。凡触碰 Makefile/CI/AGENTS/constraints 的任务，`scripts/test-ci-harness.sh`（精确形状 oracle）与 `scripts/inspect-ci-workflow.js` 的期望**同 PR 更新**。

> Epic #111 人工验收例外（2026-09-19 用户决定）：#112 人工白盒审查通过；后续子 issue 保留独立代理审核与 CI 门禁，不再逐项等待人工审查，人工对 Epic 最终功能完整验收。仅适用于本 Epic，不修改全仓默认规则。记录：https://github.com/DankerMu/open-wb/issues/111#issuecomment-5741112841

## 1. sandbox-core

- [x] 1.1 `server/src/core/sandbox/resolve.ts`：`resolve(root, relPath, op)` 纯函数（NUL/绝对/`..`/边界前缀/逐分量 lstat 拒绝 symlink/mkdir 末段规则）+ 临时目录逃逸向量集单测（含 `/a` vs `/ab`、悬空 symlink、symlink 目录下子路径）（#112 / PR #138）
- [x] 1.2 `server/src/core/sandbox/dirs.ts`：`ensureSharedDir(absPath)`（递归创建、仅新建分量 `chmod 0o2770`、不 chown、不动 umask）+ mode 位单测（新建 `0o2770`、既有 `0o755` 不变、幂等）（#113 / PR #142）
- [ ] 1.3 `server/src/core/sandbox/index.ts`：`createSandbox({rootOf, audit})` facade（`rootOf` null → `not_found`；拒绝 → `emit(sandbox.reject)` 后抛 `sandbox_denied`；审计失败 → 5xx 不放行）+ 以 stub `rootOf`/stub `audit` 的单测

Suggested fixture level: expanded - 沙箱 resolve 是 AGENTS.md 白盒 Critical Path（不变量 3），逃逸向量集必须以真实文件系统（临时目录 + 真 symlink）证明，不可 mock
Minimal mergeable slice: 1.1 `resolve` 纯函数单独可合并保绿（无依赖、自带向量集测试）；1.2 独立可合并（纯 fs 工具）；1.3 依赖 1.1、1.2 与 2.2 的 `emit` 签名（可先以接口类型占位，stub 测试）

## 2. audit-core

- [x] 2.1 迁移 `030_audit_events.sql`（表/CHECK/索引/两只追加触发器）+ 形态与触发器单测；受信任迁移目录计数断言随之 +1（#114 / PR #146）
- [x] 2.2 `server/src/core/audit/index.ts`：`emit`/`query`（角色过滤、`limit` 1..200、`before` 游标、`detail` JSON 往返）+ `:memory:` 单测；用户批准 #122 同步将唯一 `HttpError`/错误码/消息迁至 `core/errors`，HTTP 状态/信封仍归 http，调用方原子迁移无旧转发导出（comment5748746011）。PR #163 已合并，CI35504605570 全绿。
- [x] 2.3 `server/src/accounts/index.ts`：`registerAccounts(app,{db})` 挂 `GET /api/audit`（guard 后、`no-store`、400 分支）+ `app.inject()` 单测（成员/管理员两账号）；#124 / PR #167 已合并，CI35509431982 全绿。生产 app.ts 装配仍属 #128。

Suggested fixture level: 2.2 expanded（#122 覆盖持久化写入、角色过滤与用户批准的公共错误迁移）；其余按各子 issue 风险分级。触发器由迁移测试证明，查询由真实 `:memory:` 证明，HTTP 行为由既有 inject 错误测试回归。
Minimal mergeable slice: 2.1 迁移单独可合并保绿（独立 SQL + 形态测试，由 openDb 自动执行故非死代码）；2.2 依赖 2.1；2.3 依赖 2.2
Archive coordination: 主 `audit-core` 已晋升 2.1 schema、2.2 emit/query（含默认50的可观测分页、精确大游标及原生数字解码错误边界）及 2.3 accounts 只读端点（含早期401/400/500的no-store、标量参数与未舍入游标）；主 `http-service-skeleton` 已晋升公共错误归 core。父 change 最终归档须去重并保留已验收语义，不得用旧版较弱要求覆盖。端点模块可显式注册，生产装配仍待 #128。

## 3. workspaces

- [x] 3.1 `server/src/core/errors/index.ts` 消息/错误码与 `server/src/http/errors.ts` 状态映射（依赖 S0b #84 的七码基线；#122 已批准公共错误归 core）：七码 → 十一码（`sandbox_denied`/`conflict`/`preview_too_large`/`preview_unsupported`）+ HTTP 层 `CONTENT_PARSER_OWNED_ROUTES` 增 `POST /api/workspaces`、`POST /api/workspaces/:id/dirs` + 既有信封测试扩为十一码与归属路由 400 断言；#115 / PR #173 已合并，CI35520629741 全绿。
- [x] 3.2 迁移 `031_workspaces.sql`（双唯一、`dir` CHECK）+ 形态单测；受信任迁移目录计数断言随之 +1（#116 / PR #151；schema-only slice 已归档，目录根行为仍待 3.3）
- [ ] 3.3 `server/src/workspaces/store.ts`：列表/创建事务（`dir` 派生与校验、冲突 → `conflict`、惰性沙箱根 + 空间根 `ensureSharedDir`、采用既有目录、`emit(workspace.create)`、失败回滚）与 `rootOf(principal, workspaceId)` 端口实现 + 单测（临时 `SANDBOX_ROOT` + `:memory:`）
- [x] 3.4 `server/src/workspaces/tree.ts` + `preview.ts`：单层列举（目录优先、字节序、跳过 symlink/特殊文件）与预览判定/流式读取（扩展名集合、`text/plain` + `nosniff`、1 MiB 截断头、图片 10 MiB 上限）纯函数 + 临时目录单测；#117 / PR #175，CI35527764996 全绿；helper-only slice 晋升，不含 REST/授权/装配。
- [ ] 3.5 `server/src/workspaces/rest.ts` + `index.ts`：`registerWorkspaces(app,{db,sandbox,audit})` 五端点（列表/创建/tree/dirs/file；他人 404、越界 403 + 审计、409/413/415/400 分支、`no-store`）+ 对完整装配 app 的 `app.inject()` 单测（临时 `SANDBOX_ROOT`）
- [ ] 3.6 `app.ts`/`server.ts`（依赖 S0b #101/#102）：沙箱 facade 构造（`rootOf` 来自 workspaces store、`emit` 来自 audit）并注入 `registerWorkspaces` → `registerAccounts`；`STARTUP_MODULES` 增 `workspaces`、`accounts`（恰七项）；配置/启动顺序测试面（`server-config.test.ts`、`server-startup-order.test.ts`）随之更新

Suggested fixture level: expanded - 工作空间 REST 是沙箱边界的唯一 HTTP 暴露面（Critical Path），隔离/越界/审计联动须以完整装配 app + 真实临时目录证明
Minimal mergeable slice: 3.1 错误表扩展单独可合并保绿（既有 mapper 与测试侧真实 HTTP 路由证明，不导出私有 Set）；3.2 迁移独立可合并；3.4 纯函数依赖 3.1 的预览错误码；3.3 依赖 3.1、3.2、1.2、2.2；3.5 依赖 3.1、3.3、3.4、1.3；3.6 依赖 3.5、2.3、S0b #101/#102。1.3 facade 同样依赖 3.1 的 sandbox_denied（执行期补齐依赖）。
Archive coordination: 主 `http-service-skeleton` 的「统一错误信封」已晋升至十一码/六 owner，并保留 constructor-backed allowlist、FST_ERR_VALIDATION 排除、guard/fallback 与 route-owned cache 语义。S0b/S1a 父 change 最终归档不得用旧七码/较弱文本覆盖；生产 workspace 路由仍归 #127，装配归 #128。
Archive coordination: 主 `workspaces` 已晋升 schema 与单层列举/预览 helpers。父 change 最终归档保留 helper 的 UTF-8 字节序、生产 classifier headers/limit、原始字节上限与 canonical errors，不以旧组合需求覆盖；#127 仍负责先授权 resolve、缺失/非普通文件404、真实HTTP头/状态、原生错误路径脱敏与 client-abort 销毁流。helper 信任已授权路径和元数据，不声明 TOCTOU 防护。证据边界：精确1MiB/10MiB已测分类，整流不是独立阈值行；错误流测code+close，完成/提前destroy另测fd EBADF。

## 4. files-web

- [x] 4.1 `web/src/lib/api.ts` 增六方法与 403/409/413/415 解析 + 单测（#118 / PR #153；API-only slice 已归档，页面及 Blob URL 生命周期消费仍待 4.3）
- [x] 4.2 `web/src/features/files/md-render.ts` + `csv.ts` + `preview.tsx`：移植 demo `mdRender`（先转义；链接 `href="#"`）、CSV 表格、行号代码表、图片、不支持/截断态纯组件与安全单测（#119 / PR #155；用户授权 64 层 strong 规范化，开发/生产 × StrictMode 深层生命周期已证明；切片已归档）
- [ ] 4.3 `web/src/features/files/page.tsx` + `tree.tsx` + 路由接线（`/files` 换为 FilesPage、`routeManifest` 描述更新、`?ws=` 参数、切换器弹层、`＋` 菜单两项、新建工作空间/新建文件夹对话框、空态文案；**同步更新 `web/test/routes.test.tsx` 与 `web/e2e/ui-walk.spec.ts` 对 `/files` 的断言**）+ jsdom 测试（mock fetch 一次"选空间 → 展开 → 预览四文件 → 新建目录"、无空间空态、刷新回到 `?ws=`、`?ws=` 非法回退首个并纠正 URL、新建文件夹空名/分隔符/409 三文案）；**合并前置：3.5/3.6 已落地**（否则真实服务 404 打红 `make ui-walk`）

Suggested fixture level: compact - 纯前端展示，jsdom 单 seam；服务端契约以 spec 信封与端点形状为 oracle（mock）
Minimal mergeable slice: 4.1 api 扩展单独可合并保绿（六方法配对测试即非死代码）；4.2 纯渲染组件独立可合并；4.3 依赖 4.1、4.2 且合并需 3.5/3.6 先落地
Archive coordination: `files-web` 主 spec 已晋升 4.1 API 与 4.2 纯预览组件；父 change 最终归档时须去重既有新增项，保留已授权的 64 层规范化，不以旧版组合需求覆盖它。4.3 页面及树接线仍未完成。

## 5. omp-uid-isolation

- [ ] 5.1 `server.ts` 配置 seam 增 `OMP_USER`（正则、显式空非法；负例进 `server-config.test.ts`）+ `server/src/sessions/omp/process.ts` 的 sudo 前缀（argv `-n -u <user> --preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN -- <OMP_BIN> <omp 参数>`，白名单值经 sudo 进程 env 传递、绝不进 argv；未设时与 S0b 逐字相同）+ spawn 参数捕获单测两形态（依赖 S0b #85 的注入点、#101 的配置 seam）
- [ ] 5.2 自有状态权限：`server.ts` 在 `openDb` 之前对缺失 DB 文件 `openSync("wx", 0o600)`、对既有主文件及 `-wal`/`-shm` `chmod 0o600`（失败走 partial-start 清理）+ 启动测试断言三文件 mode；S0b spawn 前的四目录与 `<OMP_STATE_DIR>/agent` 创建改用 `ensureSharedDir`（`0o2770`）+ 目录 mode 断言（依赖 1.2、S0b #85/#101/#102）——对应 omp-uid-isolation「自有状态不对组可读」Requirement 的完整证据面
- [x] 5.3 `server/test/support/fake-omp.mjs` 增 `probe` 模式（prompt `probe:<pid>:<writePath>` → 先以自身 uid 写 `<writePath>`，再回 `uid=… gid=… env=<sorted keys> home=<$HOME> agent=<$PI_CODING_AGENT_DIR> environ=<EACCES|readable|errno> wrote=<ok|errno>` 的 `text_delta` + 正常 `agent_end`）+ 契约单测（依赖 S0b #87）；#121 / PR #161 已合并，Ubuntu 同 uid 契约通过。
- [ ] 5.4 `server/test/linux/uid-isolation.test.ts`：`describe.skipIf(platform !== linux || !WORKBUDDY_UID_TEST)`；以 `OMP_USER` 起 S0b `SessionRuntime` + probe 假 omp，断言 uid ≠ 本进程、env 满足「白名单 ⊆ 键集、测试预置的三密钥键与哨兵键 `WORKBUDDY_CANARY_SECRET` 不存在（多出键只来自 sudo/PAM，不以闭集断言）、`home`/`agent` 回报值为传入值（不断言 PATH 值）」、`environ=EACCES`、`wrote=ok` 且本进程经 workspaces `tree` 列出该文件；本地 macOS 报告 skipped（依赖 5.1–5.3、S0b #96）
- [ ] 5.5 CI：`.github/scripts/ci-uid-isolation.sh`（groupadd/useradd/usermod/sudoers 三条 `SETENV` 规则（假 omp、真 omp、`/usr/bin/env`）+ `visudo -c`/runner-temp 目录 `chgrp workbuddy && chmod 2770`/复制沙箱夹具到 `SANDBOX_ROOT/u1/`/preflight `sudo -n -u omp --preserve-env=HOME,PATH -- /usr/bin/env`（断言 `HOME=<传入值>` 行、打印全部）/`sg workbuddy -c` 运行 5.4 与 `OMP_USER=omp` 的 `ci-compiled-server.sh smoke`）、`ci-compiled-server.sh` 透传可选 `OMP_USER`、workflow 新 job `uid-isolation`（timeout 15、checkout/setup-node/npm ci/build/omp-fetch/install hurl 8.0.1/脚本）进 `all-checks-passed`；`scripts/test-ci-harness.sh`（`check_wf` direct 八元组、aggregate needs、新 job 形状、helper `contract()` 期望行）与 `scripts/inspect-ci-workflow.js`（`WANT` checkout 8、setup-node 6）同 PR 更新，`make test-guardrails` 绿；CI job 首次全绿（依赖 5.4、6.1 的夹具与四文件 smoke、S0b #105）；两条验证路径（CI 真实运行 + 静态 oracle），Stage 5 按 S0b #105 先例标 `Width exception: multi-path`
- [ ] 5.6 关闭 downgrade：删除 `constraints.yaml downgrades` 的 `/proc` 条目、AGENTS.md Enforcement Index 增 `uid 隔离`（`block`）行、Known blind spots 无该项；`test-ci-harness.sh` 的 AGENTS/constraints 锚点同 PR 更新（依赖 5.5 已在 master 全绿、S0b #107 已登记该条目）

Suggested fixture level: expanded - 不变量 4 的机械证明只能来自真实子进程换 uid 后读 `/proc` 得 EACCES（Critical Path 白盒），CI ubuntu 是唯一执行场所
Minimal mergeable slice: 5.1 sudo 前缀 + 配置单独可合并保绿（参数捕获测试，不起进程；未设 `OMP_USER` 时零行为变化）；5.2 独立可合并（DB/目录权限位只依赖入口与 1.2）；5.3 假 omp 模式独立可合并（测试支撑）；5.4 依赖 5.1–5.3（本地 skipped 仍绿）；5.5 依赖 5.4、6.1（multi-path：CI 运行 + oracle）；5.6 依赖 5.5
Archive coordination: 5.3 探针契约已晋升至 `omp-test-harness`；父 change 最终归档保留「Linux 隔离证明」剩余集成要求并引用既有探针，不重复定义其协议。后续 #131 使用默认场景（显式故障/proxy 场景优先级不变），按字段标签解析含空格的 HOME/agent；同 uid 回报不等于跨 uid 隔离证明。

## 6. files-harness

- [ ] 6.1 tracked `smoke/fixtures/sandbox/u1/smoke-fixture/{readme.md,notes.csv,logo.png}` + `smoke/files.hurl`（创建类请求断言 status ∈ {201,409} 再以 `captures` 取 id、重复建目录精确 409、越界/审计/预览/他账号 404 断言）+ `make smoke` 改为四文件 + CI smoke/ui-walk job 脚本预置夹具到 `SANDBOX_ROOT/u1/`；`scripts/test-ci-harness.sh` 的 smoke recipe 期望行、workflow 形状同 PR 更新，`make test-guardrails` 绿；本地与 CI `make smoke` 绿（依赖 3.6）；两条验证路径（CI 运行 + 静态 oracle），Stage 5 标 `Width exception: multi-path`
- [ ] 6.2 `web/e2e/ui-walk.spec.ts` 增 `/files` 步骤（选择或创建 `smoke-fixture`、三文件、md 渲染/源码、csv 表格、新建 `walk-out`、reload 保持）；本地与 CI `make ui-walk` 绿（依赖 4.3、6.1）
- [ ] 6.3 控制面同步：AGENTS.md Directory Map（`server/` 描述含沙箱/审计/工作空间、`smoke/` 提及沙箱夹具）、Verification Matrix 行不变但 evidence 提及四文件；`test-ci-harness.sh` 的 AGENTS 锚点同 PR 更新（依赖 6.1、6.2、S0b #107 的矩阵两行）

Suggested fixture level: none - harness 自身即验证物；CI 接线以 workflow 全绿为证
Minimal mergeable slice: 6.1 是夹具 + `files.hurl` + `make smoke` 四文件 + CI 预置的原子一刀（hurl 用例进入 `make smoke` 与 CI 预置夹具必须同 PR，否则 CI 红）；6.2 依赖 6.1；6.3 依赖 6.1、6.2
