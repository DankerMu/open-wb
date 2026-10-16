# Tasks: sandbox-boundary-closure

> 跟踪：#1286 与 #1237 都保持打开；Stage 5 不另建 Epic（子 issue 以 #1286、涉及挂载规则的切片同时以 #1237 为父），按下面的切片（S0、S1、S2、S3a、S3b）建子 issue，一个子 issue 一个 PR；S3b 合并后关闭两个 issue（S3a 取「红」分支时只关闭 #1286，见 3.6 与 4.6）。
>
> 依赖（「X ← Y」读作「X 的前提是 Y」）：
> - S0（B9 的一行夹具修复）不依赖任何切片，可最先合入；只有 S3a 依赖它（3.5 ③ 以 S0 的夹具收窄已合入为前提）；它是 CI 抖动修复，与挂载规则无关，不等测试主机的实测。
> - S1、S2 互不依赖，可立即并行；S3a 只依赖 S0（3.5 ③）（S1 改 `dirs.ts` / `server.ts`，S2 改 `workspaces/` 与 `preview/app.ts`，S3a 只改一个新测试文件与 temporary-workspaces 规格；没有共同文件）。
> - S3b ← S1、S2；S3a 取「绿」时 S3b ← S3a：终态措辞（ADR-0010 补充、ADR-0014 的 #1286 表、头注释）要写的是已合入的行为，实测结果（S3a 的任务 3.6）要写进 ADR。S3a 取「红」时 S3a 不合并、temporary-workspaces 的 delta 撤出本 change 另开后续，S3b 只写 #1286 的部分（design Migration Plan）。
>
> 通用纪律：见 design「通用纪律」，本文不复述；每组的「验证」都以它的合入门槛为底线。补充三条只与任务写法有关的：
> - **测试先行。** 有行为的任务先写测试并在未改动的代码上看到红（或在 PR 写明为何不可能红，例如新模块），再实现。
> - **开工核对。** 每组第一个任务是核对；核对出入先改 design 与本组任务，再继续（design「行号核对」）。
> - **白盒。** S1、S2、S3a 触及 AGENTS.md 关键路径「沙箱与文件边界」：这三个 PR 请求人工白盒审查；S0、S3b 不含运行时代码，触发不成立，但同样把 design D11 该切片的审查清单贴进 PR 正文请一次轻量复核。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| File IO / path safety / overwrite | 选中：`O_NOFOLLOW \| O_NONBLOCK` 打开 + `fstat`；`lstat` 与 `open` 之间的换入；递归删除不跨挂载 | S2、S3a |
| Auth / permissions / secrets | 选中：`SANDBOX_ROOT` 的属主与 `3770`；`OMP_USER` 模式的启动失败；失败行不带路径 | S1 |
| Config / project setup | 选中：新启动阶段 `sandbox_root`；`OMP_USER` 部署的升级前提 | S1、S3b |
| Error handling / rollback / partial outputs | 选中：审计抛错时关闭描述符、500、零字节；416 / HEAD 关闭描述符；删除遇挂载的部分失败只报告一次 | S2、S3a |
| Concurrency / shared state / ordering | 选中：启动阶段次序（listen 之后同步到 `sandbox_root`，无 `await`）；B9 的 rimraf 并行子项竞态（FUSE 用例的树因此只放 `mnt`） | S0、S1、S3a |
| Legacy compatibility / examples | 选中：既有 `2770` / `0755` 的根被校正；惰性创建点不变；读路由对未换入文件逐字节同前 | S1、S2 |
| Documentation / migration notes | 选中：ADR-0010 补充与就地订正、ADR-0014 表、system.md 排障行、头注释、FL-38 | S3b |
| Public API / CLI / script entry | 未选：没有新端点、新参数；stderr 新增一行 `sandbox_root_unchanged` 在 http-service-skeleton 里规定 | — |
| Schema / columns / units / field names | 未选：不碰数据库 | — |
| Resource limits / large input / discovery | 未选：416 多一次 open/close 可忽略 | — |
| Release / packaging / dependency compatibility | 未选：不加依赖；FUSE 工具只在测试主机容器里（B7） | — |

## 行数预算（800 行硬上限；`scripts/size-guard.sh`）

