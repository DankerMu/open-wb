# Proposal: sandbox-boundary-closure

## Why

#1286 自 s1f-files-page 起登记为「已知残余」（archive design D22 / D-23 / D-27，验收清单 FL-01）：检查之后按路径操作的替换窗口。两条根因都还开着：

1. `SANDBOX_ROOT` 是 `2770`、没有粘滞位——omp uid 可以改名、挪走或替换其下任何由应用 uid 建出的条目（`.trash`、别的账号根）。不需要竞态的「把他人账号根改名成 `.trash`」在 uid 分离的 Linux 部署上实测过（issue 评论 2026-10-10）。
2. 四条读路由（`GET …/file`、`GET …/download`、`/w/<令牌>/…`、`/o/<令牌>/…` 转出的 PDF）在 `lstat` 之后按路径 `createReadStream`，没有 `O_NOFOLLOW` 与 `O_NONBLOCK`、不 `fstat`——末段被换成符号链接时读到链接目标，被换成命名管道时 `open` 永久占住一个线程池线程，四个请求就能卡死进程的异步文件操作。`GET …/archive` 已经用「不跟随、不阻塞地打开后按描述符判普通文件」关掉了自己的那一半（`server/src/workspaces/rest.ts:201-227`）。

#1237（Part of #917）：临时空间目录删除遇到活挂载（rclone / sshfs）时的行为没有被任何测试钉住——Node 22 上实测是递归删除在挂载点以 `EBUSY` 中止、挂载内文件不受影响、带挂载的残骸留在 `<state>/trash`；仓库钉的 Node 24.13.1 上没有实测，EXDEV 原地路径没有实测，残骸的归属没有写进任何规格或文档。

owner 2026-10-13 / 2026-10-16 拍板（grill ledger B1–B9）：两个 issue 合成一个 change，走完整 stage-change-pipeline；#1286 做**有界闭合**，#1237 用真实 FUSE 对照用例钉住并写明残骸处置。

## What Changes

- **启动时建沙箱根并补粘滞位（B2、B3、B4）**
  - 新启动阶段 `sandbox_root`：在托管布局之后、预览监听器 listen 之前，入口把配置的 `SANDBOX_ROOT` 建出来（缺失时递归 `mkdir`，不改父级权限位）、取内核 realpath，并把真实目录校正为精确 `0o3770`（setgid + 粘滞位 + 属主/组 rwx，不动属组、不 chown、不改 umask；mode 取值是编排方默认，owner 只拍了「补上 sticky 位」）。
  - `OMP_USER` 模式：根不属应用 uid、不是目录、chmod 不生效 → 启动失败，stderr 恰一行 `{"event":"server_start_failed","reason":"sandbox_root"}`，不带路径。
  - 同 uid 模式（`OMP_USER` 缺席）：不是目录仍然失败；属主不符或 chmod 失败不检查、不纠正，只经同一受管 stderr writer 写一行 `{"event":"sandbox_root_unchanged"}` 后继续启动。
  - 配置阶段失败时仍然什么都不创建；`db`、`app`、`listen`、`state_layout` 失败同样不创建沙箱根（阶段次序如上）。
  - 惰性创建点（`createApp` 的临时空间创建、工作空间 store、`spawnOmp`）保持原样：仍对新建的每一级 `chmod 2770`，启动之后它们在生产里再也建不到根这一级。
  - **部署前提（BREAKING，仅 `OMP_USER` 模式）**：`SANDBOX_ROOT` 现在必须属应用 uid（且应用 uid 在共享组里，否则 setgid 位设不上）。既有 uid 分离部署里由 root 建出、`chgrp` 给共享组的沙箱根会在升级后启动失败；升级前把根 `chown` 给应用 uid，或预先建成应用 uid 持有的 `3770`。
