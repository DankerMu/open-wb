# Design: s1b-workspace-mounts

## Context

事实基线（worktree 基于 `openspec/s1b-s1d-pipeline` `ce04105e`，2026-10-22 读码；rclone 语义以测试主机已装的 v1.60.1 为准，未经 #1665 实测的一律列入 Open Questions；每组第一个任务仍核对行号）：

- **计划与 ADR**：S1b Outcome「mount-manager（rclone/sshfs 生命周期、凭证经受权限保护的配置文件注入、崩溃重挂、在线状态）；挂载点入白名单推导」，Verify「SFTP 真实挂载读写 + 断连状态呈现 + 卸载后白名单收回（测试 VPS 上跑）」（`IMPLEMENTATION_PLAN.md:198-205`）；风险「FUSE 开发环境断层 → S1b 首任务建 Linux 验证路径」（:501）；回滚「挂载功能独立 feature-flag，故障不阻塞空间根目录使用」（:509）；前置「app-server uid 挂载 + omp uid 可读写（`allow_other`）+ rclone 配置对 omp 不可读三者同时成立」（:545-546，即 #1665）。ADR-0003 :3-5 定「SFTP/NFS/SMB 用 rclone mount/sshfs 以 FUSE 按工作空间挂载到沙箱内」，:12-14「凭证由 app-server 保管（不落沙箱），只经受权限保护的 rclone 配置文件注入（属主 app-server、路径在全部沙箱白名单之外），绝不出现在命令行参数」。ADR-0010 :36-38 两 uid 同属组 `workbuddy`、目录 `2770`、双方 umask `007`，否决 POSIX ACL（「S1b 挂载不保证」）；:142-158 sshfs / rclone 在内核 6.8 上的目录指纹实测与 #1212「挂载目录整体不参与快照与还原」；:306-312 #1237 判据「挂载点以 `rmdir` 返回 `EBUSY` 且出现在 `/proc/self/mountinfo` 里为准」与「用户目录树只经 `fs/promises` 的 `rm` 删除，`rmSync` 会穿过 FUSE 挂载点」。
- **既有规格**：file-operations「删除到回收目录」（spec :9-11）删除是一次 `rename` 进 `<SANDBOX_ROOT>/.trash/…`，`rename` 失败「含跨文件系统的 `EXDEV`」为 generic 500；「重命名与移动」（:57-58）一次 `rename`、失败 generic 500。workspaces「目录树、新建目录与隔离」（:129-130）。workspace-snapshots「快照内容规则」（:39）按 `dev` 跳过挂载点（`reason: "mount"`），「还原」（:189-192）不进入、不删除 `dev` 不同的目录——本 change 不改。temporary-workspaces「临时空间目录的删除」（:100）挂载规则「宿主 SHALL NOT 检测挂载、SHALL NOT 卸载」，只对 #1237 的外部挂载成立。files-web「工作空间页」（:56）「不宣传未交付的挂载与上传能力」。workspace-sidebar「内容与文件操作」（:55）侧边栏主体就是 `WorkspaceBrowser`。
- **代码**：工作空间路由 `workspaces/rest.ts`（tree :283-297、dirs :298-323、file :324 起）、`rest-entries.ts`（download :123、delete :167-189 经 `trash.moveToTrash` :179、move :191-237 一次 `renameSync` :226）；上传只写 `<空间根>/uploads/<名>`（workspaces「文件上传」）。`store.rootOf` 所有者作用域、临时空间标记 `temporary`（`store.ts:107,251`）。`ensureSharedDir` 逐级建目录、只对新建分量施加 `0o2770`（`core/sandbox/dirs.ts:4,27,31`）。**没有删除正式工作空间的端点**（路由只有列表、创建、promote、tree、dirs、file、download、entries、move、uploads、archive、preview-token）；唯一的空间删除路径是会话删除连带临时空间（`sessions/session-delete.ts:24` → `workspaces/temp-dir-remove.ts`，`rm` 于 :103 / :146）。
- **同步文件系统调用**（D21 的依据）：`core/sandbox/resolve.ts:35-48,69-80` 对每个已存在分量同步 `lstatSync`；facade `core/sandbox/index.ts:17-47` 以 `createSandbox({rootOf, audit})` 同步调用它并只返回绝对路径（sandbox-core「沙箱 facade 与拒绝审计」）。经 facade 解析工作空间路径的调用方：`workspaces/rest.ts:291`（tree）、`:306`（dirs）、`:332`（file）、`:397`（上传，固定 `uploads/<名>`）；`rest-entries.ts:136`（download）、`:176`（delete）、`:209-210`（move）；`rest-archive.ts:102`（archive）；`sessions/prompt-attachments.ts:137`（会话附件，随后 `lstatSync` :188）；`preview/app.ts:213`（预览源 `/w/` 与 `/o/`，随后 `lstatExisting` 与 `openRegularFile`）。直接用纯 `resolve` 的：`sessions/undo.ts:270-271`（撤回时附件是否仍在）。不经 resolve、对工作空间内路径做文件系统调用的：`workspaces/tree.ts:30-31`（`readdirSync` 后逐项 `lstatSync`）、`workspaces/snapshots.ts:375,392` 与 `snapshots-restore.ts:305,379`（快照与还原的遍历）、`sessions/file-changes-ownership.ts:124-133`（omp 报告的文件变更路径，`realpathSync` / `lstatSync`，调用方 `turn-control.ts:292`）。`workspaces/trash.ts:163` 只遍历 `.trash`。读文件的端点在主线程上 `openSync` / `fstatSync` / `closeSync`（`regular-file.ts:43,59,65`）。`ensureSharedDir` 对已存在分量用 `statSync`（`core/sandbox/dirs.ts:43`，跟随符号链接）。
- **装配**：`appAssemblyOf(config, …)`（`server.ts:159-186`）只拿配置；DB 在 `createApp`（`app.ts:166`）里；`AssemblyDependencies` 在 `app.ts:92-136`；`registerWorkspaces` 在 `app.ts:253` 调用，`trash` 缺省时就地构造（`app.ts:262-267`，不带 assembly 的测试用 `createApp` 走这条）。`startup-registry.ts` 由 `s1d-model-registry` 抽出，本 worktree 尚无。
- **托管布局**：`state-layout.ts:61-85` 的 `LAYOUT`，app 私有目录 `trash`、`snapshots` 为 `0700`（`APP_PRIVATE`，:64）；`<state>` 自身 `2750`，omp uid 不能在其下建 / 改名条目。omp-runtime「OMP_STATE_DIR 托管布局」的最新文本在 `s1d-connectors` delta（加了 `session-config` 与 `mcp.json`）。
- **启动与配置**：`resolveServerConfig` 展开 agent 二十一项与预览十二项、自有四项（`server.ts:114-130`，「三十七项」）；`BROWSER_BIN` 在配置层校验「绝对路径、可执行普通文件」（`agent-config.ts:119,251-259`），`OMP_USER` 连同 PATH 在配置层校验（:118,267）——先例：外部可执行文件与前提在配置阶段判定，失败 `reason: "config"`。`STARTUP_MODULES`（`server.ts:96-104`）在三个 s1d change 之后为十一个，最后 `connectors`；工作空间路由由 `registerWorkspaces`（`app.ts:253`）注册。启动阶段次序与 `publishStarted`（`server.ts:418-594`），`server_started` 之后 `void trash.sweep()` 不等待（:586-589）是「启动后后台工作」的先例。`server.ts` 743 行，`s1d-connectors` 之后约 790（其 design「行数预算」）。
- **错误码与归属集**：`core/errors/index.ts:5-22` 十六码，`s1d-model-registry` 之后十八码；`http/errors.ts:54` `CONTENT_PARSER_OWNED_ROUTES`，三个 s1d change 之后二十九条（`s1d-connectors` 的 http-service-skeleton delta）。计数守卫 `http-typed-errors.test.ts:123`、`http-parser-owners.test.ts:50,271`、`auth-lifecycle.test.ts:705` 的 `codes` 表（788 行，`s1d-model-registry` 之后 790）。
- **测试先例**：假可执行文件被真实 spawn（`server/test/fixtures/fake-soffice.mjs`）；真实 FUSE 用例只在 Linux 且 `WORKBUDDY_FUSE_TEST=1` 时运行、缺前提即失败（`server/test/linux/temp-dir-remove-fuse.test.ts:1-20,73,121-160`）；CI `uid-isolation` 跑 `test/linux/uid-isolation.test.ts`（`.github/scripts/ci-uid-isolation.sh:292`）。
- **测试主机**（#1665 起草时 ssh 实测）：rclone v1.60.1（`rclone help backends` 有 `sftp`、`smb`、`local`，无 `nfs`）、fusermount3 3.14；尚无 `omp` 用户与 `workbuddy` 组，`/etc/fuse.conf` 未开 `user_allow_other`。Ubuntu 的 `fuse3` 包把 `fusermount3` 装成 root 持有、setuid、other 可执行——任何本机用户都能用它挂 FUSE；`user_allow_other` 又是全机生效的，于是开了它之后 omp uid 能挂一个 `allow_other` 的 FUSE 让 app 进去（D4、D20，#1665 P10）。
- **demo**：挂载对话框 `resource/workbuddy-live-demo.html:4012-4051`——字段 `挂载名称`（placeholder `例如 数据仓库导出`）、`位置`（`本服务器目录` / `外部服务器`）、`主机与协议`（`SFTP` / `NFS` / `SMB`，提示 `仅允许内网主机，公网地址将被拒绝`）、`目录路径`（placeholder `/srv/data`）、`只读挂载` 开关（缺省开，说明 `禁止写入，防止误改源目录`）、按钮 `取消` / `测试连通并挂载`，没有凭证字段；挂载根行 :3860-3875（`cloud` / `folder` 图标、`只读` 标签、在线点 `在线` / `离线`、`卸载`、副行 `host:path`、离线 `离线，重新连接后可浏览`）；文件页 `＋` 菜单 :3952-3957（`新建文件夹`、`挂载目录`、`新建工作空间`）；`新建文件夹` 提示 `只读挂载与离线挂载不可新建`（:3991）；卸载 :4053-4061（审计标题 `卸载挂载点 <名>`）。
- **前端**：`WorkspaceBrowser`（`web/src/features/files/workspace-browser.tsx`，783 行）、`dialogs.tsx` 561、`tree.tsx` 496；`新建` 菜单在 `columns.tsx:95-101`（`新建文件夹`，可选 `新建工作空间`）。拷入层现有 `dialog`、`alert-dialog`、`dropdown-menu`、`input`、`label`、`radio-group`、`textarea`；`select` 由 #1651、`switch` 由 `s1d-experts-skills` 组 8 / 组 10（#1662 / #1664）中先合入的一组拷入。
- **`deriveWhitelist`**：`docs/architecture/system.md:29` 把它标为「S1b 未来项，未实现」。会话的 omp cwd 已是工作空间根（omp-runtime「子进程 spawn 契约」），挂载点就在根下，沙箱 facade 的 `resolve` 按包含关系判定——不需要另一份白名单；「卸载后白名单收回」= 卸载后挂载点目录被删除。本 change 销掉该项（D19）。