| 文件 | 现在 | 合入后上限 | 改动的切片 |
|---|---|---|---|
| `server/src/core/sandbox/dirs.ts` | 97 | ≤ 150 | S1 |
| `server/src/server.ts` | 711 | ≤ 730 | S1 |
| `server/src/workspaces/regular-file.ts`（新） | — | ≤ 80 | S2 |
| `server/src/workspaces/rest.ts` | 521 | ≤ 500 | S2 |
| `server/src/workspaces/rest-entries.ts` | 232 | ≤ 250 | S2、S3b |
| `server/src/workspaces/preview.ts` | 246 | ≤ 260 | S2 |
| `server/src/workspaces/range-send.ts` | 50 | ≤ 80 | S2 |
| `server/src/preview/app.ts` | 311 | ≤ 330 | S2、S3b |
| `server/test/sandbox-dirs.test.ts` | 484 | ≤ 620 | S1 |
| `server/test/server-startup-failure-reason.test.ts` | 357 | ≤ 420 | S1 |
| `server/test/server-startup-private-state.test.ts` | 见 1.1 核对 | ≤ 800；不够则新例进 `server-startup-sandbox-root.test.ts` | S1 |
| `server/test/server-startup-helpers.ts` | 699 | ≤ 760（`captureSpawnHook` 迁入并导出） | S1 |
| `server/test/server-startup-omp-user.test.ts` | 160 | ≤ 160（钩子迁出，净减） | S1 |
| `server/test/workspaces-download.test.ts` | 467 | ≤ 640 | S2 |
| `server/test/workspaces-file-range.test.ts` | 569 | ≤ 640 | S2 |
| `server/test/workspaces-http.test.ts` | 736 | ≤ 760（只改 `:691-735` 一例的接缝） | S2 |
| `server/test/preview-app-headers.test.ts` | 197 | ≤ 240（只改 `:166-197` 一例的接缝） | S2 |
| `server/test/workspace-preview.test.ts` | 306 | ≤ 400 | S2 |
| `server/test/workspace-preview-range.test.ts` | 96 | ≤ 140 | S2 |
| `server/test/workspaces-preview-classify.test.ts` | 430 | ≤ 450 | S2 |
| `server/test/workspaces-file-sniff.test.ts` | 565 | ≤ 600 | S2 |
| `server/test/workspaces-file-swap.test.ts`（新） | — | ≤ 450 | S2 |
| `server/test/preview-app-swap.test.ts`（新） | — | ≤ 400 | S2 |
| `server/test/linux/temp-dir-remove-fuse.test.ts`（新） | — | ≤ 300 | S3a |
| `server/test/session-delete-temp-workspace.test.ts` | 783 | ≤ 785 | S0 |

其余被改文件的上限见 design「行数预算」。每个 PR 写明它改到的上表文件改动前后的行数；超出上限先停下改 design，不调阈值。

## 0. S0 — B9：`session-delete-temp-workspace.test.ts:511` 断言竞态的最小修复（temporary-workspaces「删除失败不影响响应」）

- [x] 0.1 开工核对：重读 `server/test/session-delete-temp-workspace.test.ts:60-120`（夹具 `TREE`、`names`、`seedTemporary`）与 `:510-540`；`wc -l` 仍 ≤ 785 且余量够加一行；读 Node v24.13.1 源码 tag 里的 `lib/internal/fs/rimraf.js`（该文件编进了 node 二进制、磁盘上没有：从 `github.com/nodejs/node` 的 `v24.13.1` tag 取）确认 `_rmdir` 先 `rmdir`、只在 `ENOTEMPTY` / `EEXIST` / `EPERM` 时列举子项、`_rmchildren` 并行且首错即回调（design D8 的依据）；与读到的不一致先改 design。
  验证：核对结果（含 rimraf 的相关行号）写进 PR。
- [x] 0.2 最小修复（design D8）：`:510-540` 用例在 `chmodSync(join(temporary.dir, "sub"), 0o500)` 之前加 `rmSync(join(temporary.dir, "notes.md"))`，`:525` 断言不变（这里的 `rmSync` 删的是测试自有夹具里的一个普通文件，不是递归删用户目录树，不在 temporary-workspaces 的 `rmSync` 禁令内）；PR 注记 PR #1459 的 CI 红与本机 APFS 0/800 的观测。
  验证：`cd server && ../node_modules/.bin/vitest run test/session-delete-temp-workspace.test.ts --coverage=false` 全绿；`for i in $(seq 20); do (cd server && ../node_modules/.bin/vitest run test/session-delete-temp-workspace.test.ts --coverage=false) || break; done` 20 轮全绿（本机）。
- [x] 0.3 规格随刀：核对 temporary-workspaces delta「删除失败不影响响应」的 WHEN 已是「唯一顶层条目」，与 0.2 一致。
- [x] 0.4 整刀验证：`make check`、`make test-guardrails` 全绿（只改一个测试文件，smoke / ui-walk 按合入门槛照跑）。PR 请求白盒审查（design D11 S0 清单：只删 `notes.md`、`:525` 不动）。
Suggested fixture level: none - 只改一个既有测试用例的夹具一行，不改产品代码、不改断言。
Minimal mergeable slice: atomic - 一行修复，没有可再拆的部分；独立于其它切片，可最先合入。

## 1. S1 — 启动建沙箱根并校正为 `3770`（sandbox-core / http-service-skeleton / omp-uid-isolation）

