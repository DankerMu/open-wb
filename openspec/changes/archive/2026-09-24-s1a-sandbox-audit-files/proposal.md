# Proposal: s1a-sandbox-audit-files

## Why

IMPLEMENTATION_PLAN.md S1a：S0b 打通了对话链路，但 omp 的 bash 在 `<SANDBOX_ROOT>/<ownerId>` 下裸跑——没有文件系统边界、没有审计、没有用户可见的文件面，`/files` 仍是占位壳。本阶段落地 **`core/sandbox`（一切路径过 resolve）+ `core/audit`（只追加）+ 工作空间文件面**（F-FILE-1/2/4/5），并按 ADR-0010 补充把 omp 子进程切到**专用 uid**，让 CONTEXT.md 不变量 3（越界拒绝 + 审计）与不变量 4（凭证不进 omp 可读环境）从"声明"变成机械保障。这是 S1b（FUSE 挂载纳入白名单）、S1c（会话挂在空间下、cwd=空间根）与 S2a（KB 摄取从工作空间取文件）的前置。

## What Changes

- **`core/sandbox`**：`resolve(root, relPath, op) → 绝对路径 | 拒绝`——规范化、拒绝绝对路径/`..`/NUL/任一 symlink 分量、realpath 边界匹配（`/a` 不吞 `/ab`）；拒绝**自动入审计**（`sandbox.reject`）。目录创建走 `ensureSharedDir`（`2770`，setgid 继承组）。grill 事实项：`deriveWhitelist` 在 S1b 前无消费者，不建。沙箱↔工作空间的依赖方向按 system.md §4 规则 1：沙箱只依赖自有端口 `rootOf(principal, workspaceId)`，由 `workspaces` 实现。
- **`core/audit`（+ `accounts` 只读端点）**：迁移 `030_audit_events.sql`，只追加表由 SQLite 触发器拒绝 UPDATE/DELETE（ADR-0004 的应用层禁令升级为机械保障）；`emit(event)` / `query(filter, principal)`（成员只见本人，管理员全量——demo 语义）；grill 已定 `GET /api/audit` 进 S1a，使 F-FILE-5 能在 smoke 端到端断言。
- **工作空间（F-FILE-1/2）**：迁移 `031_workspaces.sql`（`(owner,name)`、`(owner,dir)` 双唯一）；REST：列表、创建（根目录 = `<SANDBOX_ROOT>/<ownerId>/<dir>`，沙箱根 grill 已定**首次操作惰性幂等 mkdir**）、目录树 grill 已定**逐层懒加载**、新建目录；文件预览（F-FILE-4）按 demo `PREVIEWABLE` 集合流式返回（文本 1 MiB 截断标志、图片 10 MiB 上限、`html` 以 `text/plain` + `nosniff` 返回）。越界（F-FILE-5）→ 403 `sandbox_denied` + 审计。
- **omp uid 分离（ADR-0010 补充，grill 已定进 S1a）**：新配置 `OMP_USER`；设置时 spawn 前缀为 `sudo -n -u <OMP_USER> --preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN [TMPDIR=<value>] -- <OMP_BIN> …`（sudoers `SETENV` 限定二进制；凭证值只走 env 不走 argv，避免 `/proc/<pid>/cmdline` 泄漏 token），S0b 环境白名单原样保留；`SANDBOX_ROOT`/`OMP_STATE_DIR` 树 `2770` 共享组，app-server 自有 DB 文件（含 `-wal`/`-shm`）自创建起 `0600`；CI 新增 ubuntu job `uid-isolation`（useradd/sudoers/`/proc/<pid>/environ` EACCES/真实 omp 在 sudo 下跑 `chat.hurl`）进 `all-checks-passed`；S0b 登记的 `/proc` 向量 downgrade 于该 job 全绿时删除。 #239 修正：`optionalTmpdirAssignment` / `[TMPDIR=<value>]` 表示白名单 TMPDIR 已定义（含空串）时，在 `--` 前增加一个 `TMPDIR=<精确值>` argv 元素，缺席时零元素；不经 shell 展开或拆分。此非凭证路径例外跨过 glibc setuid 对 TMPDIR 的剥离，不允许 token/上游密钥上命令行。
- **`/files` 页（web）**：工作空间切换/新建、目录树（懒展开）、预览面板（Markdown 渲染/源码切换、CSV 表格、代码行号、图片、不支持态）、`＋` 菜单（新建文件夹 / 新建工作空间；`挂载目录` 归 S1b）、当前空间以 `?ws=<id>` 表示；Markdown 渲染移植 demo `mdRender`（先转义，零新依赖）。
- **验证 harness 延伸**：tracked 沙箱夹具 `smoke/fixtures/sandbox/`、`smoke/files.hurl`（`make smoke` 四文件）、Playwright 走查 `/files` 步骤（切换空间、展开树、预览 md/csv、新建文件夹）、Linux-only 集成测试 `server/test/linux/`、CI job 与控制面同步（`test-ci-harness.sh` 精确形状 oracle 同 PR 扩展——S0b 教训前置写进任务）。

