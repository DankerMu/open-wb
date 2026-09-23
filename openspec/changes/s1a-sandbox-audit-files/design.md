# Design: s1a-sandbox-audit-files

## Context

S0a 交付 HTTP 骨架/认证/SPA 壳/harness，S0b（Epic #81，实现中）交付 omp 运行时、model-proxy、会话与 SSE。本 change 在其上加三块：文件系统边界（`core/sandbox`）、合规出口（`core/audit`）、文件面（`workspaces` + `/files`），并按 ADR-0010 补充把 omp 切到专用 uid。行为基准 demo 的 `/files` 页（`renderFilesPage` demo:3838-3960、`newWorkspaceModal` demo:3610、`openNewDirDialog` demo:3984、`PREVIEWABLE` demo:3818）；架构基准 system.md §3.1 `core/sandbox`/`core/audit`/`workspaces`/`accounts` 行与 §4 依赖规则。

**Oracle 差异**：system.md §3.1 给 `resolve(principal, workspaceId, relPath)`，但 §4 规则 1 禁止 core import feature——core/sandbox 拿不到工作空间表。本 change 不改 oracle，以沙箱自有端口 `rootOf` 解耦（D2），签名语义等价。IMPLEMENTATION_PLAN S1a 的"白名单推导"归 S1b（proposal 已留痕）。

**delta 基线**：`http-service-skeleton`、`spa-shell`、`verification-harness` 的三条 MODIFIED Requirement 以 **S0b delta 重述后的文本**为基线整段重述；`omp-runtime` 的 `子进程 spawn 契约` 是 S0b 新增、尚未 promoted 的 Requirement。归档顺序必须 S0b 先于本 change。

## Goals / Non-Goals

**Goals:**
- 一切经 app-server 的用户路径操作过 `resolve`；逃逸向量集（`..`、绝对路径、NUL、symlink 分量、边界前缀）全拒且审计有记录（F-FILE-5，不变量 3）。
- 工作空间列表/创建/目录树/新建目录/预览可用（F-FILE-1/2/4），`/files` 页镜像 demo 行为。
- omp 子进程以专用 uid 运行时，读 app-server `/proc/<pid>/environ` 得 EACCES（不变量 4 机械证明），S0b 的 `/proc` downgrade 关闭。
- 审计只追加且账号隔离，`GET /api/audit` 可查。

**Non-Goals:**（proposal Non-goals 全文适用）远程挂载与 `deriveWhitelist`（S1b）；会话↔空间绑定与 cwd 切换（S1c）；上传/删除/重命名/配额；审计 UI；每账号 uid；OIDC provisioning。

## Decisions

1. **模块切分**（`http → feature → core`；与 system.md §5 目录树一致）：
   - `server/src/core/sandbox/`：`resolve.ts`（纯函数：规范化 + 逐分量 lstat + realpath 边界）、`dirs.ts`（`ensureSharedDir`）、`index.ts`（`createSandbox({ rootOf, audit }) → { resolve(principal, workspaceId, relPath, op), ensureSharedDir }`）。
   - `server/src/core/audit/`：`index.ts`（`emit(db, event)`、`query(db, principal, {limit, before})`）。
   - `server/src/core/errors/`：唯一 `HttpError`、错误码与消息定义；HTTP 状态码、content-parser 归属及信封映射留在 `http/errors.ts`。用户在 #122 comment5748746011 批准原子迁移所有调用方、删除旧转发导出，以消除 core 反向依赖 http；#84/#115 后续加码须同时扩 core 消息和 HTTP 状态映射，不恢复重复定义。
   - `server/src/workspaces/`：`store.ts`（`workspaces` 表读写 + 沙箱根惰性创建）、`tree.ts`（单层列举）、`preview.ts`（类型判定 + 流式读取）、`rest.ts`（五端点）、`index.ts`（`registerWorkspaces(app, { db, sandbox, audit })`，并导出 `rootOf` 供装配注入沙箱端口）。
   - `server/src/accounts/`：`index.ts`（`registerAccounts(app, { db })`：`GET /api/audit`）。CONTEXT.md 把审计归"账号与治理"上下文，system.md 树有 `accounts/`；S1a 只放这一条路由，账号管理属 S3a。
   - `server/src/sessions/omp/process.ts`（S0b 代码）：`OMP_USER` 下 argv 前缀（D6）。
   - `web/src/features/files/`：`page.tsx`、`tree.tsx`、`preview.tsx`、`md-render.ts`（移植 demo:1145，先 `esc` 再加标签）、`csv.ts`；`web/src/lib/api.ts` 扩展。