- [x] 1.1 开工核对：
  - 重读 `server/src/core/sandbox/dirs.ts` 全文、`server/src/sessions/omp/state-layout.ts:97-116`、`server/src/server.ts:292-306`（`StartupStage` 与失败记录）、`:405-488`（`start()`，尤其 `:464-467` 的无 `await` 注释）、`:495-530`（`publishStarted` 的阶段赋值）、`server/src/app.ts:231-236`；
  - `grep -rn "sandbox" server/test/server-startup-*.test.ts` 与 design D5 表逐条对照：成功启动后断言沙箱不存在 / 保持 mode 的只应是 `server-startup-layout.test.ts:136`、`server-startup-private-state.test.ts:113`、`:155-157`、`:196`、`server-startup-order.test.ts:135`；表外命中的停下更新 D5；
  - `wc -l server/test/server-startup-private-state.test.ts`，决定新例写在本文件还是 `server-startup-sandbox-root.test.ts`；
  - 看清 `server/test/sandbox-dirs.test.ts:336` 怎样造出「属别的 uid 的目录」，本组复用同一造法；
  - 重读 `.github/scripts/ci-uid-isolation.sh:92-97`、`.github/scripts/ci-compiled-server.sh:9-16` 与 `scripts/test-ci-harness.sh` 里 `SANDBOX_ROOT` / `chmod 2770` 的全部命中，确认没有一处钉沙箱根启动后的 mode（design D10）；有则停下报告——那意味着 S1 需要 CI 改动，须交 owner 决定。

  验证：核对结果写进 PR。
- [x] 1.2 先写单元测试（`server/test/sandbox-dirs.test.ts`，新 `describe("core/sandbox ensureSandboxRoot")`），覆盖 sandbox-core「沙箱根目录」三个场景的全部 WHEN：冷建、`2770` → `3770`、`0755` → `3770`、已是 `3770` 时不发 chmod（`vi.spyOn(fs, "chmodSync")` 计数）、属组与 umask 不变、根下无新增条目；根是符号链接时作用于目标；位置是普通文件时两种 `strict` 都抛且文件不变；属别的 uid（沿用 `:336` 造法，`it.skipIf(geteuid === 0)`）与 chmod 被替换为抛 `EPERM` 两例在 `strict: true` 抛（错误文本不含环境值）、`strict: false` 返回 `unchanged` 且 mode / 属主不变、没有第二次 chmod；再加一例：chmod 只落下 `0o1770`（内核静默丢掉 setgid、复查失败）时 `strict: true` 抛、`strict: false` 返回 `unchanged`、不回滚、没有第二次 chmod（sandbox-core「沙箱根目录」第二个 WHEN，B3 不纠正）。另加 sandbox-core「共享目录权限位」新场景「已建出的沙箱根不被惰性路径改动」。
  验证：在未改动的代码上判红（函数不存在即红）。
- [x] 1.3 先写编译入口测试：
  - 先把 `captureSpawnHook`（`server/test/server-startup-omp-user.test.ts:135-160`，今天是未导出的 ESM 文本）迁入 `server/test/server-startup-helpers.ts` 并导出，改写为 CJS 文本（`require('node:child_process')` / `require('node:fs')` / `require('node:module')`，与 `denyChmodHook` 同形），`server-startup-omp-user.test.ts` 改为 import 它（`.mjs` 文件名随之改 `.cjs`）；再加一个拼接 helper（或照 `childUmaskHook` 的写法，把第二段的 `'use strict';` 去掉后拼进同一个字符串），使一个 `--require` 文件同时伪装 setpriv 与拒绝 chmod（`requireHook` 只收一个路径，`server-startup-helpers.ts:127`）；`server-startup-helpers.ts` 699 → ≤ 760。
  - `server/test/server-startup-failure-reason.test.ts`：「`SANDBOX_ROOT` 位置是普通文件 → `sandbox_root`」——同 uid 与 `OMP_USER`（上面迁入的 `captureSpawnHook("present")` 伪装 setpriv）各一例；stdout + stderr 不含根路径（沿用 `PATH_SENTINEL` 写法：根路径里放哨兵段）；占位文件字节不变；`<root>/state` 已建出（托管布局先于本阶段）；主端口在进程退出后可重新绑定（`expectBindable`，`server-startup-helpers.ts:352`）；
  - http-service-skeleton「同 uid 模式下沙箱根的 chmod 被拒」两例：**先** `mkdirSync(sandbox)`（`0o755`）把根建好，**再**以 `denyChmodHook([realpathSync.native(sandbox)])` 构造钩子——`denyChmodHook` 按字面路径匹配（`server-startup-helpers.ts:450-470` 的 `denied.has(path)`），而 `ensureSandboxRoot` chmod 的是 realpath；macOS 上 `mkdtempSync(join(tmpdir(), …))` 的根在 `/var/folders/…`、realpath 是 `/private/var/…`，按字面路径构造在本机 `make check` 必红（design D2）；同 uid 启动成功、stderr 恰多一行 `{"event":"sandbox_root_unchanged"}`、根 mode 仍 `0o755`；同一钩子拼上 `captureSpawnHook("present")` 后 `OMP_USER` 模式 → `sandbox_root`；
  - 「完整装配路由与惰性根」（标题是历史名）的新 THEN：冷启动后根存在、`0o3770`、无条目、`u1` 不存在；预置 `2770` 与 `0755` 的根启动后为 `3770`、属组不变、umask 不变（写在 `server-startup-private-state.test.ts` 或 1.1 决定的新文件）。

  验证：在未改动的代码上判红（钩子迁移本身不改断言，`server-startup-omp-user.test.ts` 迁移后在未改动代码上仍全绿）。
