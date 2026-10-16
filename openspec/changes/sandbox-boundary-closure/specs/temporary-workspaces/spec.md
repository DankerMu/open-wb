## MODIFIED Requirements

### Requirement: 临时空间目录的删除
临时空间行在事务中被删除之后，宿主 SHALL 在提交后删除它的目录，且该删除是服务端内部操作，不经过沙箱 facade 的用户路径 resolve、不写 `sandbox_denied` 审计。步骤：
1. 取 `<SANDBOX_ROOT>/<ownerId>` 的 realpath 与目标 `<该 realpath>/tmp-<id>`；对目标 `lstat`（不跟随符号链接）：不存在视为成功；不是目录（含符号链接）SHALL NOT 删除任何东西，经服务错误通道报告一次。
2. 把目标 `rename` 为 `<OMP_STATE_DIR 的 realpath>/trash/<32 位随机 hex>`（omp-runtime「OMP_STATE_DIR 托管布局」的 app 私有目录），再对 trash 里的该项 `lstat`：是目录则在 trash 内递归删除（不跟随其内的符号链接），不是目录则只 `unlink` 该项并报告一次。
3. `rename` 以 `EXDEV` 失败（沙箱根与状态目录不在同一文件系统）时 SHALL 退为原地删除：再对目标 `lstat` 一次，仍是目录则原地递归删除（不跟随符号链接）。`rename` 以 `ENOENT` 失败时按「会话删除」的同名规则复查原位置。其它失败经服务错误通道报告且不触碰原位置。
4. 同时删除该空间的快照目录（workspace-snapshots「清理」）。

以上任何失败（含递归删除的部分失败）SHALL 只经服务错误通道报告，不改变 `DELETE` 的 204，错误通道自身的失败也不改变响应；残留目录不被任何行引用。递归删除 SHALL NOT 触及目标目录之外的任何路径：目标内指向外部的符号链接只删除链接本身。

**挂载规则（#1237，owner 2026-10-13 B6 / 2026-10-16 B7）。** 递归删除 SHALL NOT 跨越挂载点。挂载点以 Linux 对该目录 `rmdir` 返回 `EBUSY`、且它作为挂载点出现在 `/proc/self/mountinfo` 里为准，不区分文件系统类型（rclone、sshfs、bindfs 等 FUSE 挂载与另一个卷同样对待）；本规则不以 `dev` 比较定义——FUSE 挂载带自己的 `st_dev`（测试主机实测：bindfs 挂载点与宿主目录的 `st_dev` 不同），同一文件系统内的普通 bind mount 则与宿主同 `st_dev` 却同样 `rmdir` 得 `EBUSY`、同样不被跨越（workspace-snapshots「快照内容规则」按 `dev` 定义的是快照的遍历边界，不是本规则的判据）。目录内有活挂载时：递归删除在该挂载点失败（`EBUSY`），挂载内的任何文件 SHALL NOT 被读取、修改或删除，别处挂着的同一来源内容不变；挂载点之外的同级条目仍会被并发删除、不恢复（测试主机实测，Node 24.13.1：`fs/promises` 的 `rm` 对同级子项并行发起，挂载点的 `EBUSY` 抛出时兄弟子树的删除仍在进行，沉降后的残骸只有挂载点目录及其内容）；残骸连同挂载留在 `<OMP_STATE_DIR 的 realpath>/trash/<随机名>/…`（trash 路径——同设备 `rename` 成功且挂载点随目录一起移动，实测）或原地（EXDEV 路径），`DELETE` 仍 204，错误通道恰报告一次。宿主 SHALL NOT 检测挂载、SHALL NOT 卸载、SHALL NOT 重试或清扫残骸：残骸由管理员先卸载（`fusermount3 -u <挂载点>` 或对应命令）再以应用 uid 手工删除（实测：卸载后 `rm` 一次成功、目录消失；部署文档：ADR-0010 补充、`docs/architecture/system.md` 部署一节）。

删除用户持有的目录树 SHALL 只经 `fs/promises` 的 `rm`（或回调式 `fs.rm`）；`fs.rmSync({recursive: true})` SHALL NOT 用于任何可能含挂载点的用户目录树——Node 24.13.1 上它是另一套实现（C++ `binding.rmSync`，前两者是 JS rimraf），测试主机实测它会穿过 FUSE 挂载点把挂载内的源数据删掉（源目录变空、不可恢复），之后抛出 `code === ""`、`errno === -4094` 的错误（不是 `EBUSY`）。

