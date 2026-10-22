# Proposal: s1b-workspace-mounts

> Issue type: feature（S1b：F-FILE-3 远程目录按工作空间挂载）
> Fixture level: expanded（整个 change；各任务组的级别见 tasks.md 组尾声明）
> Blast radius: 工作空间根下多出 FUSE 挂载点（omp 与文件页都按普通目录访问）；app 以自己的 uid 拉起长驻 `rclone mount` 子进程；`OMP_STATE_DIR` 多一个 app 私有目录 `mounts/`（凭证、VFS 缓存、日志）；三个配置键与启动预检；迁移 049；错误码 +7、归属身份 +2；工作空间的删除 / 移动 / 新建目录 / 读取在挂载目录内多出明确的 4xx；沙箱 `resolve` 对已登记挂载名之下不做文件系统调用，挂载内的读写改经有期限的异步适配器，空间根列举、快照、还原、预览源、会话附件、撤回与文件变更归属按挂载名词法跳过，文件变更归属与项目技能列表的 `realpath` 改为有期限的异步调用；文件页与会话页侧边栏的目录树多出挂载根行，文件页 `新建` 菜单多一项 `挂载目录`
> Evidence floor: `npm test --workspace server`、`npm test --workspace web`、typecheck、size-guard、`make check`、`make test-guardrails`、`make ui-walk`、PR CI `uid-isolation`；真实挂载层在测试主机以 `WORKBUDDY_FUSE_TEST=1` 手工运行（不进 CI）
> 依赖：前置实测 #1665（rclone 三后端跨 uid 挂载、凭证隔离、断连与占用卸载，连同 design「#1665 补充探针」P1′、P2′、P4′、P9–P15；结论写入 ADR-0003 补充）。建在 `s1d-model-registry`（Epic #1640：`forbidden` 码、`isAdmin`、启动阶段写法）、`s1d-experts-skills`（托管布局的 `session-config` 行、拷入层 `switch`）与 `s1d-connectors`（启动阶段 `mcp_json`、归属身份二十九条、布局表的 `mcp.json`）之上。归档顺序：三个 s1d change → 本 change。迁移编号 049（046–048 归三个 s1d change）。

## Why

`IMPLEMENTATION_PLAN.md` S1b（:198-205）要求 mount-manager：rclone 挂载的生命周期、凭证经受权限保护的配置文件注入、崩溃重挂与在线状态，覆盖 F-FILE-3「挂载/卸载 SFTP/NFS/SMB（只读标记、在线状态）」。今天工作空间只有本地目录：omp 与文件页都碰不到内网文件服务器上的资料，demo 的「挂载目录」对话框与挂载根行没有任何后端支撑。

grill（2026-10-21，owner 逐分支拍板，见 design「owner 的裁定」）定了形态：SFTP、SMB 由用户自填凭证自助挂载；NFS 与本机目录由管理员在 OS 层挂好并登记为「挂载源」，用户再经 rclone `local` 后端接入；统一用 rclone 的 `sftp`、`smb`、`local` 三个后端，不带 sshfs；凭证只在 app 私有的 `rclone.conf`（`0600`）里；挂载内删除与跨挂载移动一律拒绝；卸载用惰性卸载；`RCLONE_BIN` 未配置即整个功能关闭。

## What Changes