- [x] 1.4 实现：
  - `dirs.ts` 加 `ensureSandboxRoot(configuredPath, {strict})`（design D2 五步，复用 `ensureOwnedDir`），头注释加一段；
  - `server.ts`：`StartupStage` 加 `sandbox_root`；在 `ensureOmpStateLayout(config.ompStateDir)` 之后、`owned.stage = "preview_listen"` 之前同步调用；`outcome === "unchanged"` 时经 `emitStderrRecord({event: "sandbox_root_unchanged"})` 写一行（不 `await` 阻塞启动次序的话要确认受管 writer 的既有用法——`session_fault` 的写法）；
  - `app.ts:232-233` 注释改为 design D3 的措辞；`app.ts:330-332`「沙箱根到第一次建会话才建」改为「启动的 `sandbox_root` 阶段已建根」；`server/test/server-startup-preview-helpers.ts:139-145`「入口启动时不建 SANDBOX_ROOT…」改为「启动已建根；`makeSandboxRoot` 只为不经入口的装配保留」（只改注释）；
  - 按 design D5 表改写标「S1」的五处断言（第 3 种改法，引用 B2 / B4 与编排方默认 `3770`），逐条列进偏离记录。

  验证：1.2、1.3 全绿；`dirs.ts` ≤ 150、`server.ts` ≤ 730 行；`npm test --workspace server` 全绿（含 `omp-process.test.ts:213` 原样通过）。
- [x] 1.5 规格与文档随刀：本 change 的 http-service-skeleton、sandbox-core、omp-uid-isolation 三个 delta 由归档合入主规格，本任务只核对实现与 delta 逐句一致；PR 正文写明 `OMP_USER` 部署的升级前提（proposal Impact 的措辞），并写明 uid-isolation job 的 smoke 阶段作为 chmod 分支的「失败可见、取值不断言」证据（design D10）——不改 CI。
- [x] 1.6 变异证据（逐条做、逐条撤销，结果贴进 PR）：去掉 `ensureOwnedDir` 调用（只 mkdir）→ 「冷建与校正」与「完整装配」的 `3770` 断言判红；`strict` 下吞掉属主错误 → 「属主不符或 chmod 被拒」的 strict 例判红；把阶段挪到 `listen` 之前 → `server-startup-layout.test.ts:256`（`state_layout` 失败后沙箱不存在）判红；失败记录带上路径 → 哨兵断言判红；同 uid 模式漏写 `sandbox_root_unchanged` → 该例判红；`sandbox_root_unchanged` 行多带一个 `path` 键 → 该例的整行精确断言判红；lenient 分支对已落下的 `0o1770` 做回滚 → 「不回滚」断言判红。
- [x] 1.7 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；CI 的 uid-isolation job 绿（PR 里贴 job 链接与 `make smoke` 阶段的成功行）。PR 请求白盒审查（design D11 S1 清单）。
Suggested fixture level: expanded - 改沙箱根的权限位与属主检查、新增启动失败阶段（auth/permissions + config 风险包，Critical Path「沙箱与文件边界」）。
Minimal mergeable slice: atomic - 建根、校正、失败阶段与同 uid 记录是同一个启动步骤的四个分支；只合其中一部分会留下「建了根却不校正」或「校正失败无出口」的窗口，且 D5 的五处改写只对完整行为成立。

## 2. S2 — 四条读路由改为 fd 锚定（workspaces / file-operations / preview-origin / office-preview）

- [x] 2.1 开工核对：
  - 重读 `server/src/workspaces/preview.ts:166-171`、`:209-211`，`range-send.ts` 全文，`rest.ts:191-250`、`:366-400`，`rest-entries.ts:122-156`，`rest-archive.ts:100-124`，`preview/app.ts:164-170`、`:184-229`、`:285-308`；
  - `grep -rn "createReadStream\|openPreviewStream\|openRangeStream\|openRegularFile\|sendFileRange" server/src server/test`、`grep -n "openSync).mock.calls\|opensOf\|asyncOpensOf\|opensBelow\|descriptors).toEqual\|waitForOpen\|io.closed()" server/test/workspaces-*.test.ts server/test/workspace-*.test.ts server/test/preview-*.test.ts` 与 `grep -n 'addHook("onSend"' server/test`（抓「交接后删文件 → 500」形状的四例）列出全部调用方、spy 与注入钩子，与 design D5 表逐条对照；表外的按路径钉住读流、钉零次打开、等 `open` 事件或靠 `onSend` 删文件的断言停下更新 D5；
  - 重读换入钩子先例 `server/test/workspaces-file-sniff.test.ts:395-505` 与 `workspaces-archive-route.test.ts:534-600`，确认 `spyBodyIo` / `spyOpenAndRead` 可直接复用；
  - 在本机确认 `createReadStream(null, {fd, start, end, autoClose: true})` 的行为（design Context 已实测一次，开工再跑一遍），并确认传入 `fd` 的 `ReadStream` 不发 `open` 事件（D5 的 `waitForOpen` 各行据此改写）；
  - **开工前提**（D5 第 4 种改法的 `EIO` 接缝）：核对本仓库所装 Fastify 的 `reply.send(stream)`——在流的第一个数据块写出之前不 flush 响应头、流在 `!res.headersSent` 时 `error` 交给错误处理器（读 `node_modules/fastify/lib/reply.js` 的 `sendStream` / `onErrorHook` 路径，并用一个最小 `app.inject` 实验核实）；若 Fastify 先 flush 头，**停下报告**，不自行换接缝、不改用例。

  验证：核对结果、调用方清单与 Fastify 核对结论写进 PR。