该规则由 `server/test/linux/temp-dir-remove-fuse.test.ts` 用真实 FUSE 挂载钉住：它 SHALL 只在 `process.platform === "linux"` 且 `WORKBUDDY_FUSE_TEST=1` 时执行，否则以 `describe.skipIf` 明示跳过；已 opt-in 而缺少运行前提（`bindfs`、`fusermount3`、`/dev/fuse`、`WORKBUDDY_FUSE_ALT_FS_DIR` 指向另一文件系统上的可写目录）SHALL 失败而非追加 skip；它判断「挂载仍在」SHALL 以 `/proc/self/mountinfo` 里挂载点的路径为准，SHALL NOT 以 `bindfs` 字样 grep 挂载表（bindfs 挂载的 fstype 显示为 `fuse`，实测）；每例使用新建的空 `mnt`（非空的挂载点不能被 bindfs 复用，实测）；它不进任何 CI job（owner B7：只在测试主机的一次性容器里手工实测，结果记入 PR 与 ADR-0010）。

#### Scenario: 经 trash 删除且不跟随链接
- **WHEN** 临时空间目录含嵌套子目录与一个指向沙箱外某文件的符号链接，其唯一会话被删除
- **THEN** 204；`tmp-<id>` 不存在；`<OMP_STATE_DIR>/trash` 为空；链接指向的外部文件字节不变；错误通道无报告

#### Scenario: 目标被换成符号链接
- **WHEN** 删除事务提交之后、目录删除之前，`tmp-<id>` 被换成指向账号根之外某目录的符号链接（经测试钩子注入）
- **THEN** 204；该符号链接与它的目标目录内容都保留；错误通道恰报告一次

#### Scenario: 跨文件系统退为原地删除
- **WHEN** 测试令 `rename` 以 `EXDEV` 失败
- **THEN** 204；`tmp-<id>` 已被原地递归删除；其内指向外部的符号链接的目标不变；错误通道无报告

#### Scenario: 删除失败不影响响应
- **WHEN** 目录内有一个 app 用户无法清空的子目录（mode `0500`、内含文件），且它是目录的唯一顶层条目
- **THEN** 204；空间行已删除；错误通道报告一次；残余位于 trash 之下而不在账号根下

#### Scenario: 目录内有活挂载（trash 路径，仅 opt-in 的 Linux FUSE 用例）
- **WHEN** `WORKBUDDY_FUSE_TEST=1` 且前提齐备；账号根与 `<state>/trash` 在同一文件系统；`tmp-<id>` 内**唯一**的顶层条目是一个新建的空目录 `mnt`，测试以 `bindfs` 把测试自有的源目录（含文件）挂到 `mnt`；调用 `removeTemporaryWorkspaceDir`
- **THEN** 函数正常 resolve、不抛（`DELETE` 的 204 由此成立；HTTP 层由「删除失败不影响响应」钉住，本用例不起 HTTP）；源目录的全部文件字节不变；`mnt` 仍是一个挂载（`/proc/self/mountinfo` 里该挂载点的路径已随目录移到 trash 之下）；`tmp-<id>` 已不在账号根下；`<state>/trash` 下恰一个随机名目录，其中恰为 `mnt`（残骸位置恰为 `trash/<随机名>/mnt`），`mnt` 内仍是源目录的内容；错误通道恰报告一次且 `code === "EBUSY"`；测试随后以 `fusermount3 -u` 卸载并清理，卸载失败使测试失败

#### Scenario: 目录内有活挂载（EXDEV 原地路径，仅 opt-in 的 Linux FUSE 用例）
- **WHEN** 同上，但 `<state>/trash` 位于 `WORKBUDDY_FUSE_ALT_FS_DIR` 指向的另一文件系统上（`rename` 以 `EXDEV` 失败）
- **THEN** 函数正常 resolve、不抛；源目录的全部文件字节不变；`mnt` 仍是一个挂载且路径未变；`tmp-<id>` 仍在账号根下，其中恰为 `mnt`（残骸位置恰为 `tmp-<id>/mnt`）；`<state>/trash` 为空；错误通道恰报告一次且 `code === "EBUSY"`

#### Scenario: 非 opt-in 明示跳过
- **WHEN** 平台不是 Linux 或 `WORKBUDDY_FUSE_TEST` 不是 `1`
- **THEN** 该文件的 suite 报告 skipped，不创建目录、不挂载、不改 env；已 opt-in 而缺少任一前提时 suite 失败，不追加 skip