## 功能覆盖声明

覆盖 F-FILE-1（工作空间一等实体、多根目录树——S1a 只有空间根一个根，挂载根 S1b）、F-FILE-2（空间根目录、新建目录、新建工作空间）、F-FILE-4（文本/代码/图片预览）、F-FILE-5（越界写拒绝并入审计——S1a 的写只有 mkdir/建空间；omp 侧越界由 uid 分离 + 权限位挡，app-server API 侧由 resolve 挡）。

**与 IMPLEMENTATION_PLAN S1a Outcome 的偏离**：计划写"`core/sandbox`（resolve/白名单推导）"，本 change 只做 resolve，白名单推导（`deriveWhitelist`）归 S1b（首个消费者是挂载点）；计划 Outcome 未列 uid 分离，但 ADR-0010 与 S0b downgrade 均指定于 S1a 关闭，本 change 纳入。特此留痕。

## Non-goals

- 远程挂载（SFTP/NFS/SMB）、只读/在线状态、`挂载目录` 菜单项、`deriveWhitelist`——S1b。
- 会话绑定工作空间、omp `--cwd` 改为空间根、composer 里的空间切换——S1c（S1a 的 omp cwd 仍是 `<SANDBOX_ROOT>/<ownerId>`）。
- 文件上传/下载/删除/重命名/移动、工作空间删除/重命名、配额——demo 无此行为。
- 审计 UI 页（center 审计 tab）、审计事件的分页 UI——S1d/S3b；S1a 只有只读 REST。
- 每账号独立 uid、FUSE 挂载点权限——ADR-0010 升级路径 / S1b。
- OIDC 首登 provisioning 建沙箱——S3a 复用 S1a 的惰性 mkdir 函数。

## Capabilities

### New Capabilities

- `sandbox-core`：`resolve` 契约与逃逸向量集、`ensureSharedDir` 权限位、`rootOf` 端口、拒绝自动审计。
- `audit-core`：`audit_events` schema 与只追加触发器、`emit`/`query`、`GET /api/audit`。
- `workspaces`：`workspaces` schema、列表/创建/目录树/新建目录/文件预览 REST、沙箱根惰性创建、账号隔离。
- `files-web`：`/files` 页、API 客户端扩展、Markdown/CSV/代码/图片预览、`?ws=`。
- `omp-uid-isolation`：`OMP_USER` 配置、sudo spawn 前缀、共享目录权限、DB 文件权限、Linux 集成测试与 CI job。
- `files-harness`：沙箱夹具、`smoke/files.hurl`、走查 `/files` 步骤、控制面同步。

### Modified Capabilities（各有 `specs/<capability>/spec.md` 的 `## MODIFIED Requirements` delta，**以 S0b delta 重述后的文本为基线**——本 change 假定 S0b 先归档）

- `http-service-skeleton`：错误信封七码 → 十一码（`sandbox_denied` 403、`conflict` 409、`preview_too_large` 413、`preview_unsupported` 415），content-parser 归属集增 `POST /api/workspaces`、`POST /api/workspaces/:id/dirs`；启动配置增 `OMP_USER`，模块清单增 `workspaces`、`accounts`，非内存 DB 文件 `0600`。
- `spa-shell`：`/files` 从占位壳换为工作空间页（`?ws=<id>`）。
- `verification-harness`：`make smoke` 四文件；走查增 `/files` 步骤；CI 增 `uid-isolation` job（八个 direct job）；`第三方 CI action 使用 Node 24 runtime` 的使用矩阵随之 +1；`downgrades` 删除 `/proc` 条目。
- `omp-runtime`（S0b 新增，尚未 promoted）：`子进程 spawn 契约` 增 `OMP_USER` 下的 sudo 前缀与目录权限位。