- [x] 2.2 先写 helper 与打开函数的测试（`server/test/workspace-preview.test.ts` 扩写 + 新文件 `server/test/workspaces-file-swap.test.ts` 的 helper 部分）：workspaces「预览分类元数据与有界字节流」的「打开只认普通文件」六例（普通文件返回 `{fd, size}`；FIFO 与目录打开过一次又关闭；符号链接、不存在、套接字无描述符；FIFO 1500ms 内返回；零字节读出）与改写后的「流关闭和错误」（传入描述符被关闭；`openRangeStream({fd}, 10, 19)`；`openPreviewStream({fd}, 0)` 不开流且描述符已关闭）；`sendFileRange` 的 416 与 HEAD 关闭描述符。
  验证：在未改动的代码上判红。
- [x] 2.3 先写路由的换入测试：
  - `workspaces-file-swap.test.ts`：workspaces「文件预览」的「lstat 之后目标被换入」六例与「大小以打开的 inode 为准」三例；另加**新例**（不是改写）「打开之后路径被 `unlink` / 被替换 → 照常应答」两例：`readme.md` 文本流 200、`clip.mp4` 带 `Range: bytes=0-99` 206，注入点沿用 `workspaces-download.test.ts:67-82` 的 `onSend` 钩子（fd 锚定后它落在打开之后），断言正文与 `Content-Length` / `X-Workbuddy-Size` 来自已打开的 inode；
  - `workspaces-download.test.ts` 扩写：file-operations「下载」的「lstat 之后被换入的目标不下载也不审计」三例、「审计失败不发文件」改写后的描述符断言、「大小以打开的 inode 为准」；另加新例「审计行写出之后文件被 `unlink` → 200 完整字节、`Content-Length` 与审计 `detail.size` 为 `fstat` 值」（新语义，proposal Impact）；
  - 新文件 `server/test/preview-app-swap.test.ts`：preview-origin「预览监听器」的「lstat 之后目标被换入」三例与「范围请求」改写后的 416 描述符断言；另加新例「`/w/` 打开之后路径被 `unlink` → 206 照常」；office-preview「办公文档预览路由」的「转出的 PDF 在发送之前被换入」三例（注入转换器替身，钩子在替身返回路径与路由打开之间换入）。

  验证：在未改动的代码上判红（换入后旧代码读到链接目标或挂住 / 审计行先写出；「打开之后被删 → 照常」四例在旧代码上得到 500）。
- [x] 2.4 实现：
  - 新模块 `server/src/workspaces/regular-file.ts`：`openRegularFile(absPath): {fd, size}`（从 `rest.ts:201-227` 移入，errno 表逐字保留，`size` 取同一次 `fstat`），头注释写明只守末段、中间分量残余（design D4）；
  - `preview.ts`：两个 helper 改收 `{fd}`（design D4）；`range-send.ts`：收 `{fd, size, …}`，416 / HEAD 关闭描述符，头注释改写；
  - `rest.ts` `/file`：`lstat` → `openRegularFile` → 嗅探改从该 `fd` 读（不再二次打开）→ `classifyPreview(…, fstat.size, …)`，抛出时 `closeSync(fd)` 再抛 → `sendFileRange` / `openPreviewStream`；`rest-archive.ts` 改 import 并用返回的 `size`；
  - `rest-entries.ts` `/download`：`lstat` → `openRegularFile` → `try { audit.emit({… size: fstat.size}) } catch { closeSync(fd); throw }` → 头（`Content-Length` 取 `fstat.size`）→ `openPreviewStream({fd}, size)`；
  - `preview/app.ts`：`/w/` 在 `locate()` 之后 `openRegularFile`（`not_found` 由既有错误处理器答 404）；`/o/` PDF 在 `lstatExisting(outcome)` 之后 `openRegularFile(outcome)`，`not_found` 映射为 502 `FAILED_TEXT`，其它打开错误原样抛、走既有 500 路径；头注释里 `/w/` 与 `/o/` PDF 末段换入的段落改为「已闭合」；`:171-172` 的错误处理器注释「lstat 之后文件消失、打开失败 → 500」改为「`not_found` 由处理器答 404 / 502；其余打开错误与对描述符的读失败 → 无文案 500」；
  - 按 design D5 表改写标「S2」的全部行，逐条列进偏离记录：第 3 种（`workspaces-download.test.ts:391`，`workspaces-file-range.test.ts:245-246`，`workspaces-file-sniff.test.ts:207/:209/:212/:216`，ENOENT 两例 `workspace-preview.test.ts:265-271` 与 `workspace-preview-range.test.ts:90-95` 移到 `openRegularFile` 的测试）；第 4 种（`workspaces-download.test.ts:84-87`、`:417-437`，`workspaces-file-range.test.ts:150-152`、`:304-335`、`:339-367`、`:428-433`、`:514-530`，`workspaces-http.test.ts:691-735`，`preview-app-headers.test.ts:166-197`，`workspace-preview.test.ts:193-194/:197-217/:235/:244-245/:256-257/:276/:301`，`workspace-preview-range.test.ts:66/:72-73/:82-84`，`workspaces-preview-classify.test.ts:395`，`workspaces-file-sniff.test.ts:228`）；`sniff:213` 的 `sniffReads()` 为空与 `:220` 不动；`workspaces-download.test.ts:67-70` 的钩子注释改为「after the handler opened the file」。

  验证：2.2、2.3 全绿；除 D5 表列出的行外不改任何既有断言（`workspaces-file-sniff.test.ts:404-452` 与 `workspaces-archive-route.test.ts:540-577` 的换入用例只改 import、全绿）；预算表各文件在上限内；knip 无未用导出。