2. **沙箱端口与 resolve 契约**（grill 事实项）：`rootOf(principal, workspaceId) → absRoot | null` 由 workspaces 实现（按 `owner_id = principal.id` 查表，他人/不存在 → null → 调用方 404）。`resolve(root, relPath, op)`：`relPath` 必须是 `/`-分隔相对路径（空串 = 根）；拒绝条件：含 NUL、以 `/` 开头、任一分量为 `..`、规范化后逃出 root、任一**已存在**分量是 symlink（`lstat`；S1a 不跟随任何 symlink——S1b 挂载点再议）；最终 `realpath(root)` 与目标按边界前缀匹配（`root === p || p.startsWith(root + "/")`，demo `mountOf` 同法）。拒绝返回 `{ ok:false, reason }`，facade 层 `emit` 审计 `sandbox.reject{actorId, workspaceId, relPath, op, reason}` 后抛 `HttpError("sandbox_denied")`。`op ∈ {read, list, mkdir}`（S1a 全部写操作 = mkdir）。**边界判定**：不变量 3 的「必入审计」只覆盖到达 `resolve` 的路径操作；`POST /api/workspaces` 显式 `dir` 不满足 schema 正则（含 `..`/`/`）在 body 校验层即 400 `bad_request`、不写审计——它从未触及文件系统，与 `dir` 拼错同类。
3. **目录权限位**（grill 已定共享组 + setgid）：`ensureSharedDir(abs)` = `mkdirSync(recursive)` 后对每个新建分量 `chmodSync(0o2770)`；组归属靠父目录 setgid 继承——`SANDBOX_ROOT`/`OMP_STATE_DIR` 根由部署/CI 脚本 `chgrp workbuddy && chmod 2770` 预置，app-server **不 chown**（不引入 `SANDBOX_GROUP` 配置）。app-server 自有状态：非 `:memory:` DB 文件 SHALL 在 `openDb` **之前**就是 `0o600`——入口对缺失文件以 `openSync(path, "wx", 0o600)` 创建后关闭，对既有文件及已存在的 `-wal`/`-shm` `chmodSync(0o600)`，然后才 `openDb`（WAL 模式在 open 时立即建 `-wal`/`-shm`，SQLite unix VFS 以**当时**主文件的 mode 创建它们——先 open 后 chmod 会留下 0644 的 WAL 里含密码哈希/审计明文的窗口）；测试断言主文件与 `-wal`/`-shm` 三者 mode。不改全局 umask（改 umask 会让 DB 变组可读）。**已记录的缺口**：ADR-0010 补充要求 app-server 自有目录 `0700`，但默认布局下 `dirname(DB_PATH)` = `var/` 同时是 `var/sandbox`、`var/omp-state`、`var/omp` 的父目录，omp 必须能遍历它，故 S1a 不把 `var/` 设 `0700`（暴露的只是文件名）；S4b 部署布局把 DB 移出共享父目录时再收口。macOS 开发机同 uid：位照设，无害。
4. **审计**：迁移 `030_audit_events.sql`：`audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER ≥0, actor_id TEXT → accounts.id, kind TEXT CHECK 非空 snake.dot, title TEXT, detail TEXT JSON 默认 '{}', workspace_id TEXT NULL)` + 索引 `(actor_id, id DESC)` + 触发器 `BEFORE UPDATE`/`BEFORE DELETE` `RAISE(ABORT, 'audit_events is append-only')`。S1a 事件种类：`sandbox.reject`、`workspace.create`、`dir.create`。`query`：成员 `actor_id = principal.id`，`role === '管理员'` 不过滤；`limit 1..200` 默认 50，`before=<id>` 游标，`id DESC`。`GET /api/audit` 受 cookie guard，`no-store`。
5. **工作空间**：迁移 `031_workspaces.sql`：`workspaces(id TEXT PK 32 hex, owner_id → accounts.id CASCADE, name TEXT 1..64, dir TEXT, created_at)`，`UNIQUE(owner_id,name)`、`UNIQUE(owner_id,dir)`，`dir` CHECK 匹配 `^[A-Za-z0-9_一-龥-]{1,64}$` 且非 `.`/`..`。`dir` 缺省由 `name` 按 demo 正则 `[^\w一-龥-]` → `-` 派生。创建：事务内插行 → `ensureSharedDir(<SANDBOX_ROOT>/<ownerId>)`（惰性沙箱根，grill 已定）→ `ensureSharedDir(root)`（已存在目录直接采用——夹具/运维预置合法）→ `emit(workspace.create, title: "创建工作空间 <name>", detail:{root})`（demo 文案）；mkdir 失败回滚。`dir.create` 的 title 为 `新建目录 <path>`。响应含 `root` 绝对路径（demo 在切换器显示路径）。REST：`GET /api/workspaces`、`POST /api/workspaces {name, dir?}`（201 / 409 `conflict` / 400）、`GET /api/workspaces/:id/tree?path=`（`{path, entries:[{name,type:'dir'|'file',size,mtime}]}`，目录在前、字节序、跳过 symlink 与特殊文件；非目录 404）、`POST /api/workspaces/:id/dirs {path}`（末段规则：非空、无 `/`/`\`、非 `.`/`..`；父必须存在；已存在 409；201 `{path}` + `emit(dir.create)`）、`GET /api/workspaces/:id/file?path=`（D7）。他人/不存在空间一律 404。归属集：两条 POST 进 content-parser 归属集（body 上限 16 KiB）。
6. **omp uid 分离**（ADR-0010 补充）：配置 `OMP_USER`（可缺；`^[a-z_][a-z0-9_-]{0,31}$`；显式空非法）。设置时 `OmpProcess.spawn` 的可执行文件为 `sudo`（PATH 发现），argv = `["-n","-u",OMP_USER,"--preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN",...optionalTmpdirAssignment,"--", OMP_BIN, ...ompArgs]`，sudo 进程自身 env **精确等于 S0b 白名单**（凭证值经 env 而非 argv 传递；非凭证 TMPDIR 例外——`/proc/<pid>/cmdline` 对任意本机用户 0444 可读，`WORKBUDDY_MODEL_TOKEN` 绝不能进命令行，与 ADR-0003「凭证不上命令行」同理；sudo 为 setuid root，其 `environ` 属主 root，其他用户不可读）；sudoers 的 `SETENV` 标签允许白名单保留及受控赋值，但不能恢复 setuid 加载器在 sudo 启动前已剥离的 TMPDIR。ADR-0010 补充原文写的是命令行赋值，已在同日 docs PR 更正为 `--preserve-env`（oracle 更正留痕）。未设置时行为与 S0b 完全一致。S0b 的"子进程 env 精确等于白名单"断言只对**sudo 进程自身**成立；sudoers `env_reset` 会向目标命令注入 `SUDO_COMMAND`、`SUDO_USER`、`SUDO_UID`、`SUDO_GID`、`LOGNAME`、`USER`、`MAIL`、`SHELL`、`TERM` 与 PAM 可能并入的 `LANG`/`LC_*`（sudoers(5) Command environment 节，无配置可关），PAM `pam_env` 还会把 `/etc/environment` 的键并入（GitHub runner 镜像写入 `ANDROID_*`、`CHROMEWEBDRIVER` 等），所以注入键集**不可枚举成闭集**；omp 子进程的键集在 sudo 形态下断言为**安全性质**：白名单 ⊆ 键集、测试进程预先注入的三密钥键与哨兵键 `WORKBUDDY_CANARY_SECRET` 均不在键集（证明多出的键来自 sudo/PAM 而非 app-server 环境）、`HOME`/`PI_CODING_AGENT_DIR` 的值等于我们传入的值（`always_set_home` 默认 off，`SETENV` + `--preserve-env=HOME` 保住我们的 HOME）、`WORKBUDDY_MODEL_TOKEN` 为 64 hex。**不断言 `PATH` 的值**：sudoers `env_reset` 条目明文「secure_path 启用时其值将用作 PATH」，Ubuntu 默认启用且无 `--preserve-env` 例外，我们不为此加 `!secure_path` 例外（`<OMP_BIN>` 是绝对路径；omp 与其 bash 工具在 Ubuntu 默认 secure_path 下照常可用）。`uid-isolation` job 先以 `sudo -n -u omp --preserve-env=HOME,PATH -- /usr/bin/env` 做 preflight：断言输出含 `HOME=<传入值>` 行（否则非零退出），并打印全部输出作为 secure_path/注入键的实证，再跑测试。目录：S0b 已在 spawn 前 mkdir 四目录，本 change 把它们换成 `ensureSharedDir`（`2770`）。sudo 失败（-n 需密码、规则缺失）表现为子进程立即退出 → S0b 既有 `agent_unavailable` 路径。macOS/单测不设 `OMP_USER`。 #239 修正：`optionalTmpdirAssignment` / `[TMPDIR=<value>]` 表示白名单 TMPDIR 已定义（含空串）时，在 `--` 前增加一个 `TMPDIR=<精确值>` argv 元素，缺席时零元素；不经 shell 展开或拆分。此非凭证路径例外跨过 glibc setuid 对 TMPDIR 的剥离，不允许 token/上游密钥上命令行。
7. **预览**：`PREVIEWABLE = {md,txt,log,csv,json,js,ts,tsx,html,png,jpg,jpeg}`（demo:3818）。文本类以 `text/plain; charset=utf-8` 返回（含 `html`——绝不以 `text/html` 回吐用户文件），头 `X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`X-Workbuddy-Size: <bytes>`；超过 1 MiB 只返回前 1 MiB 并加 `X-Workbuddy-Truncated: 1`（demo "大文件仅预览前若干行"）。图片以 `image/png` / `image/jpeg` 返回，> 10 MiB → 413 `preview_too_large`。扩展名不在集合 → 415 `preview_unsupported`（前端亦按扩展名先行判定，不发请求）。非普通文件/不存在 → 404。
8. **配置与装配**：`OMP_USER` 加入 `server.ts` 配置 seam；`STARTUP_MODULES = ["core/db","auth","http","model-proxy","sessions","workspaces","accounts"]`（S0b 五项后追加）；装配顺序 sessions 之后 `registerWorkspaces` → `registerAccounts`；沙箱 facade 在 `createApp` 内以 `rootOf`（来自 workspaces store）与 `emit` 构造，注入 workspaces；sessions 的 spawn 目录创建改用 `ensureSharedDir`。
9. **web**：`/files` 用 `?ws=<id>` 表示当前空间（与 `?session=` 同法，刷新可回）；无空间时显示 demo 空态（`该工作空间暂无目录` / `点击左上角 ＋ 新建文件夹…`）；切换器弹层（搜索 + 列表 + `＋ 新建工作空间`）；`＋` 菜单两项（新建文件夹 / 新建工作空间），新建文件夹的"位置"下拉只列已展开加载过的目录（懒加载下不遍历全树），空名 → `请填写文件夹名称`、含分隔符 → `名称不能包含路径分隔符`、409 → demo 专用文案 `该目录下已存在同名条目`（对话框层覆盖通用信封文案）；`?ws=` 指向不在列表中的 id（他人/不存在）时回退到列表首个并 `replace` 纠正 URL，无空间时清掉参数——不产生 console error；预览：`md` 渲染/源码切换（按钮文案 `查看源码`/`渲染视图`）、`csv` 表格 + `共 N 行` 注、代码行号表、图片 `<img>`、不支持态文案 demo 原文、截断横幅。`routeManifest` 中 `/files` 的 `description` 与 `web/test/routes.test.tsx`、`web/e2e/ui-walk.spec.ts` 对 `/files` 的断言同步更新（heading `工作空间` 不变）。
   **深层格式决策（用户授权，#119 comment5747856916）**：普通 Markdown 保持 demo；病态重建输出最多保留 64 层 `strong` 祖先，规范化冗余包装但保留全部文字、链接作用范围与可见格式。HTML/React 共用同一规范节点，不使用危险 HTML sink；同实例浅→近 1 MiB 深→普通→切换→卸载在开发/生产及 StrictMode 验证。64 是显式应用策略，不把 Chromium 实测深度当可移植标准。