## Goals / Non-Goals

**Goals:**

- 用户在自己的正式工作空间里自助挂载 SFTP / SMB 目录，或接入管理员登记的服务器目录；omp 与文件页按普通目录读写，只读挂载拒绝写入。
- 凭证只存在于 app 私有的 `rclone.conf`（`0600`）：不进 DB、不进响应、不进审计、不上命令行、不进子进程环境，omp uid 读不到。
- 挂载断开有明确状态：离线挂载在界面上不可展开、在 API 上是 409 `mount_offline` 而不是 500，并自动退避重挂。
- `RCLONE_BIN` 未配置时整个功能关闭，空间根目录的一切行为不变。

**Non-Goals:**

- sshfs；由 app 发起的 NFS / CIFS 内核挂载（需要 root）。
- demo 里用户手填路径的「本服务器目录」（任意服务器路径对 omp 可见）——本机与 NFS 目录只经管理员登记的挂载源接入。
- 挂载源的管理界面：管理员只经端点登记与删除（普通用户的对话框读 `GET /api/mount-sources`）——起草者的范围裁剪，不在 owner 裁定表里，待 owner 裁定（Open Questions）。
- 预览源 `/w/`、`/o/` 与会话附件读取挂载内的文件（D21：宿主不同步进入挂载；它们按拒绝处理）。
- 修改既有挂载（改名、换凭证、改只读）：卸载后重新挂载。
- 手动「重新连接」按钮（离线挂载由退避重挂自动恢复）。
- SFTP 主机密钥校验（`known_hosts`）。
- `MOUNT_HOST_ALLOW` 的网段、通配写法。
- 临时空间里的挂载。
- 删除正式工作空间的端点。
- 挂载内删除进回收目录、跨挂载移动的复制回退。
- 参考镜像 `deploy/app/` 的 FUSE 能力（`/dev/fuse` 设备、`SYS_ADMIN`、rclone 包）——归 S4b 部署包。
- macOS 开发机上的挂载（没有 `/dev/fuse`，配置 `RCLONE_BIN` 即启动失败）。
- 在界面展示 rclone 日志；rclone 配置文件加密。

## Decisions

### owner 的裁定（2026-10-21，grill，已定，不是选项）

| 分支 | 结论 | 由谁定 |
|---|---|---|
| 协议 | SFTP 与 SMB 自助：用户自填凭证。NFS 与本机目录是管理员登记的「挂载源」：管理员在 OS 层挂好并登记路径，用户再自助接入，app 用 rclone `local` 后端再挂一次。demo 里用户手填的「本服务器目录」是 Non-Goal | owner |
| 实现 | 只用 rclone，三个后端 `sftp`、`smb`、`local`；可写挂载用 `--vfs-cache-mode writes`；不带 sshfs | owner |
| 凭证 | 存在 `<OMP_STATE_DIR>/mounts/<id>/rclone.conf`，mode `0600`，app 私有（目录 `0700`），经 `rclone obscure` 处理；API 永不回读，DB 永不存凭证，永不上命令行 | owner |
| 删除与移动 | 挂载内删除、跨挂载边界移动一律拒绝：不进 `.trash`，没有复制回退 | owner |
| 占用卸载 | 卸载用惰性卸载（`fusermount3 -uz`）；删除工作空间先卸载它的全部挂载；外部、非 app 的挂载仍按 #1237 停在 `EBUSY` | owner |
| 主机规则 | 配置项 `MOUNT_HOST_ALLOW` 是许可名单，缺省不限；环回一律拒绝 | owner |
| 功能开关 | `RCLONE_BIN` 未设置即功能关闭；设置了则启动预检：可执行、`fusermount3` 在 PATH、`/dev/fuse` 存在；`OMP_USER` 模式另查 `/etc/fuse.conf` 的 `user_allow_other`；预检失败即启动失败 | owner |
| 其它限制 | 只有正式（非临时）空间能挂载；每空间上限为配置项，缺省 8；健康探测间隔 30s；重挂指数退避、封顶 5 分钟；挂载点判据沿用 #1237（`EBUSY` + `/proc/self/mountinfo` 路径）；快照的 `dev` 规则不变 | owner |
| 开放项 | rclone `local` 后端在 uid 分离下的读写与 `EBUSY` 待前置实测 #1665；#1665 的 P1–P8 任一不成立需 owner 重新拍板——落 Open Questions，不进 specs | owner |

### 起草者的技术决定