- [x] 2.5 变异证据（逐条做、逐条撤销）：去掉 `O_NOFOLLOW` → 四条路由的符号链接换入例判红（`/o/` 一例答 200 而不是 502）；去掉 `fstat` 的 `isFile` 判定 → FIFO 与目录换入例判红；去掉 `O_NONBLOCK` → FIFO 换入例超过 1500ms（判红）；`/download` 把审计挪回打开之前 → 「不下载也不审计」判红；`/download` 的 `catch` 里不 `closeSync(fd)` → 「审计失败不发文件」的描述符断言判红；`sendFileRange` 416 分支不关描述符 → 416 的描述符断言判红；`sendFileRange` HEAD 分支不关描述符 → HEAD 例（`workspaces-file-range.test.ts:304-335` 改写后「全部关闭」）判红；`openPreviewStream({fd}, 0)` 不关描述符 → 「流关闭和错误」的「描述符已关闭」判红；`/file` 分类抛出时不关描述符 → 改写后的 `doc.pdf` 415「打开一次又关闭」判红；`Content-Length` 改回 `lstat` 的大小 → 「大小以打开的 inode 为准」判红；`/o/` 的 `not_found` 不映射 502 → PDF 换入例判红（答成 404）。
- [x] 2.6 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿（走查里的预览与下载路径走真实栈）。PR 请求白盒审查（design D11 S2 清单），PR 写明 416 现在会打开一次文件、`createReadStream` 的路径参数恒为 `null`。
Suggested fixture level: expanded - 改共享的文件打开与读流路径（file IO / path safety 风险包，Critical Path），四条路由同刀。
Minimal mergeable slice: atomic - owner B5 把修法定在共享 helper：helper 签名一改，四条路由与它们的测试必须同刀；先改一条路由等于在 helper 之外另写一份打开逻辑，与 B5 相悖。

## 3. S3a — #1237 挂载规则：FUSE 对照用例与实测（temporary-workspaces）

- [ ] 3.1 开工核对：
  - 重读 `server/src/workspaces/temp-dir-remove.ts` 全文（确认 `rm` 来自 `fs/promises`、没有任何 `rmSync` 兜底）、`server/test/linux/uid-isolation.test.ts:98-120`（门控与前提检查写法）、design D7「测试主机探针」；
  - 读 Node v24.13.1 源码 tag 里的 `lib/internal/fs/rimraf.js`（该文件编进了 node 二进制、磁盘上没有：从 `github.com/nodejs/node` 的 `v24.13.1` tag 取）确认 `_rmdir` 先 `rmdir`、只在 `ENOTEMPTY` / `EEXIST` / `EPERM` 时列举子项、`_rmchildren` 并行且首错即回调（design D7 的依据；0.1 若已核对则引用其结论）；与读到的不一致先改 design；
  - `grep -rn "rmSync" server/src` 确认用户持有的目录树没有任何 `rmSync` 递归删除（今天只有 `server/src/preview/office.ts:203` 与 `server/src/preview/office-cache.ts:186`，都是应用持有的转换工作目录，不在范围内）；有新增命中则停下报告。

  验证：核对结果（含 rimraf 的相关行号与 `rmSync` 命中清单）写进 PR。
- [ ] 3.2 新建 `server/test/linux/temp-dir-remove-fuse.test.ts`，按 temporary-workspaces「临时空间目录的删除」三个新场景实现：门控 `describe.skipIf(process.platform !== "linux" || process.env.WORKBUDDY_FUSE_TEST !== "1")`；opt-in 后前提检查（`bindfs`、`fusermount3` 在 PATH，`/dev/fuse` 存在，`WORKBUDDY_FUSE_ALT_FS_DIR` 为另一文件系统上的可写目录——以 `statSync(...).dev` 与账号根的 `dev` 不同为判据）缺一即 `throw`，不 skip；seam 为 `removeTemporaryWorkspaceDir`（design D7）；两例（trash 路径、EXDEV 原地路径）的 `tmp-<id>` 内**只有** `mnt` 一个顶层条目（每例新建空 `mnt`——非空挂载点不能被 bindfs 复用，实测），各断言：函数正常 resolve、源目录校验和不变、挂载仍在（以 `/proc/self/mountinfo` 里挂载点**路径**判断——bindfs 的 fstype 显示为 `fuse`，不要 grep `bindfs`，实测）、残骸位置恰为 `trash/<随机名>/mnt` / `tmp-<id>/mnt`、`report` 恰一次 `code === "EBUSY"`；不断言任何同级条目的去留；`afterEach` 用 `fusermount3 -u` 卸载，失败抛出。测试注释与文件里不出现任何主机标识。
  验证：本机（macOS）与 CI 上该文件 skipped（`cd server && ../node_modules/.bin/vitest run test/linux/temp-dir-remove-fuse.test.ts --coverage=false` 报 skipped）；`WORKBUDDY_FUSE_TEST=1` 而无 `bindfs` 时在 Linux 容器里失败而非 skip（3.6 一并演示）。