## Impact

- 代码：`server/src/core/{sandbox,audit}`（新）、`server/src/{workspaces,accounts}`（新模块）、`server/src/core/db/migrations/{030_audit_events,031_workspaces}.sql`、`server/src/{app,server,http/errors}.ts`、`server/src/sessions/omp/process.ts`（sudo 前缀，S0b 代码）、`server/test/support/fake-omp.mjs`（probe 模式）、`server/test/linux/`、`web/src/features/files`、`web/src/lib/api.ts`、`web/src/routes/router.tsx`、`smoke/files.hurl`、`smoke/fixtures/sandbox/`、`web/e2e/ui-walk.spec.ts`。
- 构建/控制面：`.github/workflows/ci.yml`（`uid-isolation` job）、`.github/scripts/{ci-uid-isolation.sh,ci-compiled-server.sh}`、`scripts/test-ci-harness.sh` 与 `scripts/inspect-ci-workflow.js`（oracle 期望）、`AGENTS.md`、`constraints.yaml`（`downgrades` 删条目）、`docs/adr/0010`（已补充，oracle）。
- 依赖：**零新增 npm 依赖**——文件系统用 `node:fs`，Markdown 渲染移植 demo 纯函数，sudo 为系统二进制。
- 跨 change 依赖：本 change 的 uid 组依赖 S0b 的 spawn 契约、假 omp、SessionRuntime 与 CI 脚本（Epic #81 的 #85/#87/#96/#105）；沙箱/审计/工作空间/web 四组与 S0b 实现并行无冲突。

## 最终归档协调（2026-09-24）

24 个子 issue（#112–#135）已全部合并并选择性归档。当前规范是 `openspec/specs/`；上文设计与本包其他 delta 保留为历史意图，不得再次整体应用覆盖后续强化。S0b 父已在 `archive/2026-09-24-s0b-minimal-chat-loop/` 归档，原先的顺序前提已满足。

两名独立只读 reviewer 分别核对 core 13 条、surface/UID 16 条，共 29/29 父 requirement；未发现遗漏的未晋升义务。当前 17 个 canonical specs 的 strict validation 为 17 PASS / 0 FAIL。父原先四个 MODIFIED 块缺少后续已晋升场景，因此只将 HTTP 错误信封及验证 HTTP/UI/CI 四块协调为完整当前 canonical 文本；其余历史 delta 不重写。归档使用 `--skip-specs`，不使用 `--no-validate`，并以全部 canonical 文件 SHA256 前后相等证明零覆盖。

### Requirement 覆盖清单

状态：IDENTICAL=义务相同；SPLIT_RENAMED=已拆分/重命名；SUPERSEDED_COVERED=后续已审核合同覆盖并强化。canonical 标题为最终权威，子归档中的任务与 PR 为实施证据。