- **迁移 049**（`049_workspace_mounts.sql`）：`mount_sources`（管理员登记的服务器目录：名称、绝对路径、只读）与 `workspace_mounts`（空间、属主、名称即挂载点目录名、后端 `sftp` / `smb` / `local`、主机、端口、远端路径、挂载源、只读、创建时间）；表里没有任何凭证列。
- **配置与预检**：`RCLONE_BIN`（缺省未配置 = 挂载关闭）、`MOUNT_HOST_ALLOW`（主机许可名单，缺省不限）、`MOUNT_MAX_PER_WORKSPACE`（缺省 `8`），应用配置由三十七项变四十项。配置了 `RCLONE_BIN` 时启动预检：可执行普通文件、PATH 上有 `fusermount3`、`/dev/fuse` 存在；`OMP_USER` 模式另查 `/etc/fuse.conf` 的 `user_allow_other`、取得 omp uid，并要求 `fusermount3` / `fusermount` 只对 app 所在、omp 不在的组可执行（否则 omp 能自己挂 `allow_other` 的 FUSE 让 app 挂住）；任一不过即启动失败（`reason: "config"`）。
- **mount-manager**（`server/src/workspaces/mounts/`）：每个挂载一个 app 私有目录 `<OMP_STATE_DIR>/mounts/<id>/`（`0700`；`rclone.conf` `0600`，口令经 `rclone obscure` 处理）；挂载点 `<空间根>/<挂载名>` 每次尝试前先 `lstat`（不跟随）：不存在才经 `ensureSharedDir`（`2770`）建出，存在（或建出之后）须是 app 持有的目录而不是符号链接；以 app uid 前台拉起 `rclone mount`（配置段名 `m<挂载 id>`，sftp / smb 的主机以判定过的 IP 经 `--sftp-host` / `--smb-host` 给出）（可写挂载 `--vfs-cache-mode writes`，`OMP_USER` 模式 `--allow-other --default-permissions --uid <omp> --gid <共享组> --umask 007`），凭证不上命令行、子进程环境只有 `PATH` 与 `HOME`；在线 = 进程存活 ∧ 挂载点在 `/proc/self/mountinfo` ∧ 5 s 内 `stat` 成功，30 s 一轮；掉线即惰性卸载（含按来源扫描 mountinfo）并按指数退避（封顶 5 分钟）重挂；一个挂载的建出、重挂、恢复与卸载在其空间的串行链上，卸载与关停先杀掉在途的挂载尝试；启动成功后不等待地恢复全部挂载，关停时全部卸载。
- **主机规则**：主机名转小写、去掉末尾的点之后判定；环回主机（字面、任一 IPv6 写法、IPv4 映射或解析结果）一律拒绝；`MOUNT_HOST_ALLOW` 配置时只放行名单内的主机；解析失败即该次尝试失败；判定过的 IP 交给 rclone，rclone 不再自行解析；每次挂载尝试（含重挂）都判定。
- **宿主不同步进入挂载**：服务进程不对已登记挂载的挂载点及其下做同步文件系统调用——`core/sandbox` 的 `resolve` 增挂载名集合（facade 增端口 `mountNamesOf`），挂载内的文件系统调用只经 `server/src/workspaces/mounts/fs.ts`（`fs/promises`、每挂载并发 1、每次 10 s 期限，超期即 409 `mount_offline` 并判离线）；空间根列举、快照与还原、预览源、会话附件、撤回与文件变更归属按挂载名词法跳过或拒绝；文件变更归属与项目技能列表中可能跟随 omp 所放符号链接的 `realpath` 改经 `fs/promises`、同样 10 s 期限；挂载名 `uploads`、`screenshots` 保留（上传与会话截图目录比对因此永不进入挂载）。
- **挂载端点**：`GET /api/workspaces/:id/mounts`（`{enabled, mounts}`，永不回传凭证）、`POST /api/workspaces/:id/mounts`（建出即首次挂载 = 连通测试，失败不留行）、`DELETE /api/workspaces/:id/mounts/:mountId`（惰性卸载后删除凭证目录）；临时空间不能挂载。审计 `mount.attach`、`mount.detach`、`mount.reject`。
- **挂载源端点**：`GET /api/mount-sources`（所有人；普通用户不见路径）、`POST /api/mount-sources` 与 `DELETE /api/mount-sources/:id`（仅管理员；删除连带卸载引用它的挂载）。审计 `mount.source.create`、`mount.source.delete`。
- **错误码 +7**（十八 → 二十五）：`mount_disabled`、`mount_failed`、`mount_offline`、`mount_limit`、`mount_host_rejected`、`mount_read_only`、`mount_boundary`；归属身份 +2（二十九 → 三十一）：`POST /api/workspaces/:id/mounts`、`POST /api/mount-sources`。
- **挂载目录内的文件端点**：成员按去掉空段与 `.` 段之后的第一段判定；挂载内删除、跨挂载移动、移动挂载根 → 409 `mount_boundary`（不再是 `EXDEV` 的 generic 500）；只读挂载内新建目录与移动 → 403 `mount_read_only`；离线挂载内的列举、读取、下载、压缩包列表、新建目录与移动 → 409 `mount_offline`。挂载名 `uploads` 与 `screenshots` 保留，上传与会话截图目录比对因此永不落进挂载；挂载内新建目录由异步适配器 `mkdir`，不经 `ensureSharedDir`。
- **前端**：文件页与会话页侧边栏（同一个 `WorkspaceBrowser`）在空间根之后列出挂载根行（服务端的根一层 `tree` 不再列出挂载点）（`只读` 标签、在线点、`卸载 <名>`、离线不可展开）；挂载内的网页、PDF 与办公文档在预览区显示 `挂载目录内的文件暂不支持预览，请下载查看`（预览来源对挂载内路径 404）；文件页 `新建` 菜单在挂载启用时多 `挂载目录`，对话框含名称、协议、主机、端口、路径、凭证与 `只读挂载` 开关，按钮 `测试连通并挂载`，失败就地显示。不新增 `.css`。
- **文档**：ADR-0003「2026-10 补充」的产品化一节（以 #1665 的 P1–P8 为证据）、ADR-0010 补充（挂载的 uid/gid 选项与 `<state>/mounts`）、`system.md` 新节（`fuse.conf`、依赖包、部署前提）与 §3 `deriveWhitelist`「S1b 未来项」的销项、验收清单文件节新增挂载行。