- [ ] 3.3 规格随刀：本 change 的 temporary-workspaces delta 由归档合入；本任务核对 3.2 的断言与三个场景逐句一致，并核对 delta 里的「`fs.rmSync` 禁令」与 3.1 的 `rmSync` 清单一致。
- [ ] 3.4 结果表模板：交付一张空表（3.6 (d) 的列，含「变异」列），由 3.6 的执行者填写。
- [ ] 3.5 变异证据（**执行者是编排方 / owner 本人**，在 3.6 的同一个一次性容器里做，实现子代理不得执行；结果填进 3.6 结果表的「变异」列；逐条做、逐条撤销）：① 3.2 的用例里把 `EBUSY` 断言改成期望 `report` 零次 → 判红（证明挂载确实阻止了删除）；② **保留**源目录校验和断言，在产品代码 `temp-dir-remove.ts` 里临时把 `rm` 换成「递归 `readdir` 进入每个子目录（含挂载点）、逐项 `unlink` 再 `rmdir`」的手写删除（模拟进入挂载）→ 校验和断言判红、源文件被删（源目录是测试自有的；design D7 探针 (2) 表明换成 `fs.rmSync({recursive: true})` 也会得到同一种红，可作对照）；③ B9：把 S0 的 `rmSync(notes.md)` 临时去掉 → 在该容器（ext4 / overlay）里循环 200 轮 `cd server && ../node_modules/.bin/vitest run test/session-delete-temp-workspace.test.ts --coverage=false`，观察是否出现残骸含 `notes.md` 的红（如实记录出现次数，0 次也记）。
- [ ] 3.6 实测（owner B7；只在测试主机，一次性容器）。**执行者是编排方 / owner 本人**：实现子代理不得接触远端主机，它只交付 3.2 的用例文件与 3.4 的模板，由编排方按 (a)–(e) 跑完后把表贴进 PR：
  (a) 容器：`node:24.13.1-bookworm` 基础镜像（宿主已有），`apt-get install bindfs fuse3`，`--device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor=unconfined`（design D7 探针 (7) 实测可用的配方），`--tmpfs /altfs` 作另一文件系统；仓库以当前分支 `git clone`（不挂宿主目录），`npm ci`，`npm run build --workspace server`；
  (b) 运行 `cd server && WORKBUDDY_FUSE_TEST=1 WORKBUDDY_FUSE_ALT_FS_DIR=/altfs ../node_modules/.bin/vitest run test/linux/temp-dir-remove-fuse.test.ts --coverage=false`，连跑三次；另跑一次不装 `bindfs` 的容器确认 opt-in 缺前提时失败而非 skip；
  (c) 在同一容器里做 3.5 的三条变异；
  (d) 记录一张结果表：Node 版本（`node -v`）、内核版本（`uname -r`，不记主机名）、文件系统（账号根所在 / `/altfs`）、两例各自的 `report` errno、挂载是否仍在、源目录校验和前后、残骸清单（trash 下 / 原地）、三次是否一致、变异 ①②③ 各自的结果（「变异」列）；
  (e) 容器用完即删，宿主不留任何文件；PR 与 ADR 里只称「测试主机」。

  验证：结果表贴进 PR 正文，并交 4.2 写进 ADR-0010 补充（S3b）。两种结果按 design D7 处理：三次两例全绿且变异 ①② 判红 → 继续；任一例红（尤其「源目录有文件被删」）→ 停下报告、不改规格、不改产品代码、不改用例为绿：S3a 不合并，temporary-workspaces 的 delta 撤出本 change 另开后续，S3b 只写 #1286 的部分并只关闭 #1286，#1237 保持打开、结果表贴到 #1237 上（design Migration Plan）。
- [ ] 3.7 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；新文件在 CI 的 unit-tests job 里显示为 skipped 而不是 failed（PR 贴日志行）。PR 请求白盒审查（design D11 S3a 清单）。
Suggested fixture level: compact - 不改产品代码；一个默认跳过的 Linux 用例文件与一次手工实测；行为由规格 delta 与实测结果表钉住。
Minimal mergeable slice: atomic - 用例文件与实测是同一条规格句子的两个证据；先合用例不实测等于合入一个从未在任何机器上绿过的测试。

## 4. S3b — 文档终态、ADR-0010 补充、验收行、关闭 issue（docs only）