- **D1 迁移 049**（`server/src/core/db/migrations/049_workspace_mounts.sql`）：
  - `mount_sources(id TEXT PRIMARY KEY CHECK 32 位小写 hex, name TEXT NOT NULL UNIQUE CHECK 1..64 字符且不含 U+0000–U+001F 与 U+007F, path TEXT NOT NULL UNIQUE CHECK (substr(path,1,1) = '/'), read_only INTEGER NOT NULL CHECK (read_only IN (0,1)), created_at INTEGER NOT NULL)`；≤32 行（store 判定）。
  - `workspace_mounts(id TEXT PRIMARY KEY CHECK 32 位小写 hex, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT, owner_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL CHECK 同 workspaces.dir 的字符规则且 <> 'uploads', backend TEXT NOT NULL CHECK (backend IN ('sftp','smb','local')), host TEXT NULL, port INTEGER NULL CHECK (port BETWEEN 1 AND 65535), remote_path TEXT NULL, source_id TEXT NULL REFERENCES mount_sources(id) ON DELETE RESTRICT, read_only INTEGER NOT NULL CHECK (read_only IN (0,1)), created_at INTEGER NOT NULL, UNIQUE(workspace_id, name), CHECK ((backend = 'local' AND source_id IS NOT NULL AND host IS NULL AND port IS NULL AND remote_path IS NULL) OR (backend IN ('sftp','smb') AND source_id IS NULL AND host IS NOT NULL AND remote_path IS NOT NULL)))`。
  - 两张表而不是一张带 `kind` 列：挂载源属于管理员、没有空间与属主，挂载属于某个空间；合成一张就要让 `workspace_id` / `owner_id` 可空并加一串互斥 CHECK，读写两边都得先分 kind。分开后外键直接表达「本地挂载引用一个挂载源」。
  - `name` 同时是挂载点目录名（`<空间根>/<name>`），不另设 `dir` 列：字符规则直接沿用 workspaces `dir` 的 CHECK（ASCII 字母数字、`_`、`-`、CJK，1..64，自然排除 `.`、`..` 与 `/`），demo 的 `数据仓库导出` 合法；`uploads` 保留，使上传（固定写 `uploads/<名>`）永不落进挂载。
  - `workspace_id` 用 `RESTRICT`：空间行被删之前挂载必须先卸载并删行（D15）；今天没有任何路径会触发它。`owner_id` 冗余记下属主（审计与排障直接可读），不带级联动作——账号没有删除路径，带 `CASCADE` 反而与 `workspace_id` 的 `RESTRICT` 在同一次级联里相互抵触。
  - 没有任何凭证列，没有状态列（在线状态只在内存里，D11）。
- **D2 取值规则**（`server/src/workspaces/mounts/validate.ts`）：
  - `POST` body 键集按 `backend` 严格：`sftp` `{name, backend, host, port?, remotePath, readOnly, username, password? | privateKey?}`（`password` 与 `privateKey` 恰有一个）；`smb` `{name, backend, host, port?, remotePath, readOnly, username, password, domain?}`；`local` `{name, backend, sourceId, readOnly}`。
  - `host` 1..253 字节，只含 `[A-Za-z0-9.:-]`，不以 `-` 开头；`port` 整数 1..65535；`remotePath` 以 `/` 开头、≤1024 字节、无 U+0000–U+001F 与 U+007F，`smb` 另要求 `/` 之后至少一段（共享名）；`username` 1..256、`password` 1..1024、`domain` 1..64 `[A-Za-z0-9._-]`，三者无控制字符、无首尾空白（`rclone obscure -` 从标准输入读一行；INI 值不能含换行）；`privateKey` ≤16 KiB、以 `-----BEGIN ` 开头、只含可打印 ASCII 与 `\n`（写进 `key_pem` 时换行转写为字面 `\n`，rclone 的单行写法）。违反 400，message 不含取值。
  - 挂载源 `POST /api/mount-sources` `{name, path, readOnly}`：`path` 为绝对路径、`realpath` 后是存在的目录（存 realpath），且与 `SANDBOX_ROOT`、`OMP_STATE_DIR`、`dirname(DB_PATH)`、`STATIC_ROOT`、`dirname(OMP_BIN)` 五者的 realpath 互不包含（相等、在其内、包含它都拒绝——否则挂载会把 app 私有状态、别人的沙箱、前端静态文件（可写挂载即存储型 XSS）或 omp 二进制暴露给 omp）；服务端的配置只来自环境变量，没有别的配置文件目录要拒；同名或同路径 409 `conflict`；第 33 个 400。
  - 每次挂载尝试（建出与每次重挂）之前对挂载源的 `path` 重新取 realpath，复核「等于登记值、是存在的目录、与上述五者互不包含」；不过 → 该次尝试失败（建出 502 `mount_failed` + `mount.reject`；重挂保持离线），不 spawn。
- **D3 主机规则**（`server/src/workspaces/mounts/host-policy.ts`）：对 `sftp` / `smb` 的每次挂载尝试（建出时与每次重挂）依次判定，全部通过才 spawn：
  1. 规范化：`host` 转小写、去掉末尾的全部 `.`；以下各步与 `MOUNT_HOST_ALLOW` 的比较都用规范化后的串（名单项同样规范化）。
  2. 字面环回：等于 `localhost` 或以 `.localhost` 结尾；或是 IP 字面（IPv4 点分十进制，或任一 IPv6 写法）且地址值属于 `127.0.0.0/8`、`0.0.0.0`、`::1`、`::`，或是 IPv4 映射地址（`::ffff:a.b.c.d`）而其 IPv4 属于前两者——拒绝。`0:0:0:0:0:0:0:1`、`::ffff:127.0.0.1`、`localhost.`、`LOCALHOST.` 都在这一步命中。
  3. `MOUNT_HOST_ALLOW` 配置时，规范化后的 `host` 不等于名单中任一项——拒绝。只比字符串，不比解析结果。
  4. 解析：`dns.lookup(host, {all: true})`；解析失败或结果为空 → 该次尝试失败（建出 502 `mount_failed` + `mount.reject` `reason: "mount_failed"`；重挂保持离线），不 spawn——不再「解析失败不算环回」地放行。任一结果属于第 2 步的地址——拒绝（堵住 `2130706433`、`0x7f.1` 一类数字写法与指向环回的内网域名）。
  5. 把第一个解析结果（IP 字面）经 `--sftp-host <ip>` / `--smb-host <ip>` 交给 rclone（主机不是凭证，可以上命令行），rclone 不再自己解析；`rclone.conf` 的 `host` 仍写用户填的主机，以 argv 为准（#1665 P1′ 证明覆盖生效）。判定的地址就是连接的地址：DNS 重绑定与 app（glibc）/ rclone（Go 解析器）对同一名字的分歧都不再成立。
  - 建出时被拒 → 403 `mount_host_rejected` + `mount.reject`（`reason: "host_rejected"`）；重挂时被拒 → 该挂载保持离线（管理员收紧名单后，已有挂载在下一次重挂时失效）。
- **D4 配置键与启动预检**（`server/src/workspaces/mounts/config.ts` 的 `resolveMountSettings(env)`，由 `resolveServerConfig` 展开；应用配置 37 → 40 项）：
  - `RCLONE_BIN`：缺省未配置 = 挂载关闭；给出时为绝对路径，显式 empty 或相对路径为配置错误。
  - `MOUNT_HOST_ALLOW`：缺省未配置 = 不限；给出时为逗号分隔的主机名单，每项 1..253 字节、只含 `[A-Za-z0-9.:-]`；显式 empty、空项、非法字符为配置错误。
  - `MOUNT_MAX_PER_WORKSPACE`：与 `OMP_IDLE_MS` 同一解析纪律（canonical ASCII decimal 1..2147483647），缺省 `8`。
  - 预检在配置阶段、只在配置了 `RCLONE_BIN` 时运行（先例 `BROWSER_BIN`、`OMP_USER`，失败同为 `reason: "config"`，不新增启动阶段）：`RCLONE_BIN` 是可执行普通文件（`X_OK`）；在进程 `PATH` 上找到可执行的 `fusermount3` 并记下其绝对路径（此后只用该路径）；`/dev/fuse` 存在（且为字符设备）；`OMP_USER` 配置时 `/etc/fuse.conf` 有一行去掉首尾空白后恰为 `user_allow_other`，并经固定绝对路径 `/usr/bin/id -u -- <OMP_USER>` 取得 omp 的数值 uid（Node 没有 getpwnam；与 `/usr/bin/setpriv` 同样不走 PATH）。任一不过 → 抛出点名该键的配置错误。
  - `OMP_USER` 配置时另查 FUSE 挂载程序的执行权（D20 的部署要求）：进程 `PATH` 各项下找到的每一个 `fusermount3` 与 `fusermount`，其 mode 没有 other 执行位，且其属组不是 omp 用户的任何一个组（`/usr/bin/id -G -- <OMP_USER>` 的输出）；不过 → 点名 `RCLONE_BIN` 的配置错误，message 写明「fusermount3 只能对 app 所在、omp 不在的组可执行」。理由：`user_allow_other` 全机生效，omp uid 若能执行 setuid 的 `fusermount3`，就能在自己可写的空间根下挂一个 `allow_other` 的 FUSE、再让它不应答——app 的任何一次进入都会挂住，omp 还能向 app 伪造文件内容（#1665 P10）。同 uid 部署（`OMP_USER` 缺席）不查：那时 omp 就是 app uid。
  - 不检查 rclone 版本（部署说明写最低版本 = 测试主机实测版本）。