| 父 capability / requirement | 状态 | 当前 canonical 条款 | 实施证据 |
|---|---|---|---|
| sandbox-core / resolve 契约与逃逸向量 | SUPERSEDED_COVERED | openspec/specs/sandbox-core/spec.md:6-23 — resolve 契约与逃逸向量 | openspec/changes/archive/2026-09-19-sandbox-resolve/tasks.md:1-22（#112 / PR #138）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:9,39-41（#127 / PR #188 的 ENOTDIR 后续修正） |
| sandbox-core / 沙箱 facade 与拒绝审计 | SUPERSEDED_COVERED | openspec/specs/sandbox-core/spec.md:32-53 — 沙箱 facade 与拒绝审计<br>openspec/specs/workspaces/spec.md:39-44 — 工作空间 store 与惰性目录事务<br>openspec/specs/http-service-skeleton/spec.md:144-160 — Shared agent module assembly | openspec/changes/archive/2026-09-20-sandbox-facade/tasks.md:1-24（#123 / PR #179）<br>openspec/changes/archive/2026-09-20-workspace-store/tasks.md:1-21（#125 / PR #184）<br>openspec/changes/archive/2026-09-21-workspace-rest/tasks.md:1-17（#127 / PR #188）<br>openspec/changes/archive/2026-09-23-workspace-app-assembly/tasks.md:1-15（#128 / PR #223） |
| sandbox-core / 共享目录权限位 | IDENTICAL | openspec/specs/sandbox-core/spec.md:25-30 — 共享目录权限位 | openspec/changes/archive/2026-09-19-sandbox-shared-directories/tasks.md:1-20（#113 / PR #142）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:10 |
| audit-core / 只追加审计表 | IDENTICAL | openspec/specs/audit-core/spec.md:6-11 — 只追加审计表 | openspec/changes/archive/2026-09-19-audit-events-migration/tasks.md:1-21（#114 / PR #146）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:19 |
| audit-core / emit 与 query | SUPERSEDED_COVERED | openspec/specs/audit-core/spec.md:13-36 — emit 与 query<br>openspec/specs/http-service-skeleton/spec.md:133-142 — 公共错误类型归属 core | openspec/changes/archive/2026-09-20-audit-api/tasks.md:1-29（#122 / PR #163）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:20,25 |
| audit-core / 审计只读端点 | SUPERSEDED_COVERED | openspec/specs/audit-core/spec.md:38-55 — 审计只读端点<br>openspec/specs/http-service-skeleton/spec.md:144-160 — Shared agent module assembly | openspec/changes/archive/2026-09-20-audit-rest/tasks.md:1-26（#124 / PR #167）<br>openspec/changes/archive/2026-09-23-workspace-app-assembly/tasks.md:1-15（#128 / PR #223）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:21,25,34 |
| workspaces / 工作空间 schema 与惰性沙箱根 | SPLIT_RENAMED | openspec/specs/workspaces/spec.md:6-11 — 工作空间 schema<br>openspec/specs/workspaces/spec.md:39-78 — 工作空间 store 与惰性目录事务<br>openspec/specs/workspaces/spec.md:80-89 — 列表与创建<br>openspec/specs/http-service-skeleton/spec.md:39-41 — 服务启动与装配：完整装配路由与惰性根 | openspec/changes/archive/2026-09-19-workspaces-migration/tasks.md:1-22（#116 / PR #151）<br>openspec/changes/archive/2026-09-20-workspace-store/tasks.md:1-21（#125 / PR #184）<br>openspec/changes/archive/2026-09-23-workspace-app-assembly/tasks.md:1-15（#128 / PR #223）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:30-34,40-42 |
| workspaces / 列表与创建 | SUPERSEDED_COVERED | openspec/specs/workspaces/spec.md:39-89 — 工作空间 store 与惰性目录事务；列表与创建<br>openspec/specs/workspaces/spec.md:113-120 — 工作空间 HTTP 集成边界 | openspec/changes/archive/2026-09-20-workspace-store/tasks.md:1-21（#125 / PR #184）<br>openspec/changes/archive/2026-09-21-workspace-rest/tasks.md:1-17（#127 / PR #188）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:31,33 |
| workspaces / 目录树、新建目录与隔离 | IDENTICAL | openspec/specs/workspaces/spec.md:91-100 — 目录树、新建目录与隔离<br>openspec/specs/workspaces/spec.md:13-22 — 单层目录列举辅助<br>openspec/specs/workspaces/spec.md:113-136 — 工作空间 HTTP 集成边界 | openspec/changes/archive/2026-09-20-workspace-file-helpers/tasks.md:1-19（#117 / PR #175）<br>openspec/changes/archive/2026-09-21-workspace-rest/tasks.md:1-19（#127 / PR #188）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:32-33,39-41 |
| workspaces / 文件预览 | IDENTICAL | openspec/specs/workspaces/spec.md:102-111 — 文件预览<br>openspec/specs/workspaces/spec.md:24-37 — 预览分类元数据与有界字节流<br>openspec/specs/workspaces/spec.md:113-138 — 工作空间 HTTP 集成边界 | openspec/changes/archive/2026-09-20-workspace-file-helpers/tasks.md:1-19（#117 / PR #175）<br>openspec/changes/archive/2026-09-21-workspace-rest/tasks.md:1-19（#127 / PR #188）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:32-33 |
| http-service-skeleton / 统一错误信封 | SUPERSEDED_COVERED | openspec/specs/http-service-skeleton/spec.md:58-97 — 统一错误信封（完整六个现行场景）<br>openspec/specs/http-service-skeleton/spec.md:133-142 — 公共错误类型归属 core<br>openspec/specs/chat-sessions/spec.md:132-147 — REST prompt 受理与补偿<br>openspec/specs/model-proxy/spec.md:41-46,72-76 — 透传端点与 bearer 鉴权<br>openspec/specs/workspaces/spec.md:80-81,91-92,113-136 — 列表与创建；目录树、新建目录与隔离；工作空间 HTTP 集成边界 | openspec/changes/archive/2026-09-20-audit-api/tasks.md:1-29（#122 / PR #163，core/error 所有权）<br>openspec/changes/archive/2026-09-20-workspace-error-envelope/tasks.md:1-23（#115 / PR #173，十一 code/六 owner）<br>openspec/changes/archive/2026-09-21-s0b-session-rest/design.md:9,19（已接受的 prompt 长度单位修正）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:20,29,38,42 |
| http-service-skeleton / 服务启动与装配 | IDENTICAL | openspec/specs/http-service-skeleton/spec.md:6-41 — 服务启动与装配 | openspec/changes/archive/2026-09-23-workspace-app-assembly/tasks.md:1-21（#128 / PR #223）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:34,42 |
| http-service-skeleton / Shared agent module assembly | IDENTICAL | openspec/specs/http-service-skeleton/spec.md:144-164 — Shared agent module assembly | openspec/changes/archive/2026-09-23-workspace-app-assembly/tasks.md:1-21（#128 / PR #223）<br>openspec/changes/s1a-sandbox-audit-files/tasks.md:34,42 |
| files-web / API 客户端扩展 | SUPERSEDED_COVERED | openspec/specs/files-web/spec.md:6-16 — API 客户端扩展 | openspec/changes/archive/2026-09-19-files-api-client/tasks.md:1-5 — #118/PR153，六方法及预览头部/Blob 证据<br>openspec/changes/s1a-sandbox-audit-files/tasks.md — 4.1 |
| files-web / 工作空间页 | SUPERSEDED_COVERED | openspec/specs/files-web/spec.md:34-55 — 工作空间页 | openspec/changes/archive/2026-09-23-files-workspace-page/tasks.md:7-20 — #129/PR229<br>openspec/changes/s1a-sandbox-audit-files/tasks.md — 4.3 |
| files-web / 目录树与预览 | SPLIT_RENAMED | openspec/specs/files-web/spec.md:57-75 — 目录树与预览<br>openspec/specs/files-web/spec.md:18-32 — 文件预览纯组件 | openspec/changes/archive/2026-09-20-file-preview-components/tasks.md:1-5 — #119/PR155<br>openspec/changes/archive/2026-09-23-files-workspace-page/tasks.md:9-19 — #129/PR229 |
| spa-shell / 路由 IA 与侧栏 | SUPERSEDED_COVERED | openspec/specs/spa-shell/spec.md — 路由 IA 与侧栏 | openspec/changes/archive/2026-09-23-files-workspace-page/tasks.md:12-20 — #129/PR229，真实 /files 与路由断言<br>openspec/changes/archive/2026-09-24-s0b-minimal-chat-loop/tasks.md:69-95 — S0b 父已归档且根会话页已晋升 |
| files-harness / 沙箱夹具与 files.hurl | SUPERSEDED_COVERED | openspec/specs/files-harness/spec.md:6-15 — 沙箱夹具与 files.hurl<br>openspec/specs/verification-harness/spec.md:6-33 — HTTP smoke（hurl） | openspec/changes/archive/2026-09-24-files-http-smoke/tasks.md:7-14,29-35 — #130/PR253，四文件重复实测、旧相同审计反例 RED<br>openspec/changes/s1a-sandbox-audit-files/tasks.md — 6.1 |
| files-harness / 走查 /files 步骤 | SUPERSEDED_COVERED | openspec/specs/files-harness/spec.md:17-26 — 走查 /files 步骤<br>openspec/specs/verification-harness/spec.md:35-61 — UI 走查（Playwright） | openspec/changes/archive/2026-09-24-files-ui-walk/tasks.md:3-13 — #133/PR262，误字节 RED→恢复 GREEN，fresh UI CI |
| files-harness / 控制面与 oracle 同步 | SUPERSEDED_COVERED | openspec/specs/files-harness/spec.md:28-33 — 控制面与 oracle 同步<br>openspec/specs/verification-harness/spec.md:63-118 — CI 接线与控制面同步 | openspec/changes/archive/2026-09-24-files-control-plane/tasks.md:2-12 — #135/PR266，Directory Map/HTTP evidence 和 722PASS 的既有 oracle 历史记录<br>openspec/changes/s1a-sandbox-audit-files/tasks.md — 6.3 |
| omp-runtime / 子进程 spawn 契约 | SPLIT_RENAMED | openspec/specs/omp-runtime/spec.md — 子进程 spawn 契约<br>openspec/specs/omp-uid-isolation/spec.md:6-37 — OMP_USER 配置与 sudo spawn 前缀；sudo 模式拒绝不安全 PATH<br>openspec/specs/omp-uid-isolation/spec.md:40-57 — 自有状态不对组可读<br>openspec/specs/omp-uid-isolation/spec.md:59-74 — Linux 隔离证明 | openspec/changes/archive/2026-09-24-s0b-minimal-chat-loop/tasks.md:7-16,69-95 — S0b spawn 基线已晋升<br>openspec/changes/archive/2026-09-23-omp-user-sudo-spawn/tasks.md:2-7 — #120/PR215<br>openspec/changes/archive/2026-09-23-sudo-tmpdir-forwarding/tasks.md:7-14,29-34 — #239/PR240<br>openspec/changes/archive/2026-09-23-owned-state-permissions/tasks.md:3-7 — #126/PR220 |
| omp-uid-isolation / OMP_USER 配置与 sudo spawn 前缀 | SPLIT_RENAMED | openspec/specs/omp-uid-isolation/spec.md:6-29 — OMP_USER 配置与 sudo spawn 前缀<br>openspec/specs/omp-uid-isolation/spec.md:31-37 — sudo 模式拒绝不安全 PATH<br>openspec/specs/omp-runtime/spec.md — 子进程 spawn 契约 | openspec/changes/archive/2026-09-23-omp-user-sudo-spawn/tasks.md:2-7 — #120/PR215<br>openspec/changes/archive/2026-09-23-sudo-tmpdir-forwarding/tasks.md:7-14,29-34 — #239/PR240 |
| omp-uid-isolation / 自有状态不对组可读 | SUPERSEDED_COVERED | openspec/specs/omp-uid-isolation/spec.md:40-57 — 自有状态不对组可读 | openspec/changes/archive/2026-09-23-owned-state-permissions/tasks.md:2-7 — #126/PR220 |
| omp-uid-isolation / Linux 隔离证明 | SPLIT_RENAMED | openspec/specs/omp-uid-isolation/spec.md:59-74 — Linux 隔离证明<br>openspec/specs/omp-test-harness/spec.md — 假 omp probe 回报 | openspec/changes/archive/2026-09-20-fake-omp-probe/tasks.md:3-6,20-24 — #121/PR161<br>openspec/changes/archive/2026-09-23-linux-uid-isolation-proof/tasks.md:8-18,34-39 — #131/PR242<br>openspec/changes/archive/2026-09-24-uid-isolation-ci/tasks.md:12-16 — #132/PR257 历史正式 CI |
| omp-uid-isolation / CI uid-isolation job | SPLIT_RENAMED | openspec/specs/omp-uid-isolation/spec.md:76-85 — CI uid-isolation job<br>openspec/specs/omp-uid-isolation/spec.md:87-98 — 已证明 UID 门禁关闭同 uid 降级<br>openspec/specs/verification-harness/spec.md:63-110 — CI 接线与控制面同步 | openspec/changes/archive/2026-09-24-uid-isolation-ci/tasks.md:6-16 — #132/PR257；记录 merged-master35978802687/job107565512880 通过<br>openspec/changes/archive/2026-09-24-close-uid-downgrade/tasks.md:2-13 — #134/PR264 正式后续原子关闭 |
| verification-harness / HTTP smoke（hurl） | SUPERSEDED_COVERED | openspec/specs/verification-harness/spec.md:6-33 — HTTP smoke（hurl）<br>openspec/specs/files-harness/spec.md:6-15 — 沙箱夹具与 files.hurl<br>openspec/specs/chat-harness/spec.md:6-29 — 手动真实上游冒烟入口；HTTP 冒烟对话用例 | openspec/changes/archive/2026-09-24-files-http-smoke/tasks.md:7-14,29-35 — #130/PR253<br>openspec/changes/archive/2026-09-24-s0b-minimal-chat-loop/tasks.md:59-64,69-79 — #105/#107 及 S0b 归档 |
| verification-harness / UI 走查（Playwright） | SUPERSEDED_COVERED | openspec/specs/verification-harness/spec.md:35-61 — UI 走查（Playwright）<br>openspec/specs/files-harness/spec.md:17-26 — 走查 /files 步骤<br>openspec/specs/omp-test-harness/spec.md — Isolated bounded upstream dialogue gate | openspec/changes/archive/2026-09-24-files-ui-walk/tasks.md:3-13 — #133/PR262<br>openspec/changes/archive/2026-09-24-s0b-minimal-chat-loop/tasks.md:61-64,69-75 — #106/PR255、真实在途回合及归档 |
| verification-harness / CI 接线与控制面同步 | SUPERSEDED_COVERED | openspec/specs/verification-harness/spec.md:63-121 — CI 接线与控制面同步<br>openspec/specs/omp-uid-isolation/spec.md:76-98 — CI uid-isolation job；已证明 UID 门禁关闭同 uid 降级<br>openspec/specs/files-harness/spec.md:28-33 — 控制面与 oracle 同步 | openspec/changes/archive/2026-09-24-s0b-minimal-chat-loop/tasks.md:59-64,69-79 — #105/#107 真实集成和十面控制<br>openspec/changes/archive/2026-09-24-files-http-smoke/tasks.md:7-14 — #130/PR253 双模式夹具预置<br>openspec/changes/archive/2026-09-24-uid-isolation-ci/tasks.md:6-16 — #132/PR257 官方 UID job<br>openspec/changes/archive/2026-09-24-close-uid-downgrade/tasks.md:2-13 — #134/PR264 master 证明后关闭<br>openspec/changes/archive/2026-09-24-files-control-plane/tasks.md:2-12 — #135/PR266 四文件 evidence |
| verification-harness / 第三方 CI action 使用 Node 24 runtime | IDENTICAL | openspec/specs/verification-harness/spec.md — 第三方 CI action 使用 Node 24 runtime | openspec/changes/s1a-sandbox-audit-files/specs/verification-harness/spec.md:86-114 — 父完整块<br>openspec/specs/verification-harness/spec.md — 当前完整块<br>/var/folders/lc/n1j4ywl5451brjdj_6zfq86h0000gn/T/workbuddy-111-closeout-qep5oxqc/requirement-inventory.json — exactText=true；S0b 已归档，参见 openspec/changes/archive/2026-09-24-s0b-minimal-chat-loop/tasks.md:69-79 |