- [ ] 4.1 开工核对：S1、S2 已合并，S3a 已合并或已按 3.6 的「红」分支定案；重读 design D9 列出的每一处（`docs/adr/0010-dedicated-omp-uid.md:36`、`:104`、`:114`、`:122-124`、`:176-190`；`docs/adr/0014-isolated-preview-origin.md:59`、`:61`、`:65-70`、`:146-148`、`:181-183`；`docs/architecture/system.md:267`、`:351` 与 §9 部署一节；`server/src/server.ts:31-38`、`server/src/workspaces/trash.ts:1-60`、`server/src/workspaces/rest-entries.ts:1-41`、`server/src/workspaces/rest-archive.ts:25`、`server/src/preview/app.ts:1-50`、`server/src/preview/office-cache.ts:31-40`；`docs/acceptance/functional-checklist.md:217` 与末行 FL-37）；重跑 `grep -rn "1286\|1237\|sticky\|粘滞\|SANDBOX_ROOT" docs server/src server/test web/src IMPLEMENTATION_PLAN.md --include=*.md --include=*.ts`（已知命中：`server/test/workspaces-http-boundary.test.ts:15`「#1286 stays open」、`web/src/lib/api-files.ts:534`、`:545`「known residual … (#1286)」；S1 已改掉 `server/test/server-startup-preview-helpers.ts:139-145` 与 `server/src/app.ts:330-332`，核对确已改），表外命中的补进本组。
  验证：命中清单写进 PR。
- [ ] 4.2 ADR-0010：新增一节「2026-10-16 补充：#1286 有界闭合与 #1237 挂载规则」——B2/B3/B4 的裁定、`sandbox_root` 阶段与排障行 `{"event":"server_start_failed","reason":"sandbox_root"}` 的补救（`chown` 给应用 uid；或升级前 `install -d -m 3770 -o <app-uid> -g <group>`；应用 uid 须在共享组）、同 uid 模式的 `sandbox_root_unchanged`、粘滞位之后 omp uid 在根下只能新建不能改名删除、#1286 ① 不再成立、读路由末段换入已闭合而中间分量残余保留（引 design D4）、「打开之后路径被删不影响本次响应」的对外语义变化、3.6 的 FUSE 实测结果表（含 3.5 的变异列）与残骸处置（先 `fusermount3 -u` 再以应用 uid 手工删）、`fs/promises` `rm` 与 `rmSync` 的纪律；就地订正 `:36`、`:104`、`:122-124`、`:184-185` 四处并标注日期（design D9），其余历史记录不动。S3a 取「红」时本节只写 #1286 的部分，挂载规则一段改为「实测观察 + 待重议」，不写「已钉住」。
- [ ] 4.3 ADR-0014：`:59`、`:61`、`:65-66` 的 #1286 表（① 与四条读路由划为已闭合、保留中间分量与移动 / `moveToTrash` 源侧残余）、`:146-148` 的恢复提醒；`docs/architecture/system.md` 部署一节加 `sandbox_root` 排障行与补救、「`SANDBOX_ROOT` 由启动建出并保持 `3770`」、带挂载残骸的手工清理步骤。
- [ ] 4.4 源码头注释终态：`server.ts:34-38`、`trash.ts:18-60`（删去「`SANDBOX_ROOT` 无粘滞位」前提下的推演，保留批次内部句柄残余与源侧中间分量残余）、`rest-entries.ts:8-9`、`rest-archive.ts:25`（「#1286 stays open」→ 已有界闭合、中间分量残余按 B1 保留）、`preview/app.ts` 头（S2 已改的段落之外的 #1286 措辞）、`server/test/workspaces-http-boundary.test.ts:15` 与 `web/src/lib/api-files.ts:534`、`:545` 的「stays open / known residual」措辞；`office-cache.ts:36-40` 核对后不改（`work/` 不在 `SANDBOX_ROOT` 下）。只改注释，`npm test --workspace server` 与 `npm test --workspace web` 全绿、行数净减。
- [ ] 4.5 验收清单：新增 `FL-38`（design D9 的措辞），结论 `待签`；FL-01 原样保留。
  验证：`npm test --workspace web -- functional-checklist` 通过（四列与结论格式）。
- [ ] 4.6 整刀验证与关闭：`make check`、`make test-guardrails` 全绿（docs-only，smoke / ui-walk 按合入门槛照跑）；PR 合并后关闭 #1286 与 #1237，关闭评论各引用本 change 的归档路径、S0/S1/S2/S3a 的 PR 号与 3.6 的实测结果；3.6 若取了「红」分支则只关闭 #1286，#1237 保持打开、把实测结果表与「待重议」原因贴到 #1237 上，temporary-workspaces 的 delta 在归档前撤出本 change（另开后续 change 承接；撤出由编排方单独提交一个 docs PR 删除 `specs/temporary-workspaces/spec.md` 并在 design Migration Plan 记一笔，不属任何子 issue 的 PR）。
Suggested fixture level: none - 只改文档、ADR、头注释与验收行，无运行时行为。
Minimal mergeable slice: atomic - 一次文档终态更新；拆开会让 ADR 与头注释在一段时间内对同一事实说两种话。