- **四条读路由改为 fd 锚定（B1、B5）**
  - 共享读流 helper `openPreviewStream` / `openRangeStream` 改为接受已打开的描述符；打开统一经 `openRegularFile`（从 `rest.ts` 移到独立模块、所有读路由共用）：`O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开，`fstat` 判普通文件并取大小，`createReadStream(null, {fd, start, end, autoClose: true})` 读。
  - 命名管道、目录、套接字、被换入的符号链接、已消失的条目一律 `not_found`（主站 404 信封；预览监听器 404 纯文本），描述符关闭、零字节读出。`fstat` 是大小的权威：`Content-Length`、`Range` 区间、文本上限、下载审计的 `detail.size` 都按打开的 inode。
  - `GET …/download`：打开与 `fstat` 先于审计行；被拒的目标没有 `file.download` 审计行；审计写入抛错 → 关闭描述符、500、不发任何字节。
  - `/o/` 转出的 PDF 同样经描述符发送；缓存文件在转换落定之后消失或被换掉仍按今天的「转换失败」答 502（编排方默认，待确认）。
  - 书面残余保留：`resolve` 之后、打开之前，路径的**中间目录分量**被换成符号链接时 `open` 仍跟随它（Node 没有 `*at` 系调用）；`/o/` 的转换进程按路径读输入（#1350，不在本 change）。
- **#1237 挂载规则（B6、B7）**
  - temporary-workspaces「临时空间目录的删除」加挂载规则：递归删除 SHALL NOT 跨越挂载点；目录内有活挂载时删除在挂载点失败、挂载内的文件不被触碰、残骸留在 `<state>/trash`（trash 路径）或原地（EXDEV 路径）、响应仍是 204、只经错误通道报告一次；残骸由管理员先卸载再手工删除，不做清扫器。
  - 新增默认跳过的 Linux 用例文件 `server/test/linux/temp-dir-remove-fuse.test.ts`（门控 `process.platform === "linux" && WORKBUDDY_FUSE_TEST === "1"`），用真实 FUSE 挂载（`bindfs`）覆盖 trash 路径与 EXDEV 原地路径；#1237 的 issue 正文要求「uid-isolation job 里的对照用例」，owner 裁定 B7 推翻为**只在测试主机手工实测**（一次性容器、Node 24.13.1），用例默认跳过、不改 CI、不加依赖，实测结果写进 PR 与 ADR-0010 补充。
  - 顺带（B9）：`server/test/session-delete-temp-workspace.test.ts:510-540`「删除失败不影响响应」对残骸目录内容的精确断言与 Node rimraf 子项并行、首错即返回的实现有竞态（PR #1459 的 CI 红），做最小修复，不改产品代码。
- **文档与关闭**：ADR-0010 补充一节记录 B2/B3/B4、`sandbox_root` 的排障与部署前提、FUSE 实测结果；ADR-0014 的 #1286 行、`docs/architecture/system.md` 的部署一节与五处源码头注释改为闭合后的终态措辞；验收清单新增一行（待签）；全部切片合并后关闭 #1286 与 #1237。
- **不做**（design Non-Goals）：回收目录清扫器；挂载检测或遇挂载拒绝删除；办公文档转换输入侧的加固（#1350）；中间分量竞态的闭合；为 FUSE 改 CI 或加依赖；同 uid 模式语义在 B3 之外的任何改变。

## Capabilities

### New Capabilities

无。沙箱根的建立与权限位作为 sandbox-core 的一条新 requirement 进入既有 capability。

### Modified Capabilities

- `http-service-skeleton`：「服务启动与装配」——启动阶段枚举加 `sandbox_root`、阶段次序、同 uid 模式的 `sandbox_root_unchanged` 记录、「完整装配路由与惰性根」场景改为「根已建出且为 `3770`、`u1` 仍不存在」。
- `sandbox-core`：新增「沙箱根目录」（`ensureSandboxRoot` 的两种模式）；「共享目录权限位」加一句 `SANDBOX_ROOT` 自身不经 `ensureSharedDir`。
- `omp-uid-isolation`：「自有状态不对组可读」——「`SANDBOX_ROOT` 下既有目录权限位不变」只对根以下成立，根由启动校正为 `3770`。
- `workspaces`：「预览分类元数据与有界字节流」（两个读流 helper 改为按描述符）与「文件预览」（打开规则、换入即 404、大小以打开的 inode 为准）。
- `file-operations`：「下载」（打开与 `fstat` 先于审计；被拒的目标无审计行；大小按描述符）。
- `preview-origin`：「预览监听器」（`/w/` 的打开规则）。
- `office-preview`：「办公文档预览路由」（转出 PDF 的发送经描述符）。
- `temporary-workspaces`：「临时空间目录的删除」（挂载规则与残骸处置；门控的 FUSE 对照用例）。

## Impact

- **服务端**
  - `server/src/core/sandbox/dirs.ts`：新增 `ensureSandboxRoot`（复用 `ensureOwnedDir`）。
  - `server/src/server.ts`：`StartupStage` 加 `sandbox_root`；在 `state_layout` 之后同步调用；同 uid 模式的一行记录经既有受管 writer。
  - `server/src/app.ts:232-234`：注释改为「启动已建根；这里只建账号根与空间根」。
  - 新模块 `server/src/workspaces/regular-file.ts`：`openRegularFile` 自 `rest.ts:191-227` 移入并返回 `{fd, size}`；`rest.ts`（`/file` 与嗅探）、`rest-entries.ts`（`/download`）、`rest-archive.ts`、`preview.ts`（两个 helper 改签名）、`range-send.ts`（接收描述符、416 与 HEAD 时关闭它）、`preview/app.ts`（`/w/` 与 `/o/` PDF）改为经它。
  - `temp-dir-remove.ts` 不改代码。
- **测试**：新文件 `server/test/workspaces-file-swap.test.ts`、`server/test/preview-app-swap.test.ts`、`server/test/linux/temp-dir-remove-fuse.test.ts`；`workspaces-download.test.ts`、`sandbox-dirs.test.ts`、`server-startup-failure-reason.test.ts` 扩写；既有按路径钉住读流与「启动后沙箱根不存在」的断言按 design D5 的封闭清单改写；`session-delete-temp-workspace.test.ts:510-540` 的最小修复。
- **规格**：上列八个 capability 的 MODIFIED 与一条 ADDED。
- **文档**：`docs/adr/0010-dedicated-omp-uid.md`（补充一节 + 两处陈述现状的句子订正）、`docs/adr/0014-isolated-preview-origin.md`（#1286 表）、`docs/architecture/system.md`（部署一节的 `sandbox_root` 排障行）、`docs/acceptance/functional-checklist.md`（新增一行）；源码头注释 `server/src/server.ts:31-38`、`workspaces/trash.ts:1-60`、`workspaces/rest-entries.ts:1-41`、`preview/app.ts:1-50`、`preview/office-cache.ts:31-40`、`workspaces/range-send.ts:1-7`。
- **部署**：见上「部署前提」；同 uid 部署无动作（开发机上 `var/sandbox` 由 `2770` 变 `3770`）。
- **依赖**：无新增。**CI**：不改（B7）；uid-isolation job 预置的 `2770` 沙箱根在该 job 的 `make smoke` 阶段被启动校正为 `3770`，作为 S1 的 chmod 分支证据（design D10：失败可见、取值不断言）。

## 流程记录

```text
Issue type: bugfix（安全边界）
Pipeline: stage-change-pipeline（owner B8：#1286 与 #1237 合为一个 change，走完整流水线）；grill 已过，ledger B1–B9，开放项无
Tracking: #1286 与 #1237 都保持打开直到全部切片合并；Stage 5 建一个 Epic，子 issue 按 tasks.md 的切片（S1、S2、S3a、S3b）
B7 记录: #1237 正文要求对照用例进 uid-isolation job；owner 2026-10-16 裁定改为测试主机手工实测（一次性容器），用例默认跳过（环境变量门控），不改 CI、不加依赖
```