10. **假 omp probe 模式**（uid 证明载体）：S0b 假 omp 增模式——prompt 文本为 `probe:<pid>:<writePath>` 时先以自身 uid 在 `<writePath>` 写一个文件（内容 `probe`），再回一段 `text_delta`：`uid=<process.getuid()> gid=<getgid()> env=<sorted keys> home=<$HOME> agent=<$PI_CODING_AGENT_DIR> environ=<读 /proc/<pid>/environ 的结果: EACCES|readable|<errno>> wrote=<ok|errno>`。Linux 集成测试（`server/test/linux/uid-isolation.test.ts`，`describe.skipIf(!WORKBUDDY_UID_TEST)`）以 `OMP_USER` 起 SessionRuntime → 断言 uid ≠ 本进程、env 满足 D6 的 sudo 形态安全性质（白名单 ⊆ 键集、三密钥键与哨兵键不存在、`home`/`agent` 回报值等于传入值）、`environ=EACCES`、`wrote=ok`（omp 用户在 `2770` 沙箱目录内写入）且 app-server 以 `tree` 列出该文件。
11. **CI `uid-isolation` job**（ubuntu）：checkout → setup-node → `npm ci` → build web/server → `make omp-fetch` → install hurl 8.0.1（与 smoke job 同一脚本）→ `bash .github/scripts/ci-uid-isolation.sh`（复制 `smoke/fixtures/sandbox/u1/` 到 job-owned `SANDBOX_ROOT/u1/`、`groupadd workbuddy`、`useradd -m -G workbuddy omp`、`usermod -aG workbuddy $USER`、写 `/etc/sudoers.d/workbuddy-omp`（假 omp、真 omp、`/usr/bin/env` 三条 `SETENV` 规则——preflight 不依赖 runner 预置的 `ALL` 规则）、runner-temp 下 `SANDBOX_ROOT`/`OMP_STATE_DIR` `chgrp workbuddy && chmod 2770`；preflight `sudo -n -u omp --preserve-env=HOME,PATH -- /usr/bin/env` 门禁 `HOME` 行；以 `sg workbuddy -c` 运行 Linux 集成测试；再起假上游、以 `OMP_USER=omp` 经 `ci-compiled-server.sh smoke` 跑 `make smoke`——真实 omp 在 sudo 下完成 `chat.hurl`）。进入 `all-checks-passed`（八个 direct job）。`scripts/test-ci-harness.sh`（`check_wf` 的 direct 元组/aggregate needs/新 job 形状）与 `scripts/inspect-ci-workflow.js`（`WANT` checkout 8、setup-node 6）同 PR 更新；`ci-compiled-server.sh` 透传 `OMP_USER` 需同步 `test-ci-harness.sh` `contract()` 对该 helper 的期望行（新增透传行进入 `same()` 断言）。job 全绿后删除 `constraints.yaml downgrades` 的 `/proc` 条目。
12. **harness**：tracked `smoke/fixtures/sandbox/u1/smoke-fixture/{readme.md,notes.csv,logo.png}`，caller（CI 脚本 / 本地）在起服务前复制到 `<SANDBOX_ROOT>/u1/`；`files.hurl`：登录 → `POST /api/workspaces {name:"smoke-fixture"}`（201，采用既有目录）→ 列表含 → `tree` 含三文件 → `POST dirs {path:"out"}` 201 → 再建 409 → `tree?path=../..` 403 `sandbox_denied` → `GET /api/audit` 首条 `kind==sandbox.reject` → `file?path=readme.md` 精确字节 + `text/plain` → `file?path=logo.png` `image/png` → 他账号 `GET /api/workspaces/<id>/tree` 404。走查 `/files` 步骤：切到 `smoke-fixture`、展开、点 `readme.md` 看到渲染标题、`查看源码`、点 `notes.csv` 看到表格、新建文件夹 `out2` 出现在树中。控制面：AGENTS.md Directory Map `server/` 描述含文件面/审计；`constraints.yaml` 只删 downgrade（无新 make 目标，surfaces 不变）；两处改动的 oracle 锚点同 PR 更新。

