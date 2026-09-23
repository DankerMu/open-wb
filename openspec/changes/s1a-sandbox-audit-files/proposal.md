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