- **D5 app 私有目录布局**：托管布局加 `<state>/mounts`（`0700`，`ompMountsDir(stateDir)`，由 `ensureOmpStateLayout` 建出与校正）。每个挂载 `<state>/mounts/<id>/`（`0700`，`ensureOwnedDir`）内：`rclone.conf`（`0600`）、`cache/`（`0700`，`--cache-dir`，VFS 写缓存里是用户数据，不能落到 app uid 的 `~/.cache/rclone`）、`rclone.log`（`0600`，`--log-file`，`--log-level NOTICE`，供管理员排障；每次挂载尝试之前由 app 以 sandbox-core「托管文件权限位」的语义确保它存在且为 `0600`，rclone 只追加、不改模式——#1665 P14）。整个目录在卸载时递归删除（`fs/promises` 的 `rm`）。
- **D6 凭证文件**（`server/src/workspaces/mounts/rclone-conf.ts`）：一个 INI 段，段名为 `m<挂载 id>`（下称 `<段名>`；它也是 mountinfo 来源字段的开头，用来认出这个挂载出现在哪里，D9）：
  - `sftp`：`type = sftp`、`host`、`port`（给了才写）、`user`、`pass = <obscure 串>` 或 `key_pem = <单行 PEM>`。
  - `smb`：`type = smb`、`host`、`port`（给了才写）、`user`、`pass = <obscure 串>`、`domain`（给了才写）。
  - `local`：`type = local`（路径走 remote 参数）。
  - 口令经 `RCLONE_BIN obscure -` 处理：口令从标准输入写入，obscure 串从标准输出读回，10 s 期限；子进程环境同 D7。先写同目录临时名再 `rename`，最终 mode `0600`。
  - 凭证只在 `POST` 的这一个请求里经手：写完即丢，不进日志、审计、错误 message、响应。
- **D7 rclone 子进程**（`server/src/workspaces/mounts/manager.ts`）：
  - argv：`<RCLONE_BIN> mount <段名>:<远端> <挂载点> --config <conf> --cache-dir <cache> --log-file <log> --log-level NOTICE --allow-non-empty`；`sftp` 再加 `--sftp-host <ip>`、`smb` 再加 `--smb-host <ip>`（D3 第 5 步）；可写加 `--vfs-cache-mode writes`，只读加 `--read-only`；`OMP_USER` 模式加 `--allow-other --default-permissions --uid <omp uid> --gid <空间根目录的 gid> --umask 007`。整串由 #1665 P1′ 实测；spec 钉 argv 是因为假 rclone 要据它断言。
  - `<远端>`：`sftp` 为 `remotePath`；`smb` 为 `remotePath` 去掉开头的 `/`（`share/dir`）；`local` 为挂载源的 `path`。
  - 环境恰为 `{PATH: <进程 PATH>, HOME: <state>/mounts/<id>}`：不继承 app 环境（`MODEL_UPSTREAM_API_KEY` 等不进 rclone），也挡住 `RCLONE_*` 环境变量改写配置；`HOME` 指向私有目录，rclone 不会去碰 app uid 的家目录。
  - `--default-permissions`：`--allow-other` 下不加它，内核不按 mode 检查访问，机器上任何用户都能进挂载；加了之后 `--umask 007` 与共享组才是边界。`--uid <omp>`：omp 是属主，`chmod` 一类属主操作不被内核拒绝（rclone 自己忽略它）；app uid 经共享组的 `rw` 访问。`--gid` 取空间根目录的 gid（setgid 继承来的共享组），不另配置。
  - `--allow-non-empty`：离线期间挂载点是空目录，omp 可能往里写；不加它 rclone 拒绝挂到非空目录，挂载就永远回不来、而挂载内删除又被拒绝。加了之后残留被挂载遮住，卸载后显形为普通目录（D10），数据不丢。
  - 前台运行、app 持有子进程；它的意外退出即崩溃（D11）；卸载自己结束它时不算，不触发重挂。
- **D8 挂载点**：`<空间根>/<name>`，只在空间根下一层；每次挂载尝试之前以 `ensureSharedDir` 确保存在（离线期间可能被 omp 删掉；快照还原不碰已登记的挂载名，D21），随后 `lstat`（不跟随）挂载点：必须是目录、不是符号链接、属 app uid——`ensureSharedDir` 对已存在的分量用跟随符号链接的 `statSync`，这一步不能省。不过 → 该次尝试失败（建出 502 `mount_failed` + `mount.reject`；重挂保持离线），不 spawn。挂载点里有离线期间的残留条目不算不过（`--allow-non-empty`，D7）。检查与 `fusermount3` 之间仍有窗口（空间根 `2770` 无粘滞位，omp 可改名其下条目）：残余见 Risks，#1665 P15。建出时 `<空间根>/<name>` 已有任何条目 → 409 `conflict`。
- **D9 挂载就绪与判据**：「已挂载」= `/proc/self/mountinfo` 里有一行的挂载点字段（第 5 字段，按 `\040` 等八进制转义还原）逐字节等于挂载点的绝对路径——与 #1237 的 mountinfo 判据同一实现（读 mountinfo 的函数可注入路径，测试指向假文件）。建出时 spawn 之后每 100 ms 查一次，至多 20 s：先看到挂载 → 成功；子进程先退出或超时 → 杀掉子进程、惰性卸载该挂载、删除挂载点（空时）与私有目录 → 502 `mount_failed` + `mount.reject`（`reason: "mount_failed"`），不留行。
  - 「惰性卸载该挂载」（这里、D10、D11、D12 同一函数）：对挂载点（在 mountinfo 里时）与 mountinfo 中文件系统类型为 `fuse.rclone`、来源字段（`-` 分隔符之后的第二个字段——分隔符之前的可选字段个数不定——八进制转义还原后）以 `<段名>:` 开头的每一行的挂载点，各执行 `fusermount3 -uz`——挂载点在检查之后被换掉时，挂载可能落在别处，按来源扫描才收得回来。来源字段的确切形状由 #1665 P1′ 记录。
- **D10 卸载**（`detach`）：依次 `fusermount3 -uz <挂载点>`（不在 mountinfo 里则跳过）；对子进程 SIGTERM，5 s 未退出 SIGKILL；`rmdir` 挂载点（非空 = 离线期间的本地残留，留作普通目录，经错误通道报告一次）；`rm` 私有目录。卸载步骤的文件系统失败只报告、不阻止删行——行一删，manager 不再管它。惰性卸载使占用中的进程（omp 的 cwd 或打开的 fd 在挂载内）不阻塞卸载。
  - 功能关闭（`RCLONE_BIN` 未配置）时没有预检记下的 `fusermount3`：卸载需要惰性卸载（上一行的扫描找到该挂载——上次运行被 SIGKILL 之后撤了 `RCLONE_BIN`，孤儿 rclone 还挂着）时，在进程 `PATH` 上找第一个可执行的 `fusermount3`；找不到 → 503 `mount_disabled`，行与私有目录保留（删行会让一个活挂载失去一切路径规则）。扫描没找到则不需要它，照常删行。
- **D11 在线状态**：每个已登记挂载在内存里是 `online` 或 `offline`。
  - 探测每 30 s 一轮，只对 `online` 的挂载：子进程存活 ∧ D9 判据成立 ∧ 以子进程（`process.execPath` 跑一行 `fs.statSync(<挂载点>)`）在 5 s 内成功——FUSE 上的阻塞会占住 libuv 线程池，所以 `stat` 不在服务进程里做；超时即 SIGKILL 该子进程（FUSE 等待可被 SIGKILL 打断）。每个挂载至多一个在途探测。
  - 子进程 `exit` 事件立即判定离线，不等下一轮。
  - 判定离线 → 惰性卸载（使卡住的系统调用以 `ENOTCONN` 返回）、确保子进程退出 → 安排重挂：首次 5 s，此后每次翻倍，封顶 300 s；重挂成功即回 `online` 并把退避复位到 5 s。重挂经 D3 与 D8。
  - 请求路径上的最坏情况（D21，替换原先「≤ 30 s + 5 s」）：服务进程不对挂载做同步文件系统调用，挂载内的调用经异步适配器，每次至多 10 s；远端断网而 rclone 未退出时，挂载内的一个请求至多等 10 s 得 409 `mount_offline`。适配器超期是与探测相互独立的第二个离线触发，不取代探测。其它空间与本空间根不受影响，代价只是 libuv 线程池：每个挂起的挂载至多占一个线程、至多 10 s（SIGKILL rclone 与 `-uz` 使卡住的 FUSE 请求返回，#1665 P9）。这与 `IMPLEMENTATION_PLAN.md:509`「故障不阻塞空间根目录使用」的关系待 owner 确认（Open Questions）。