## Sketch seams under test

- `core/sandbox` `resolve(root, rel, op)` 纯函数 + 临时目录（逃逸向量集：`..`、绝对、NUL、symlink 文件/目录/悬空、`/a` vs `/ab` 边界）——最高价值白盒面，一处证明全局。
- `app.inject()` 对完整装配 app（临时 `SANDBOX_ROOT` + `:memory:` DB）：workspaces 五端点 + `GET /api/audit`——一条 seam 覆盖隔离/信封/审计联动。
- S0b 的 spawn 参数捕获注入点（`spawnImpl`）：`OMP_USER` 前缀 argv 断言，不起进程。
- Linux 真实子进程 seam（S0b 假 omp + probe 模式）：uid/env/`/proc` 三断言，仅 CI ubuntu。
- web jsdom（mock fetch）：`/files` 页一次"选空间 → 展开 → 预览 → 新建目录"。
- CI job `uid-isolation` 全绿 = uid 分离在真实 omp 上的唯一端到端证明。

## Not yet specified

- 只读/离线根（S1b 挂载）出现后 `新建文件夹` 的"位置"下拉与 `resolve(op=mkdir)` 如何对只读根拒绝——现在只知道"只读挂载与离线挂载不可新建"，拒绝归哪一层（sandbox 还是 workspaces）等挂载模型定。
- 沙箱配额（demo 显示 `配额 20 GB`）：是否在 mkdir/写入路径上强制、由谁统计，尚无问题边界。
- 审计事件的保留期/归档策略：只追加表会无限增长，何时压缩、是否导出，随 S3b 审计面一起看。