### 必须保留的后续裁定

- 工作空间 schema 与惰性根拆到 schema/store/REST：可信 SANDBOX_ROOT 预置，读操作不建目录，创建事务与仅空新目录补偿；Unicode scalar 与孤立 surrogate 拒绝不可回退。
- HTTP 信封保留四个后续场景与 core 公共错误归属。旧父 prompt “32KiB wire body”并非现行合同：已审核 S0b 约束是 decoded UTF-8 message ≤32768、独立 parser envelope；不能拒绝合法 JSON escape 表示。
- 文件页保留会话代际/list-first、旧请求与当前401区别、Blob释放、实际根内容ready、同ws恢复；HTTP smoke保留拒绝审计的新鲜性，UI保留真实heldchat与精确两个auth/me401。
- sudo保留安全PATH、非凭证TMPDIR单元素在`--`之前，PAM开集+四秘密哨兵缺席、HOME/agent值、EACCES与父读取子写入证明；不能用旧闭集要求替换。
- #132正式merged-master run35978802687 / uid107565512880为1pass0skip、四文件全部成功、aggregate成功；该次40请求（chat12），较早PR38（chat10），轮询计数不是固定验收值。#134已据此关闭登记，不能恢复S0b风险条目。
- 保留八direct jobs、checkout8/setup-node6、十surface、UIDblock、剩余三条downgrade及所有阈值；新旧runtime生命周期原始失败7/cancel143与仅自有进程清理保持。

Stage4.5 `needs-followup` 的关闭条件已满足：#131原生隔离测试与#132正式job均独立审核并实际通过，安全性质未弱化。此结论不等同于任意用户生产部署认证、每账号OS隔离或race-free文件系统边界。Epic #111 保持待最终人工功能验收，不将自动化通过写作用户已验收。

最终执行证据：#132 PR257（master首绿）；#133 PR262（真实Chromium截图/零新增错误）；#134 PR264（登记闭环与owner反例）；#135 PR266（722PASS/0FAIL）。父归档 PR 自身仍需 exact-head CI 九项通过。