- **D12 服务启停**：
  - 构造：manager 在 `createApp` 里构造——它要 DB 与审计，而 `appAssemblyOf` 只有配置；挂载设置经 `AssemblyDependencies.mounts` 递交，不带 assembly 的 `createApp` 得到一个功能关闭的 manager（与 `trash` 的就地构造同一写法，`app.ts:262-267`）。构造时同步读出全部挂载行装进内存登记、一律 `offline`；`RCLONE_BIN` 未配置时同样装（`GET`、卸载、根层跳过与文件端点的 409 都靠它）。manager 交给 `registerWorkspaces`、沙箱 facade 的 `mountNamesOf`、快照、会话附件、撤回与文件变更归属（D21）。
  - 启动：`server_started` 写出之后入口不等待地调用 `restoreAll()`（与 `trash.sweep` 同一写法；成功记录之前所有挂载都是 `offline`）。逐个：挂载点已在 mountinfo 里（上次运行被 SIGKILL 留下的孤儿 rclone 仍挂着）→ 先 `fusermount3 -uz`；再按 D7 挂载。失败只使该挂载离线并进入退避，不产生 failure record、不改变退出码。恢复按 `created_at, id` 逐个依次进行，前一个的尝试结束之后才开始下一个（关停只需等一个在途尝试）。`RCLONE_BIN` 未配置时不恢复，全部离线。
  - 关停：manager 的 `closeAll()` 挂在 app 的关闭钩子上——共享 shutdown「先完成 runtime 原生退出及 store 回收，再停止主 listener，最后关闭 DB」的次序里，它在停止主 listener 时运行、先于关 DB；设关停标志、停掉探测与退避定时器、SIGKILL 每个在途的挂载尝试子进程并作废其结果（D13），等各空间的链走完，再对每个挂载做 D10 的前两步（惰性卸载、SIGTERM → 5 s → SIGKILL），不删私有目录与行。关停标志之后 `restoreAll` 不再发起新的尝试，因此关停与启动恢复重叠时不留孤儿。
- **D13 挂载端点**（`server/src/workspaces/mounts/rest.ts`，由 `registerWorkspaces` 注册——挂载是 workspaces 模块的子模块，启动记录的模块数不变）：
  - `GET /api/workspaces/:id/mounts` → 200 `{enabled, mounts: MountView[]}`，按 `created_at, id` 升序；`MountView = {id, name, backend, host, port, remotePath, sourceId, sourceName, readOnly, status: "online"|"offline", createdAt}`（`sftp` / `smb` 的 `sourceId` / `sourceName` 为 null，`local` 的 `host` / `port` / `remotePath` 为 null）。没有用户名、口令、私钥、域。临时空间同样可读（总是空表）。
  - `POST /api/workspaces/:id/mounts` → 201 `MountView`（`status: "online"`）。次序：401 → 空间不属本人或不存在 404（preParsing）→ 挂载未启用 503 `mount_disabled`（preParsing）→ content-parser 400 → body 形状 400 → 临时空间 400 → 已达 `MOUNT_MAX_PER_WORKSPACE` 409 `mount_limit` → `local` 的 `sourceId` 未登记 404、挂载源只读而 `readOnly: false` 400 → 同名挂载或空间根下已有同名条目 409 `conflict` → 主机规则 403 `mount_host_rejected` → 写私有目录与 `rclone.conf`、建挂载点、spawn、等就绪（D9）→ 事务内插行 + `mount.attach` 审计 → 201。插行或审计失败 → `detach` 后 generic 500。body limit 64 KiB。
  - `DELETE /api/workspaces/:id/mounts/:mountId` → 204（D10 + 删行 + `mount.detach` 审计）；未知或属他人 404。挂载未启用时同样可用（没有进程要停，只删私有目录与行）。
  - 串行：一个挂载的每一次操作——建出、重挂尝试、启动恢复尝试、卸载、挂载源删除的连带卸载——都在该空间的 promise 链上执行，上限与同名判定因此无竞态。卸载与 `closeAll` 在入链之前同步地取消该挂载的定时器与在途探测，SIGKILL 它在途的挂载尝试子进程并作废那次尝试（以失败收场、不回 `online`；其挂载若已出现则按 D9 惰性卸载）——卸载因此不等满 20 s 的就绪窗口，随后在链上执行 D10。
  - 审计：`mount.attach`（title `挂载目录 <name>`，detail `{mountId, name, backend, host, port, remotePath, sourceId, readOnly}`）、`mount.detach`（title `卸载挂载点 <name>`，detail `{mountId, name, reason}`，`reason` 为 `user` 或 `source_deleted`）、`mount.reject`（title `挂载被拒绝：<name>`，detail `{name, backend, host, port, remotePath, sourceId, reason}`，`reason` 为 `host_rejected` 或 `mount_failed`；`workspaceId` 为请求的空间）。detail 永不含凭证。
- **D14 挂载源端点**（同一 rest 模块）：`GET /api/mount-sources` → 200 `{sources}`，按 `name` 字节序；管理员视图 `{id, name, path, readOnly, createdAt}`，普通用户 `{id, name, readOnly}`。`POST /api/mount-sources`（管理员）→ 201 管理员视图；`DELETE /api/mount-sources/:id`（管理员）→ 204：(1) 在内存里把该源标为「删除中」——此后引用它的建出请求在 `sourceId` 判定处 404；(2) 对此刻引用它的每个挂载，在各自空间的链上做 D10 并删行、各写一条 `mount.detach`（`reason: "source_deleted"`，actor 为该管理员、`workspaceId` 为该挂载的空间）；(3) 一个事务内删源行并写 `mount.source.delete`。建出 `local` 挂载在插行的事务里复核该源仍存在且未标删除，不成立 → 先卸载刚挂上的挂载、不插行，404 `not_found`。于是标记之前插入的行都被 (2) 列到，标记之后没有新行能引用它，源行的 `RESTRICT` 不会在级联半途变成 generic 500。挂载源三个端点在功能关闭时照常可用（登记只是数据，连带卸载按 D10 的功能关闭规则）。非管理员的写 403 `forbidden`，先于 body 与 id。选连带卸载而不是 409：管理员没有任何界面能看到或卸载别人的挂载，409 会让下线一个 NFS 源变成挨个找人。审计 `mount.source.create` / `mount.source.delete`，detail `{sourceId, name, path, readOnly}`。body limit 16 KiB。
- **D15 删除空间先卸载与临时空间**：
  - 临时空间拒绝挂载（D13 的 400）；转正是单向的，于是临时空间永远没有 app 挂载。
  - owner 裁定「删除工作空间先卸载它的全部挂载」今天没有 HTTP 路径能触发：没有删除正式空间的端点，唯一的空间删除路径（会话删除连带临时空间）遇不到 app 挂载。落成 manager 的不变量：`detachWorkspace(workspaceId)` 卸载并删除该空间的全部挂载行，`workspace_mounts.workspace_id` 的 `RESTRICT` 使任何先删空间行的未来路径在 DB 层失败。会话删除与 temporary-workspaces「临时空间目录的删除」不改（其中的 #1237 规则继续管外部挂载）。
- **D16 挂载目录内的文件端点**：成员判定只有一条词法规则（D21），与 sandbox-core `resolve` 的规范化是同一个函数（`core/sandbox` 导出）：路径（`path`，或 move 的 `from` / `to`）按 `/` 分割、去掉空段与 `.` 段（`..` 已被 resolve 拒绝）之后的第一段逐字节等于该空间某个登记挂载的 `name`，即「在该挂载内」（其后没有段即挂载根本身）；`./远端/a.md`、`远端//a.md` 与 `远端/a.md` 同属 `远端`。判定只读内存登记，不碰文件系统；位置在 `sandbox.resolve` 之后（越界仍是 403 + 审计）、一切存在性检查与文件系统读写之前：
  - 离线：tree、file、download、archive、dirs、move（任一侧）→ 409 `mount_offline`。
  - 只读：dirs、move（两侧在同一只读挂载内）→ 403 `mount_read_only`。
  - 边界：entries DELETE 的目标在任一挂载内（含挂载根）→ 409 `mount_boundary`；move 恰一侧在挂载内、两侧在不同挂载内、或 `from` 是挂载根 → 409 `mount_boundary`。同一挂载内的改名与移动照常一次 `rename`。
  - 判定次序：边界先于离线与只读（删除与跨界无论状态都不可能成功）。
  - 支持的挂载内操作恰为：tree、file（含 Range）、download、archive、dirs、同一挂载内的 move（改名与移动）；在线挂载上它们的每一次文件系统调用（`lstat`、`readdir`、`open`、`read`、`close`、`mkdir`、`rename`）经异步适配器（D21）。删除与跨界移动按上面拒绝；上传固定写 `uploads/<名>`，永不在挂载内；其它入口见 D21 的表。