## Risks / Trade-offs

- **sudo 依赖部署正确性**：sudoers 规则缺失/路径不符 → omp 起不来 → 用户看到 502。缓解：`uid-isolation` job 就是该配置的活文档；S4b 部署包生成 sudoers。
- **同组可读**：omp 与 app-server 同组 `workbuddy`，app-server 任何组可读的文件都暴露给 omp——因此 DB `0600`、不改 umask、配置文件不落沙箱树。CI 测试断言 DB 文件权限。
- **不跟随 symlink**：用户在沙箱内自建的合法 symlink 也会被拒——S1a 取保守；S1b 挂载点需要例外时再放宽（届时 `resolve` 加 allowlist）。
- **预览走 Node 进程内存**：1 MiB / 10 MiB 上限保证有界；以 stream + 计数截断，不整读。
- **Linux-only 测试自跳过**：`make test` 在 macOS 上 skip 该文件，绿不代表 uid 分离成立；唯一证明点是 CI job，故它进 `all-checks-passed`。
- **迁移计数断言**：S0b 的 `020` 与本 change 的 `030/031` 落地顺序不定；`core-db` 的计数断言由先落地者 +1、后落地者再 +1，任务中写明"随之 +1"而非固定数字。本地持久化 `var/dev.db` 若先应用了 `030/031` 再迎来 `020`，迁移账本的连续前缀校验会拒绝——开发者删 `var/dev.db` 重建即可（CI 全新 DB 不受影响），tasks.md 头部写明。
- **八个 direct job 的 Node 24 矩阵**：`inspect-ci-workflow.js` 与 promoted `第三方 CI action 使用 Node 24 runtime` 的计数全部硬编码，本 change 必须整段重述该 Requirement 并同 PR 改 oracle。

## Migration Plan

新增迁移 `030_audit_events.sql`、`031_workspaces.sql` 经 `openDb` 顺序执行；无数据迁移。回滚 = 移除两个迁移与模块注册（开发期库可删 `var/dev.db`）；uid 分离可通过不设 `OMP_USER` 即时回退到 S0b 行为。