## Capabilities

### New Capabilities
- `workspace-mounts`: 迁移 049、配置与预检、取值与主机规则、凭证文件、挂载进程与挂载点、在线状态与重挂、服务启停、挂载操作的串行与取消、挂载与挂载源端点、临时空间与删除前卸载、挂载目录内的文件端点、宿主不同步进入挂载、挂载根行与挂载对话框、真实挂载验证层。

### Modified Capabilities
- `sandbox-core`: 「resolve 契约与逃逸向量」（可选的挂载名集合：第一段是挂载名时不做文件系统调用）、「沙箱 facade 与拒绝审计」（可选端口 `mountNamesOf`）。以主规格为底。
- `http-service-skeleton`: 「服务启动与装配」（三个挂载键、启动预检、启动后恢复挂载、关停卸载）、「统一错误信封」（二十五码、归属身份三十一条）。两者都以 `s1d-connectors` 的 MODIFIED 文本为底。
- `omp-runtime`: 「OMP_STATE_DIR 托管布局」（布局表加 `<state>/mounts`，`0700`；以 `s1d-connectors` 的 MODIFIED 文本为底）。
- `omp-uid-isolation`: 「Linux 隔离证明」（托管布局用例另证 omp uid 不能进入 `<state>/mounts`、读不到 `rclone.conf`；以 `s1d-connectors` 的 MODIFIED 文本为底）。
- `file-operations`: 「删除到回收目录」「重命名与移动」（挂载判定插在沙箱判定之后、存在性检查之前）。
- `workspaces`: 「目录树、新建目录与隔离」（离线挂载与只读挂载）。
- `files-web`: 「工作空间页」（不再禁止宣传挂载；`新建` 菜单的 `挂载目录`；选中挂载内的文件时向预览区交出「在挂载内」）。
- `file-previewers`: 「隔离来源的嵌入与令牌」「PDF 与办公文档」（宿主标明在挂载内时不签发、不建 iframe、显示固定文案，`查看源码` 照常；先于 PDF 与办公文档既有的三项判定；被挡下的预览不触发续期）。以主规格为底。
- `workspace-snapshots`: 「快照内容规则」「还原」（根一层的已登记挂载名按名字跳过：不读元数据、不遍历、还原时不删除不建出，记 `skipped` `reason: "mount"`；`dev` 规则对未登记挂载不变）。以主规格为底。
- `turn-artifacts`: 「文件变更推导与归属」（词法上在已登记挂载内的候选在任何文件系统访问之前丢弃；`realpath` / `lstat` 经 `fs/promises` 并带 10 s 期限）。以主规格为底。
- `chat-sessions`: 「Slash 命令白名单与命令目录」（项目技能目录的两个内核 real path 改经 `fs/promises` 的 `realpath`、10 s 期限，`listProjectSkills` / `sessionSkills` 返回 promise）。以主规格为底。

## Impact

- 服务端：新 `server/src/workspaces/mounts/`（config、validate、store、host-policy、rclone-conf、mountinfo、manager、rest、path-rule、fs）、迁移 049、`core/errors` 七码、`http/errors.ts` 归属集、`state-layout.ts` 一行、`core/sandbox` 的 `resolve` 与 facade、`server.ts` 的配置展开与启停接线、`app.ts` 的 manager 构造、`workspaces/rest.ts` / `rest-entries.ts` / `rest-archive.ts` 的挂载判定与适配器、`workspaces/tree.ts`、`snapshots.ts`、`snapshots-restore.ts`、`preview/app.ts`、`sessions/prompt-attachments.ts`、`undo.ts`、`file-changes-ownership.ts`（经 `turn-control.ts`）的挂载名跳过；`file-changes-ownership.ts` 与 `sessions/slash-commands.ts` 的 `realpath` 改为有期限的异步调用（调用方 `turn-control.ts`、`rest-commands.ts`、`sessions/rest.ts`、`branching.ts` 随之 `await`）。
- 前端：新 `web/src/lib/api-mounts.ts`、`web/src/features/files/mount-roots.tsx` 与 `mount-dialog.tsx`；`workspace-browser.tsx`（783 行）只加接线；预览区对挂载内的隔离来源预览器显示固定文案。
- 测试夹具：假 rclone `server/test/fixtures/fake-rclone.mjs` 与假 `fusermount3`（同 `fake-soffice.mjs` 的真实 spawn 写法）；Linux opt-in 真实挂载用例 `server/test/linux/mounts-fuse.test.ts`。
- 部署：主机需 `fuse3`、`rclone`（≥ 测试主机实测版本）与 `/etc/fuse.conf` 的 `user_allow_other`，`OMP_USER` 模式下 `fusermount3` 改为只对 app 所在、omp 不在的组可执行；参考镜像 `deploy/app/` 的 FUSE 能力留给 S4b（见 design Non-Goals）。