- **D17 错误码**（十八 → 二十五）：

  | code | 状态 | message |
  |---|---|---|
  | `mount_disabled` | 503 | `服务器未启用远程挂载` |
  | `mount_failed` | 502 | `挂载失败，请检查主机、路径与凭证` |
  | `mount_offline` | 409 | `挂载已离线，重新连接后可用` |
  | `mount_limit` | 409 | `该工作空间的挂载数已达上限` |
  | `mount_host_rejected` | 403 | `该主机不允许挂载` |
  | `mount_read_only` | 403 | `只读挂载不能写入` |
  | `mount_boundary` | 409 | `挂载目录内不能删除，也不能跨挂载移动` |

  不给 rclone 的错误原文：rclone 日志里可能有主机与用户名，只进 app 私有的 `rclone.log`。
- **D18 前端**：
  - 新 `web/src/lib/api-mounts.ts`（严格解析 `MountView` 与 `SourceView`；`SourceView` 的每项恰为两种键集之一——管理员五键或普通用户三键——同一响应内不混用，否则解析失败）。
  - 新 `web/src/features/files/mount-roots.tsx`（挂载根行与卸载确认）与 `mount-dialog.tsx`（对话框）；`workspace-browser.tsx` 只加接线（783 行，size-guard 800）。
  - 根行的数据来源是 `GET …/mounts`，不是 `tree`：空间根的 `tree` 按名字跳过已登记挂载的挂载点、不列出它们（D21），浏览器不做过滤，只在空间根之后渲染挂载根行；挂载点目录缺失时挂载根行照样出现。工作空间对象不变（files-web 钉「恰五键」）。
  - demo 的提示 `仅允许内网主机，公网地址将被拒绝` 不沿用：主机规则只拒环回、按许可名单放行，不判定公网地址，沿用即是假承诺。
  - `挂载目录` 只在文件页的 `新建` 菜单（与 `新建工作空间` 同为文件页专用的可选项）且 `enabled` 为 true 时出现；侧边栏有挂载根行与卸载，没有挂载入口（workspace-sidebar 不提供空间级入口）。
  - 状态在进入空间、`刷新`、挂载与卸载之后重取，不轮询、不推送。
- **D19 白名单推导销项**：`system.md:29` 删去 `deriveWhitelist` 与「多根挂载点合并、白名单推导……为 S1b 未来项」；:35、:109 的「rclone/sshfs」改为 rclone；:173「sandbox 白名单更新」改为「挂载点在空间根下，沙箱 resolve 按包含关系覆盖」。
- **D20 文档**：ADR-0003「2026-10 补充」的产品化一节（rclone 三后端、凭证文件、惰性卸载、主机规则、功能开关；证据引 #1665 的 P1–P8 节）；ADR-0010 补充（`<state>/mounts`、挂载选项 `--allow-other --default-permissions --uid <omp> --gid <共享组> --umask 007`、`fuse.conf`）；`system.md` §9.9「远程挂载」（依赖包 `fuse3` 与 rclone、`user_allow_other`、容器需 `/dev/fuse` 与 `SYS_ADMIN`、`rclone.log` 位置、回滚即撤 `RCLONE_BIN`）；`IMPLEMENTATION_PLAN.md:199` 的「rclone/sshfs」改为 rclone 并指向本 change；`IMPLEMENTATION_PLAN.md:509` 的回滚句改为「`RCLONE_BIN` 未配置即关闭；配置了而预检不过即启动失败（owner 裁定 fail-closed）」；`system.md` §9.9 写 `fusermount3` 的部署要求（只对 app 所在、omp 不在的组可执行，例如 `dpkg-statoverride --update --add root <app 组> 4750 /usr/bin/fusermount3`；该组不得是 `workbuddy`，omp 是它的成员，ADR-0010）与同一条进 ADR-0010 补充；`system.md:31` 的错误码计数改为二十五。

- **D21 宿主不同步进入挂载**（2026-10-22 Stage 4 新增；替换 D11 原先「请求可阻塞约 35 s」的上界与 D16 原先「preview-origin 不加判定」）：服务进程 SHALL NOT 对已登记挂载的挂载点或其下任何路径做同步文件系统调用——远端断网而 rclone 存活时，主线程上的一次 `lstatSync` 会一直挂在 FUSE 请求上，探测与超时定时器都在同一个事件循环里，无从自救，整个服务对所有人停摆。
  - 成员判定只有一条词法规则：规范化路径（按 `/` 分割、去掉空段与 `.` 段、`..` 已被拒）的第一段等于该空间某个登记挂载的 `name`。`core/sandbox` 导出这个函数，`resolve` 与 D16 的判定都用它。
  - `core/sandbox` 的 `resolve` 增一个可选输入：该根的已登记挂载名集合。规范化后第一段是挂载名时，不 `lstat` 该段及其下任何分量，其余规则（NUL、绝对路径、`..`、末段、边界）照旧，返回 `{ok:true, absPath, mount:<name>}`。rclone 挂载内不出现符号链接：`local` 不加 `--links` 时跳过源里的链接、`sftp` 由服务端跟随（#1665 P13），不 `lstat` 不会放过一个链接。facade 增可选端口 `mountNamesOf(workspaceId)`（缺省空集），返回值仍是绝对路径；改 sandbox-core 两条 requirement。
  - 只有 `online` 的挂载会走到文件系统：`online` 期间挂载点就是 FUSE 挂载（被挂载的目录不能被改名或删除）；离线由 D16 的 409 挡在文件系统之前；离线之后的下一次尝试由 D8 的检查把关。
  - 异步适配器 `server/src/workspaces/mounts/fs.ts`：只用 `fs/promises`；每挂载一个 FIFO 闸门、并发 1；每次调用从拿到闸门起 10 s 期限（测试可注入）。超期 → 该请求以 409 `mount_offline` 结束，manager 立即判该挂载离线：SIGKILL 其 rclone、按 D9 惰性卸载（中止卡住的 FUSE 请求、放回 libuv 线程，#1665 P9），排队中的调用都以 409 `mount_offline` 结束，然后照常退避重挂。不用 worker 线程。
  - 其它入口（`server/src` 里对工作空间路径做 resolve、readdir 或其它文件系统调用的全部调用方，见 Context）对挂载内路径的处置，全部词法、不碰文件系统：

    | 调用方 | 挂载内路径 |
    |---|---|
    | tree / file / download / archive / dirs / move（`rest.ts`、`rest-entries.ts`、`rest-archive.ts`） | D16 的拒绝；否则经适配器 |
    | 空间根一层的 `tree`（`tree.ts:30`） | 按名字跳过已登记挂载，不 `lstat`、不列出 |
    | `DELETE …/entries` 与回收目录（`trash.ts`） | 409 `mount_boundary`；挂载只在根下一层、根不能删，回收目录遇不到挂载 |
    | 上传 | 永不在挂载内（`uploads` 保留） |
    | 预览源 `/w/`、`/o/`（`preview/app.ts:213`） | 404（与「不是普通文件」同一应答） |
    | 会话附件（`prompt-attachments.ts:137`） | 400 `bad_request` |
    | 撤回时附件是否仍在（`undo.ts:270`） | 视为不在 |
    | 文件变更归属（`file-changes-ownership.ts`） | 词法上在挂载内的候选不归属（丢弃） |
    | 快照 `take`（`snapshots.ts`） | 根一层的已登记挂载名按名字跳过、不 `lstat`，记入 `skipped`（`reason: "mount"`）；未登记的外部挂载仍按 `dev` 规则 |
    | 还原（`snapshots-restore.ts`） | 根一层的已登记挂载名不读取、不进入、不删除，记入返回的 `skipped`（`reason: "mount"`） |

  - 快照两个窗口（rclone 崩溃到惰性卸载之间的 `ENOTCONN`、遍历中重挂改变挂载点的 `dev` / `ino`）因此不再存在：已登记挂载从不被遍历。
  - 功能关闭时登记照样在内存里（D12），上表照样生效。

### 通用纪律

- 测试先行；每组第一个任务核对本节「Context」的行号与事实，出入先改 design 再继续。
- 凭证（口令、私钥、obscure 串）不进响应、审计、日志、stderr、错误 message、argv、子进程环境；夹具一律用哨兵值并断言其缺席。
- 产品代码单文件 ≤800 行；`server.ts` 只加配置展开、`appAssemblyOf` 递交挂载设置与 `restoreAll` 一行，超过 795 行即把这些接线并进 `startup-registry.ts`（`s1d-model-registry` 抽出）；`auth-lifecycle.test.ts` 只补七条 `codes` 条目（→797），新断言进新文件。
- 不新增 `.css`；规格 delta 只改列出的 requirement；以兄弟 change 的 delta 为底的块在其 MODIFIED 文本上再改。
- 测试主机地址、用户名、密钥不进任何被跟踪文件；真实挂载层的远端参数只经测试主机的环境变量传入。

## #1665 补充探针

#1665 的 P1–P8 不覆盖本 design 依赖的下列 rclone / FUSE 事实；它们与 P1–P8 一同在测试主机的一次性容器里实测，结论写进 ADR-0003「2026-10 补充」的同一节（#1665 的 issue 正文由编排者补列这些探针）。组 5、6、12 在 P1–P8 与下列探针都有结论、且无一需要 owner 重新拍板之后开工（tasks 5.1）。

| 探针 | 做什么 | 定下什么 |
|---|---|---|
| P1′ | 以 D7 的完整 argv（含 `--default-permissions --allow-non-empty --gid <空间根 gid> --cache-dir --log-file`、段名 `m<id>`、`--sftp-host <ip>` / `--smb-host <ip>`）挂 `sftp`、`smb`、`local`，omp uid 创建 / 读 / 写 / 改名 / 删除，app uid 列举 / 读取；读 mountinfo 该行 | argv 可用；`--*-host` 覆盖配置里的 `host`；来源字段以 `m<id>:` 开头（D9） |
| P2′ | `rclone obscure -` 从标准输入读口令；同时观测其 `/proc/<pid>/cmdline` 与 `environ` | D6 的口令路径 |
| P4′ | rclone 存活而远端网络黑洞（丢包，不是 RST）：对挂载根与一个子目录计时 `stat` 与 `readdir` | D11 的探测能否判出离线 |
| P9 | P4′ 状态下一个 `stat` / `readdir` 在途时 SIGKILL rclone 并 `fusermount3 -uz`，计时在途调用返回 | D21 期限到后线程被放回 |
| P10 | 按 D20 的部署限制改 `fusermount3` 的组与模式之后，omp uid 执行它 | 应得 `EACCES`（D4） |
| P11 | 错误凭证（口令错、私钥错、共享名错）挂载：rclone 是否在挂载出现在 mountinfo 之前以非 0 退出 | 「首次挂载即连通测试」（D9） |
| P12 | `key_pem` 写成换行转写为字面 `\n` 的单行 | D6 的私钥写法 |
| P13 | `local` 源内放指向源外的文件与目录符号链接，经挂载列举与读取 | 挂载内不出现符号链接、读不到源外（D21） |
| P14 | 预先建好 `0600` 的 `rclone.log` 后挂载、写日志 | 模式保持 `0600`（D5） |
| P15 | 把挂载点换成指向别处目录的符号链接后调用 `fusermount3`；循环替换测竞态 | `fusermount3` 是否拒绝、剩余窗口（D8） |

## Risks / Trade-offs

- **[`--allow-other` 让别的本机用户也能进挂载]** → `--default-permissions` + `--umask 007` + 共享组；#1665 P1′。
- **[`user_allow_other` 让 omp uid 自己挂 `allow_other` 的 FUSE、令 app 挂住]** → 部署要求 `fusermount3` / `fusermount` 只对 app 所在、omp 不在的组可执行，`OMP_USER` 模式预检把关（D4、D20）；PATH 之外的 setuid 副本预检看不到，部署说明要求删除；#1665 P10。
- **[挂载点在检查与 `fusermount3` 之间被换成符号链接]** → 每次尝试前 `lstat` 挂载点（D8），失败清理按来源扫描 mountinfo（D9）；`fusermount3` 自己对最后一个分量的处理与剩余窗口待 #1665 P15。omp 删掉离线挂载点、自建同名目录（属 omp uid）会让该挂载一直离线——只伤它自己会话所在空间的挂载，登记为残余。
- **[app 被 SIGKILL 后 rclone 成为孤儿，挂载留在原处]** → 启动恢复时先惰性卸载残留挂载（D12）；孤儿 rclone 随卸载退出。
- **[FUSE 上的阻塞]** → 宿主不对挂载做同步调用、挂载内调用经 10 s 期限的异步适配器（D21）；残余：挂载内的一个请求至多等 10 s，每个挂起的挂载至多占一个 libuv 线程 10 s；`file-changes-ownership.ts` 的 `realpathSync` 会跟随 omp 在根下放的、指向挂载内的符号链接（词法判定看不见它）——挂载挂起时这次调用仍可能卡住主线程，登记为已知残余（omp 只能让它自己用户的挂载挂起之后才触发）。
- **[离线期间 omp 写进挂载点的本地文件]** → `--allow-non-empty` 使重挂不被它挡住，残留被遮住；卸载后挂载点以普通目录保留，不删除（D7、D10）。
- **[DNS 重绑定、解析器分歧]** → 每次尝试由 app 解析并判定，把判定过的 IP 字面交给 rclone（D3 第 5 步，#1665 P1′）。
- **[rclone 拉平权限位]** `local` 挂载里一切显示为 omp 持有的 `0660` / `0770`，app uid 能读写的东西 omp 经挂载都能读写 → 挂载源拒绝清单五项与每次尝试复核（D2）；管理员登记的就是要交给用户的目录。
- **[SFTP 不校验主机密钥]** 内网中间人 → 已接受，Non-Goal。
- **[`rclone obscure` 不是加密]** → 保护来自 `0600` / `0700` 与 uid 分离；obscure 只防眼看与误贴。同 uid 部署（`OMP_USER` 缺席）下 omp 能读 `<state>/mounts`，与该模式下其它 app 私有状态一样。
- **[VFS 写缓存未上传时 rclone 崩溃]** → 缓存目录按挂载 id 固定（`<state>/mounts/<id>/cache`），重挂时 rclone 续传；卸载会删除缓存，尚未上传的写入随之丢失——卸载确认框写明「只断开挂载」不代表已同步完成，登记为残余。
- **[挂载内文件的快照与撤回]** → 已登记挂载名在快照与还原中按名字跳过（D21），外部挂载仍按 `dev` 规则；挂载内的改动不可撤回。
- **[行数]** `server.ts`、`auth-lifecycle.test.ts`、`workspace-browser.tsx` 都贴着 800 → 见「通用纪律」与「行数预算」。

## Migration Plan

1. 组 1（迁移 049 与 store）在 `s1d-connectors` 的迁移 048 之后合。
2. 组 2–4（配置与预检、托管布局、错误码）互不依赖，可并行。
3. 组 5–6（mount-manager）在 #1665 的 ADR-0003 补充合入、记下 P1–P8 与「#1665 补充探针」的结论且都无「需 owner 重新拍板」之后开工。
4. 组 7（端点）、组 8（挂载感知的 resolve 与根层跳过）、组 9（文件端点与异步适配器），组 10–11（前端），组 12（真实挂载验证层，测试主机手工跑）。
5. 回滚：撤掉 `RCLONE_BIN` 即关闭功能——启动不恢复挂载，已登记的挂载显示离线、仍可卸载；回退代码时先在旧版本下卸载全部挂载（或停服务后对每个挂载点 `fusermount3 -uz`），`<state>/mounts` 可整体删除（写进 system.md §9.9）。

## Not yet specified

- 挂载在线状态的实时推送（会话页侧边栏与文件页都要靠 `刷新` 才看到状态变化；是否并进列表事件连接、事件形状，尚说不清）。
- 管理员视角的全局挂载视图与代为卸载。

## Open Questions

- **#1665 前置实测**（S1b 实现组 5、6、12 的开工条件）：rclone `local` 后端在 uid 分离下的读写与占用卸载（`EBUSY` / `-uz`）表现待 P1、P5、P6 的 `local` 一栏；P1–P8 与下节补充探针任一不成立，按 owner 裁定需 owner 重新拍板，本 change 相应组暂停。
- **完整 argv 跨 uid 读写**（P1′）：`--default-permissions`、`--allow-non-empty`、`--gid <空间根 gid>`、`--cache-dir`、`--log-file`、`--sftp-host` / `--smb-host` 覆盖配置里的 `host`、段名 `m<id>` 在 mountinfo 来源字段里的形状；不成立则改 D7 / D9 与 workspace-mounts「挂载进程与挂载点」的 argv 一句，不改其它 requirement 与任务切分。
- **`rclone obscure -` 从标准输入读口令**（P2′）。
- **断网而 rclone 存活时的离线判定**（P4′）：对挂载根的 `stat` 可能由 VFS 内存直接应答、永远判不出离线；若如此，D11 的探测改为子进程里对挂载根 `readdir`（改「在线状态与重挂」一句），适配器的 10 s 期限仍是请求路径的兜底。
- **SIGKILL rclone 加 `fusermount3 -uz` 中止在途的 `stat` / `readdir`**（P9）：D21 释放 libuv 线程的前提。
- **omp uid 执行 `fusermount3` 得 `EACCES`**（P10）：D4 / D20 部署限制生效的证据。
- **错误凭证时 rclone 在挂载出现在 mountinfo 之前以非 0 退出**（P11）：「首次挂载即连通测试」的前提；不成立则 D9 的就绪判据加一次对挂载根的子进程 `readdir`。
- **`key_pem` 单行 `\n` 写法被 sftp 后端接受**（P12）。
- **`local` 后端不经符号链接读到源外**（P13）：D21「挂载内没有符号链接」的前提。
- **rclone 追加已存在的 `rclone.log` 时不改其 `0600`**（P14）。
- **`fusermount3` 拒绝最后一个分量是符号链接的挂载点、竞态窗口有多大**（P15）。
- **待 owner 确认：D21 的上界与 `IMPLEMENTATION_PLAN.md:509`**：挂载内请求至多 10 s、其它空间与空间根不受影响、每个挂起的挂载至多占一个 libuv 线程 10 s——是否满足「故障不阻塞空间根目录使用」。
- **待 owner 裁定：挂载源登记 API-only 还是中心最小 tab**。(a) API-only（现稿）：零前端成本，管理员用带 cookie 的 `curl` 登记 / 删除，NFS 与本机目录在有人登记之前对用户不可用；(b) 中心最小 tab（列表、登记、删除，仿 `s1d-connectors` 组 6 #1675 的中心 tab）：多一个前端任务组（约一个中等 PR：tab、表单、确认框、组件用例与验收行），服务端不变。选 (b) 时作为组 13 追加，不改既有组号。

## Sketch seams under test

- 组 1：迁移 049 的约束（两条形状 CHECK、`uploads` 保留、两个 `RESTRICT`）与 store / 取值规则——`:memory:` + 真实迁移，seam 是 store 与 `validate` 的导出函数。理由：表约束只能对真实迁移验证，取值规则是 store 写入的唯一入口。
- 组 2：`resolveServerConfig` 纯 seam（三键的缺省、覆盖与非法值；预检以注入的 PATH、`/dev/fuse`、`fuse.conf` 路径与 `id` 可执行文件判定）+ 编译入口一例 `reason: "config"`。理由：配置层已有同形用例，最高 seam 即入口。
- 组 3：`ensureOmpStateLayout` 的精确布局 + CI `uid-isolation` 的托管布局用例（`<state>/mounts` 对 omp uid 不可进入）。理由：只有真实两 uid 能证明不可读。
- 组 4：typed error map 与计数守卫。
- 组 5–6：`createMountManager({rcloneBin, fusermountBin, stateDir, mountinfoPath, ompUid, now…})` 模块边界——假 rclone `server/test/fixtures/fake-rclone.mjs` 与假 `fusermount3` 是被真实 spawn 的可执行文件，挂载 / 卸载经它们改写一个假 mountinfo 文件，并把收到的 argv、环境与标准输入落成记录文件。理由：唯一能在 CI 上观测「已挂载」「凭证不上命令行」「环境恰两键」的 seam；退避与探测用注入时钟。
- 组 7、组 9：`createApp` + `app.inject` 整体挂载，注入以假 rclone / 假 `fusermount3` 装配的真实 manager。理由：端点次序、归属身份、审计与文件端点的挂载判定都在 HTTP 边界上可观测，不需要第二层 mock。组 9 的「挂起的挂载」经适配器的文件系统 seam 注入一个永不返回的实现（假 FUSE），期限注入为短值。
- 组 8：纯 `resolve` 与 facade 的模块用例（真实临时目录）+ 快照、还原、根层 `tree`、附件、撤回与文件变更归属各自既有的模块 seam，挂载名经端口注入。理由：「不 `lstat`」只能在 seam 上以「若被 `lstat` 即被拒的条目」观测。
- 组 10–11：`WorkspaceBrowser` 与文件页的组件用例（假 `ApiClient`）+ CI `make ui-walk` 文件页一步（挂载关闭：没有 `挂载目录`）；挂载开启的走查是测试主机上的手工步骤，记验收行。
- 组 12：真实 manager + 真实 rclone + 真实 FUSE（Linux、`WORKBUDDY_FUSE_TEST=1`，测试主机一次性容器）：`local` 后端读写、只读、杀 rclone 后离线与重挂、惰性卸载后挂载点消失；签收运行必带 `sftp` 读写与远端停机后离线、恢复后在线。

## 行数预算

| 文件 | 现状 | 预计 | 说明 |
|---|---|---|---|
| `server/src/server.ts` | 743（三个 s1d 之后 ~790） | ≤795 | 配置展开、`appAssemblyOf` 的 `mounts` 一项、`restoreAll` 一行；超过即并进 `startup-registry.ts` |
| `server/src/app.ts` | 491 | ~505 | 构造 manager、递交 `registerWorkspaces` 与 facade 的 `mountNamesOf`、关闭钩子 |
| `server/src/core/sandbox/resolve.ts` | 81 | ~100 | 挂载名集合与第一段函数 |
| `server/src/workspaces/rest.ts` | 484 | ~500 | tree / dirs 的挂载判定调用 |
| `server/src/workspaces/rest-entries.ts` | 241 | ~260 | delete / move 的挂载判定调用 |
| `server/src/workspaces/mounts/*.ts` | 新 | 各 ≤400 | config / validate / store / host-policy / rclone-conf / mountinfo / manager / rest / path-rule / fs |
| `web/test/workspace-browser.test.tsx` | 756 | 757 | 本地 `requests()`（:113）滤掉 `…/mounts` 一行；新用例进新文件 |
| `server/test/auth-lifecycle.test.ts` | 788（→790） | 797 | 只补七条 `codes` 条目 |
| `web/src/features/files/workspace-browser.tsx` | 783 | ≤798 | 只加接线；取数与状态进新 hook `use-mounts.ts`，行与对话框进新文件 |
| `web/src/features/files/mount-roots.tsx`、`mount-dialog.tsx` | 新 | 各 ≤400 | |

## Traceability

- 需求：`IMPLEMENTATION_PLAN.md` F-FILE-3（:108）、S1b（:198-205）、:501、:509、:545-546；前置实测 #1665。
- grill 凭证：本 design「owner 的裁定」（2026-10-21）。
- 相关 ADR：0003（补充）、0010（补充）、0011（绝对 root 不是浏览器秘密）、0013（拷入层）。
- 相关规格：sandbox-core（「resolve 契约与逃逸向量」「沙箱 facade 与拒绝审计」，D21 改）、workspace-snapshots（`dev` 规则不改；已登记挂载名按名字跳过由 workspace-mounts「宿主不同步进入挂载」规定）、temporary-workspaces（#1237，不改）、preview-origin（不改；挂载内路径的 404 由 workspace-mounts「宿主不同步进入挂载」规定）。
- 审查与修订：Stage 4 第一轮（2026-10-22）新增 D21 与「#1665 补充探针」，改 D2、D3、D4、D5、D6、D7、D8、D9、D10、D11、D12、D13、D14、D16、D18、D20。
- 兄弟 change：`s1d-model-registry`（Epic #1640）、`s1d-experts-skills`（Epic #1654）、`s1d-connectors`。
