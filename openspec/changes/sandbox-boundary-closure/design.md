# Design: sandbox-boundary-closure

## Context

owner 裁定见 proposal「Why」与下文「owner 的裁定」表（grill ledger B1–B9）。本节只记设计依赖的现状（读代码，`83c870f6`，2026-10-16；标「实测」处为本机 Node 24.13.1 上跑过）。

**沙箱根与启动**

- 启动今天不建 `SANDBOX_ROOT`：`server/src/app.ts:232-234` 的注释写明「Startup creates no sandbox directory」，由惰性点建根——`app.ts:234`（`createTemporaryWorkspace` 前的 `ensureSharedDir(runtime.sandboxRoot)`）、`server/src/workspaces/store.ts:176`、`:201`、`:366-368`（账号根与空间根）、`server/src/sessions/omp/process.ts:83-85`（cwd 是账号根时 `ensureSharedDir(ownerRoot)`）。三处都经 `server/src/core/sandbox/dirs.ts:14-33` 的 `ensureSharedDir`：逐级 `mkdir`，只对本次**新建**的分量 `chmod 0o2770`，既有分量不动；`dirs.ts:41-43` 的 `ensureOwnedDir(path, mode)` 是精确 mode 语义——非递归建出、`lstat` 必须是目录、属主必须是 `process.geteuid()`、不符则 chmod 并复查（`:58-97`）。
- `<state>/home` 是粘滞位先例：`server/src/sessions/omp/state-layout.ts:60` `OMP_HOME = 0o3770`；`ensureOmpStateLayout(stateDir)`（`:97-116`）先 `mkdirSync(stateDir, {recursive: true})`、取 `realpathSync.native`、对根调 `ensureOwnedDir(root, MANAGED)`，再逐项建表。
- uid 模式 = `config.ompUser !== undefined`：`server/src/agent-config.ts:115`（`OMP_USER` 存在才解析）、`:241-248`（格式、PATH、setpriv 校验）；`server/src/server.ts:138` 把它放进 `SessionRuntime`。
- 启动阶段是封闭枚举 `StartupStage`（`server.ts:292`）；失败行恰为 `{"event":"server_start_failed","reason":"<stage>"}`（`:305-306`，`emitStderrRecord`），`reason` 只取枚举值、不取 error 对象。阶段次序（`start()`，`:405-488`）：`db`（`:396` 初值）→ `app`（`:412`）→ `listen`（`:450-456`，`await` 主监听器）→ **同步**到 `state_layout`（`:465-466`，`:464` 注释：「主 listen resolve 之后到这里返回没有 `await`：主监听器受理的第一个请求到达时托管布局已在」）→ `preview_listen`（`:467-472`，`await`）→ `publishStarted`（`:479`，内含 `models_yml`、`host_overlay`、`preview_cache`、`publish`）。失败路径 `:480-487`：`releaseOwned` 后 `emitStartupFailed(owned.stage)`。
- 路径泄漏的哨兵模式：`server/test/server-startup-failure-reason.test.ts:306-311`（`PATH_SENTINEL`、`UPSTREAM_SENTINEL`、`root` 都不得出现在输出里）；`:334-336` 断言 `config` 失败后 `db`、`state`、`sandbox`、`preview-cache` 四个目录都不存在；`server/test/server-startup-omp-user.test.ts:122-127` 同（`OMP_USER` 模式、配置失败）。编译入口的测试夹具 `server/test/server-startup-helpers.ts:182-204` `compiledFixtureEnv`（`SANDBOX_ROOT: <root>/sandbox`，`:193`）、`:450` `denyChmodHook(targets)`（对给定路径的 `chmodSync` / `fchmodSync` 抛 `EPERM`，经 `requireHook` 注入子进程）。
- **成功启动之后断言沙箱根不存在的既有用例**（B4 下全部变假，进 D5 的封闭清单）：`server/test/server-startup-layout.test.ts:136`、`server/test/server-startup-private-state.test.ts:113`、`:196`、`server/test/server-startup-order.test.ts:135`；`server-startup-private-state.test.ts:155-157` 断言「既有沙箱根保持 `0o755`」（`EXISTING_DIR_MODE`，`:37`）。失败路径上的同类断言（`server-startup-model-id.test.ts:91` 配置失败、`server-startup-layout.test.ts:256` `state_layout` 失败、`server-startup-private-state.test.ts:206`、`:245` `db` 失败、`failure-reason:334`、`omp-user:127`）在 D1 的阶段位置下仍然为真，不改。
- `server/test/omp-process.test.ts:210-216` 断言 `spawnOmp` 冷启动时惰性建出的 `sandboxRoot` 是 `2770`——它直接调 `spawnOmp`，不经启动入口，T2 下不动。
- `server/test/sandbox-dirs.test.ts`（484 行）：`ensureSharedDir`（`:66-222`）、`ensureOwnedDir`（`:224-362`，`:336` 以 `it.skipIf(geteuid === 0)` 测「属别的 uid 的目录被拒」——它怎么造出别的 uid 的目录，开工核对时看清；`:347` 断言错误文本含路径与八进制 mode、不含环境值）、`ensureOwnedFile`（`:364-484`）。

**CI 证据（B7：不改 CI）**

- `.github/scripts/ci-uid-isolation.sh:92-97`：job 在 `RUNNER_TEMP` 下建 `SANDBOX_ROOT`，`chgrp workbuddy`、`chmod 2770`，属 runner uid；随后 `ci-compiled-server.sh smoke`（`.github/scripts/ci-compiled-server.sh:9-16`，`:10` 透传 `OMP_USER`，`:15-16` 建 `SANDBOX_ROOT/u1` 并拷夹具）以 `OMP_USER=omp` 起编译服务跑 `make smoke`。所以 S1 合入后该 job 的 smoke 阶段会走「根已在、属本 uid、缺粘滞位 → chmod 到 `3770`」这一支；chmod 失败会让启动失败、smoke 变红。收尾的 `check_omp_modes`（`:225-238`）只查 `OMP_STATE_DIR`，不查沙箱根的 mode；`scripts/test-ci-harness.sh` 钉住的是脚本里预置 `2770` 的那几行与 helper 的 `SANDBOX_ROOT` 行（`grep -o 'SANDBOX_ROOT[^\\]*'`、`chmod 2770` 两处核对），没有任何一处钉沙箱根启动后的 mode——证据等级是「失败可见、取值不断言」，不需要改脚本。
- `server/test/linux/uid-isolation.test.ts:104` 的门控 `describe.skipIf(process.platform !== "linux" || process.env.WORKBUDDY_UID_TEST !== "1")` 是 Linux-only 用例的既有写法；它用测试自有的 `2770` 沙箱目录直接走 `SessionRuntime`，不经启动入口，不受 S1 影响。

**读路由与读流**

- `server/src/workspaces/preview.ts:166-171` `openPreviewStream(absPath, limit)`（`limit === 0` 时返回空的二进制 `Readable`，否则 `createReadStream(absPath, {start: 0, end: limit - 1})`）、`:209-211` `openRangeStream(absPath, start, end)`——都按路径打开，没有 `O_NOFOLLOW` / `O_NONBLOCK`、不 `fstat`。`server/src/workspaces/range-send.ts:5-6` 头注释声明「nothing here checks either again」；`:24` 先 `parseRange(request.headers.range, size)`，416 时「no file is opened」（`:26-31`），HEAD 时给空流（`:42-46`），其余 `:47-49` 调两个 helper。
- `server/src/workspaces/rest.ts:201-227` `openRegularFile(absPath)`：`O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开；`ENOENT` / `ENOTDIR`（结构性消失）、`ELOOP`（末段是符号链接）、`ENXIO`（Linux 上的套接字）、`EOPNOTSUPP`（macOS 上的套接字，按 errno 数值比）→ `HttpError("not_found")`，其它错误原样抛；打开之后 `fstatSync(fd).isFile()` 不成立 → 关闭、`not_found`。`:198-199` 注释：只守住末段，中间分量被换成符号链接时 `open` 仍跟随。命名管道在 `O_RDONLY | O_NONBLOCK` 下**能立即打开**（没有写端也不阻塞、不报 `ENXIO`），靠 `fstat` 判出 `isFIFO` 后被拒——`server/test/workspaces-file-sniff.test.ts:469-482` 的用例正是这样（`descriptors` 恰一个、`elapsedMs < 1500`）。编排方 brief 里「FIFO 无写端时的 `ENXIO`」这一句与代码不符，按代码为准（见文末「待编排方确认」）。
- 调用处：`GET /api/workspaces/:id/file`（`rest.ts:366-400`）：`lstatExisting`（`:375-378`）→ 未知扩展名才经 `sniffedAsText`（`:233-242`，已用 `openRegularFile`）→ 音视频走 `sendFileRange`（`:385-392`，传 `absPath` 与 lstat 的 `size`）→ 其余 `openPreviewStream(absPath, preview.limit)`（`:398`）。`GET …/download`（`server/src/workspaces/rest-entries.ts:122-156`）：`lstat`（`:136-139`）→ **先**写 `file.download` 审计（`:140-147`，`detail.size` 取 lstat）→ 头 → `openPreviewStream(absPath, status.size)`（`:154`）。`/w/<token>/*`（`server/src/preview/app.ts:217-229`）：`locate()`（`:184-215`）做令牌、根、`resolve`、`lstat`（`:208-213`），再 `sendFileRange`。`/o/<token>/*` 的转出 PDF（`:296-307`）：`lstatExisting(outcome)` 不是文件 → 502 `FAILED_TEXT`（注释：「缓存文件刚被周期清理删掉：按转换失败答」），否则 `sendFileRange`；`pdf/` 目录是应用持有的 `0700`（office-preview「转换缓存」）。预览监听器的错误处理器（`:164-170`）把 `HttpError("not_found")` 答成 404 纯文本。`GET …/archive`（`server/src/workspaces/rest-archive.ts:104-123`）：`lstat` 作首道便宜拒绝，再 `openRegularFile`，大小取 `fstatSync(fd).size`（`:115-119`）——这就是 D4 要推广到四条读路由的形状。
- 按路径钉住读流的既有断言（D5 封闭清单的来源）：`server/test/workspaces-download.test.ts:84-87` `readStreamOpens(target)` 按 `createReadStream` 的路径参数计数（`:154`、`:164`、`:391` 使用）；`server/test/workspaces-file-range.test.ts:150-152` `streamsOpened()`（`:245`、`:335`、`:417`），`:246` 断言 416 时 `openSync` 一次未调；`:514-530` 从 `createReadStream` 的返回值取 `fd` 断言客户端中止后描述符被释放；`server/test/workspace-preview.test.ts:197-217` 直接以路径调 `openPreviewStream(emptyPath, 0)` 并检查 `createReadStream` 的 `end` 选项不为 `-1`。`server/test/workspace-file-helpers.ts:20-31` `spyBodyIo()` 已同时 spy `open`、`openSync`、`read`、`readSync`、`createReadStream`。
- 换入钩子的先例：`server/test/workspaces-file-sniff.test.ts:404-452`（包裹 `fs.openSync`：第一次对目标打开时 `rmSync` 它并换入 FIFO / 符号链接 / 目录，断言 404、零读取、描述符全部关闭、`createReadStream` 对目标零次、审计零行、FIFO 一例 `elapsedMs < 1500` 并由延迟写端兜底不挂死）；`server/test/workspaces-archive-route.test.ts:540-577` 同一模式。`/file` 的流路径、`/download`、`/w/`、`/o/` PDF 今天没有换入用例。
- `createReadStream(null, {fd, start, end, autoClose: true})` 在 Node 24.13.1 上可用（**实测**，本机：`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开、`fstat` 为普通文件、`start: 2, end: 5` 恰读出 4 字节、流 `close` 后描述符已关闭）。

**#1237 与 #1237 的测试**

- `server/src/workspaces/temp-dir-remove.ts`（171 行）：`:41-58` 校验账号根为绝对路径且名字匹配 `^tmp-[0-9a-f]{32}$`；`:77-111` `lstat` → `rename` 进 `<trash>/<16 字节 hex>` → 再 `lstat` → `rm(recursive)`；`EXDEV` → `:137-150` `removeInPlace`；所有失败只 `report`，不抛，`rm` 不带 `force`。没有挂载检测（仓库里只有 `snapshots.ts` 比 `dev`，其测试伪造 `dev`）。
- 路由在 `rm` 落定之后才答 204（`server/src/sessions/rest-metadata.ts:143-153`：`await deleter.deleteSession(...)` 后 `204`）。
- `server/test/session-delete-temp-workspace.test.ts` 783 行（硬上限 800，余 17 行）——FUSE 用例必须另开文件。`:510-540`「删除失败不影响响应」：把 `sub` 改成 `0500` 后删除，断言 `trash/<批次>` 下恰为 `["sub", "sub/deep.txt"]`（`:525`）；夹具 `TREE = ["notes.md", "sub", "sub/deep.txt"]`（`:72`，`:104-105` 写出），被 `:253`、`:290`、`:351`、`:410`、`:412` 等八处共用。Node `fs/promises` 的 `rm` 在 `_rmchildren` 里对同级子项并行发起、首个错误即回调（运行时源码），所以 `sub/deep.txt` 的 `EACCES` 可以先于 `notes.md` 的 `unlink` 完成而返回，`notes.md` 残留——结构性竞态；本机 APFS 0/800 未复现，ext4 未量；PR #1459（`test(harness)`，已合并）的 CI 上出现过一次红。
- 测试主机（被跟踪文本只称「测试主机」）：fuse3（`fusermount3` + `/dev/fuse`）与 docker 已备；仓库 `grep -rn "fusermount\|rclone\|sshfs\|/dev/fuse" server .github scripts` 为零——没有 FUSE 测试、没有 CI 步骤。

**规格里将变假的句子**（各自的 MODIFIED delta 见「规格影响」）

- `openspec/specs/http-service-skeleton/spec.md:17`（`reason` 的封闭枚举）、`:35-37`（失败阶段场景）、`:49-51`「完整装配路由与惰性根」（启动后 `SANDBOX_ROOT/u1` 不存在——仍真，但根现在存在）。
- `openspec/specs/sandbox-core/spec.md:36`「`SANDBOX_ROOT/<ownerId>` 与每个工作空间根 SHALL 经它创建」——根自身没有被写明；加一句排除。
- `openspec/specs/omp-uid-isolation/spec.md:47`「Under SANDBOX_ROOT, existing directory modes SHALL remain unchanged」、`:62-63`「existing sandbox modes are unchanged」——对根变假。`:61`「newly created sandbox path levels are 2770」仍真（T2）。`:98-99`「CI uid-isolation job」里 `chmod 2770` 是脚本行为，仍真，不改。
- `openspec/specs/omp-runtime/spec.md:315-316`、`:336`（`<state>/home` 的 `3770` 与粘滞位措辞）：对齐引用，不改。
- `openspec/specs/workspaces/spec.md:39`（`openPreviewStream(absPath, limit)` / `openRangeStream(absPath, start, end)` 的签名）、`:62-63`（流关闭场景）、`:137`（「目标不存在或不是普通文件 → 404」之后按路径打开）；`:275`「压缩包列表」已是描述符形状，不改。
- `openspec/specs/file-operations/spec.md:86-88`「下载」（审计在首字节之前；大小来自 lstat 的隐含）。
- `openspec/specs/preview-origin/spec.md:45`「预览监听器」（`/w/` 的打开）；`openspec/specs/office-preview/spec.md:105`「办公文档预览路由」（转出 PDF 的发送）。
- `openspec/specs/temporary-workspaces/spec.md:91-114`「临时空间目录的删除」（没有挂载规则）；挂载的定义对齐 `openspec/specs/workspace-snapshots/spec.md:39`（不跟随符号链接取得的 `dev` 与根的 `dev` 不同的目录，不区分文件系统类型）。

**文档里带着 #1286 / #1237 残余措辞的位置**（S3b 改为终态）

- `docs/adr/0010-dedicated-omp-uid.md:36`（「`SANDBOX_ROOT`、`OMP_STATE_DIR` 及其下目录 `2770`」）、`:104`（「`SANDBOX_ROOT` 一侧仍是 `2770`，不变」——变假）、`:114`（`state_layout` 排障行——加 `sandbox_root` 的一行）、`:122-124`（会话删除的 trash 残余——部署文档落点）、`:176-190`（临时空间目录删除的残余清单）。
- `docs/adr/0014-isolated-preview-origin.md:59`、`:61`、`:65-66`（#1286 表）、`:146-148`（恢复步骤里对 ① 的引用）、`:181-183`。
- `docs/architecture/system.md:267`、`:351`（`server_start_failed` 的排障行形状）、§9 部署一节。
- 源码头注释：`server/src/server.ts:31-38`、`server/src/workspaces/trash.ts:1-60`、`server/src/workspaces/rest-entries.ts:1-41`（移动路由的中间分量残余，保留，只改「#1286 stays open」的措辞）、`server/src/preview/app.ts:1-50`、`server/src/preview/office-cache.ts:31-40`、`server/src/workspaces/range-send.ts:1-7`、`server/src/workspaces/rest.ts:191-200`。
- `docs/acceptance/functional-checklist.md:217` FL-01 指向归档的 D22（归档不改；FL-01 是签字记录，原样保留）；现有最后一行 FL-37。

**文件行数**（800 行硬上限，`scripts/size-guard.sh`）：`server.ts` 711、`app.ts` 488、`agent-config.ts` 248、`dirs.ts` 97、`rest.ts` 521、`rest-entries.ts` 232、`rest-archive.ts` 126、`preview.ts` 246、`range-send.ts` 50、`temp-dir-remove.ts` 171、`preview/app.ts` 311、`state-layout.ts` 121；测试：`session-delete-temp-workspace` 783、`workspaces-file-range` 569、`workspaces-file-sniff` 565、`workspaces-download` 467、`workspaces-archive-route` 748、`preview-app` 618、`preview-office-route` 651、`server-startup-failure-reason` 357、`server-startup-omp-user` 160、`server-startup-private-state`（见开工核对）、`sandbox-dirs` 484、`linux/uid-isolation` 621、`server-startup-helpers.ts` 699、`workspace-preview` 306、`omp-process` 787。预算表见文末。

## Goals / Non-Goals

**Goals**

- `SANDBOX_ROOT` 在服务启动时存在、属应用 uid、带粘滞位（`3770`）：omp uid 不能再改名、删除或替换其下由应用建出的条目（`.trash`、账号根）；`OMP_USER` 模式下做不到就不启动，并给出阶段名。
- 四条读路由从「lstat 之后按路径 `createReadStream`」改为「不跟随、不阻塞地打开 → `fstat` 判普通文件并取大小 → 按描述符读」：换入的符号链接、命名管道、目录、套接字一律 404、零字节、描述符关闭；下载的审计行只为真正被打开的普通文件写。
- #1237：临时空间目录删除遇到活挂载的行为写进规格，由真实 FUSE 用例钉住（默认跳过，测试主机手工实测），残骸处置写进部署文档。
- 既有行为不变：惰性创建点仍建 `2770`；读路由对未被换入的文件逐字节同前；416 / HEAD / 空文件 / 截断 / 范围的语义同前。

**Non-Goals**

- 回收目录或 `<state>/trash` 的清扫器（B6：「不做清扫器」）。
- 挂载检测，或遇到挂载时拒绝删除、跳过挂载继续删（B6 的规则是「不跨越」而不是「识别」；`EBUSY` 就是边界）。
- 办公文档转换**输入**侧的加固——转换进程按路径读输入、文档内引用的资源（#1350）。
- 中间目录分量在 `resolve` 之后被换成符号链接的竞态（B1：书面残余；Node 没有 `*at` 系调用，闭合要换读文件的方式，不在本 change）。
- 为 FUSE 用例改 CI、加依赖、改 uid-isolation job（B7）。
- 同 uid 模式语义在 B3 之外的任何改变：同 uid 模式不因属主或 chmod 失败而拒绝启动。
- 移动路由、`moveToTrash` 源侧、快照遍历的同类中间分量残余（ADR-0010 / ADR-0014 已登记；本 change 只把因粘滞位而**不再成立**的条目划掉）。
- 批次或被移进 trash 的目录树内部、仍被 omp 进程持有句柄（cwd、目录 fd）时经相对路径换入的残余（ADR-0010:123 已接受）。
- 把 `.trash` 移出 `SANDBOX_ROOT`（issue 方案 C）或 `/proc/self/fd` 遍历（方案 B）：owner 取方案 A。

## Decisions

### owner 的裁定（已定，不是选项）

| # | 裁定 | 日期 | 落点 |
|---|---|---|---|
| B1 | #1286 有界闭合：`SANDBOX_ROOT` 加粘滞位；按路径读文件改为 `O_NOFOLLOW\|O_NONBLOCK` 打开后 `fstat` 判普通文件；中间分量被换成符号链接的 rename 竞态保留为书面残余；issue 关闭 | 2026-10-13 Q2 | D4、D5、D9、Non-Goals |
| B2 | 粘滞位缺失：启动时自动 chmod 补上（否决了「启动失败」） | Q3 | D1、D2 |
| B3 | 根不属应用 uid、无法 chmod：`OMP_USER` 模式启动失败并给出明确原因；同 uid 模式不检查、不纠正 | Q14 | D1、D2 |
| B4 | 启动时 `SANDBOX_ROOT` 不存在：启动时直接创建（`3770`）；配置阶段失败时仍什么都不创建（否决了「惰性创建点建根时带 sticky」） | 2026-10-16 | D1、D2、D3 |
| B5 | `fstat` 修在共享读流 helper（`openPreviewStream` / `openRangeStream`），`/file`、`/download`、`/w/`、`/o/` 转出 PDF 一并覆盖 | 2026-10-16 | D4 |
| B6 | #1237：真实 FUSE 对照用例（trash 路径 + EXDEV 原地路径，Node 24.13.1）；temporary-workspaces 加挂载规则；部署文档写「管理员先卸载再手工删除」；不做清扫器 | Q4 | D7、D9 |
| B7 | FUSE 用例只在测试主机手工实测（一次性容器）；默认跳过（环境变量门控）；结果写进 PR 与 ADR；不改 CI、不加依赖（否决了「进 CI uid-isolation job」） | 2026-10-16 | D7、D10 |
| B8 | #1286 与 #1237 合为一个 change；走完整 stage-change-pipeline | Q1/Q11 | proposal「流程记录」 |
| B9 | 顺带并入 `session-delete-temp-workspace.test.ts:511` 的断言竞态，最小修复 | 编排方（PR #1459 CI 红） | D8 |

编排方默认（事实/实现层，可被代码推翻；本设计核对后全部采用）：新阶段名 `sandbox_root`；根的目标 mode 精确 `0o3770`（与 `<state>/home` 先例一致、与 `ensureOwnedDir` 的精确语义一致，不动属组；owner 只拍了「补上 sticky 位」，`mode | 0o1000` 的另一种读法被否）；同 uid 模式下 chmod 失败只记日志不失败；被跟踪文本里测试主机只称「测试主机」。编排方 2026-10-16 的补充指令：`fstat` 是大小权威；uid-isolation job 作 chmod 分支的证据、不改脚本；部署文档加 `sandbox_root` 的排障行与升级前提；符号链接的根不另设失败模式、按 realpath 处理；proposal 记录 B7 对 #1237 正文的推翻。

### 起草者的技术决定

**D1 启动阶段 `sandbox_root`（B2、B3、B4，T1）。** `StartupStage` 加一个值 `sandbox_root`；`start()` 在 `ensureOmpStateLayout` **之后、`preview_listen` 之前**同步调用 `ensureSandboxRoot`（D2），即 `owned.stage = "sandbox_root"` 紧跟 `server.ts:466`。失败走既有 `catch`：`releaseOwned` 后 stderr 恰一行 `{"event":"server_start_failed","reason":"sandbox_root"}`，不带路径、不带原始错误（枚举值从 `owned.stage` 来，与其它阶段同一条路）。

- **为什么在这里。** `:464` 的不变量「主 listen resolve 之后到 `ensureOmpStateLayout` 返回之间没有 `await`」保证主监听器受理的第一个请求处理时托管布局已在；`ensureSandboxRoot` 是同步函数，紧接其后同样落在第一个处理体之前——惰性创建点（D3）全部在请求处理体或 spawn 里，所以生产里没有任何路径能在根建出之前到达它们。放在 `state_layout` 之后而不是之前，是为了保住今天「`db`、`app`、`listen`、`state_layout` 任一失败都不在 `SANDBOX_ROOT` 留下任何东西」：`server-startup-layout.test.ts:256`（`state_layout` 失败后沙箱不存在）、`server-startup-private-state.test.ts:206`、`:245`、`server-startup-model-id.test.ts:91`、`failure-reason:334`、`omp-user:127` 全部原样成立；需要改写的只剩 B4 本身推翻的「成功启动后沙箱根不存在」四处与「既有根保持 `0o755`」一处（D5）。
- **放弃的位置。** 放在 `listen` 之前（`:450` 前）：端口被占——最常见的运维错误——会留下一个刚建的根，`:256` 那条 `state_layout` 失败用例也要改写；放在 `publishStarted` 里：那里的失败阶段是 `models_yml` 等，且在预览监听器绑定之后，晚于必要。
- **同 uid 模式的记录。** B3 要求同 uid 模式「不检查、不纠正」，编排方默认「chmod 失败只记日志」。记录经既有受管 stderr writer（`emitStderrRecord`），恰一行 `{"event":"sandbox_root_unchanged"}`——只有 `event` 一个键，不带路径、不带 errno、不带 mode：原因只有「不属本 uid」与「chmod 没生效」两种，都要管理员到主机上看，键名本身已足够定位。它不是失败，启动继续；写失败按 `session_fault` 的既有规则吞掉。事件名与键集是起草者定的（「待编排方确认」）。
- **规格落点。** http-service-skeleton「服务启动与装配」（枚举、次序、记录行、「完整装配路由与惰性根」场景改为「根已在且 `3770`，`u1` 仍不存在」，失败阶段场景加一例：`SANDBOX_ROOT` 位置是一个普通文件 → `sandbox_root`，两种模式都失败，不需要特权就能造）。

**D2 `ensureSandboxRoot(path, {strict})`（B2、B3、B4，T1；编排方补充 4、5）。** 放在 `server/src/core/sandbox/dirs.ts`，与 `ensureSharedDir` / `ensureOwnedDir` 并列（同一文件、同一套不 chown / 不改 umask 的纪律），签名 `ensureSandboxRoot(configuredPath: string, options: {strict: boolean}): {root: string; outcome: "ok" | "unchanged"}`，`strict = config.ompUser !== undefined`。步骤照抄 `state-layout.ts:101-103`：

1. `mkdirSync(configuredPath, {recursive: true})`：缺失时建出它与缺失的父级，父级权限位不改（与 `<state>` 一致）。`mkdir` 对一个悬空符号链接返回 `EEXIST`，下一步 realpath 失败即整体失败。
2. `root = realpathSync.native(configuredPath)`：`SANDBOX_ROOT` 自身可以是运维放置的、指向目录的符号链接（与 `OMP_STATE_DIR` 同一既有部署形态；`workspaces/store.ts:139-141` 与 `temp-dir-remove.ts` 的账号根 realpath 校验也都按真实目录算）。建根、校正、属主检查全部作用于 `root`。不另设「根是符号链接 → 失败」的模式（编排方补充 4）；配置路径仍原样交给 `SessionRuntime` 与 store（argv / env 用配置值，与托管布局相同）。
3. `lstatSync(root).isDirectory()` 不成立（普通文件、设备等占着）→ 两种模式都抛：这不是 B3 说的「属主」问题，惰性点 `ensureSharedDir` 今天遇到它也抛（`dirs.ts:26-28`），启动时就失败只是把同一个失败提前。
4. `ensureOwnedDir(root, 0o3770)`——owner 检查（`stats.uid === process.geteuid()`）、精确 mode、chmod 后复查（内核静默丢掉 setgid 时失败：应用 uid 不在共享组里本来就是 ADR-0010 的部署前提）。`strict` 为真时它的抛出原样向上抛（启动失败 `sandbox_root`）；为假时捕获、返回 `outcome: "unchanged"`，由 `server.ts` 写 D1 的那一行，根的 mode 与属主原样留下。
5. 返回 `{root, outcome}`。`server.ts` 只用 `outcome`；`root` 返回是为了测试与日后复用，不改任何现有调用方传的路径。

- **为什么复用 `ensureOwnedDir` 而不另写 chmod。** 它已经是「本 uid 持有的目录、精确 mode、建时带位、复查」的唯一实现（sandbox-core「托管目录权限位」），`<state>/home` 的 `3770` 就是它建的；另写一份会复制属主判断与复查逻辑。代价是同 uid 模式下也走了一次 `lstat` 的属主比较——「不检查」在可观察行为上等于「检查了但不因此失败、不纠正」，与 B3 的目的（同 uid 部署不因根不属自己而拒绝启动）一致。
- **为什么精确 `3770` 而不是 `mode | 0o1000`。** 编排方补充 5：与先例和 `ensureOwnedDir` 语义一致。后果：同 uid 开发机上 `0o755` 的根会被收窄到 `3770`（`server-startup-private-state.test.ts:157` 的改写，D5）；`2770` 的部署只多一个粘滞位。
- **不动属组、不 chown。** 组归属由部署的 setgid 继承（ADR-0010）；根缺 setgid 时 `3770` 把它补上，与 `ensureSharedDir` 建根时的 `2770` 同义。
- **测试的 seam。** 单元：`sandbox-dirs.test.ts` 直接调 `ensureSandboxRoot`，覆盖冷建、`2770` → `3770`、`0755` → `3770`、再次调用不变、根是符号链接时作用于目标、位置是普通文件时两种模式都抛、属主不符（沿用 `:336` 的造法）在 strict 抛 / lenient 返回 `unchanged` 且 mode 不变、chmod 被拒（`vi.spyOn(fs, "chmodSync")`）在 strict 抛 / lenient `unchanged`。编译入口：`server-startup-failure-reason.test.ts` 加「`SANDBOX_ROOT` 位置是普通文件 → `sandbox_root`，输出不含根路径」；`server-startup-private-state.test.ts` 的既有冷启动与重启用例改断言根为 `3770`（D5）；同 uid 模式 chmod 被拒（`denyChmodHook([sandbox])`）→ 启动成功、stderr 恰一行 `sandbox_root_unchanged`、根 mode 不变；`OMP_USER` 模式的同一钩子（`server-startup-omp-user.test.ts` 的 `requireHook` 夹具，setpriv 以钩子伪装存在）→ `sandbox_root`。属主不符的 `OMP_USER` 模式失败没有非特权的编译入口造法，留在单元层；uid-isolation job 的 smoke 是「属本 uid、缺粘滞位 → chmod」分支的真栈证据（D10）。

**D3 惰性创建点不变（T2）。** `app.ts:234`、`store.ts:176/201/366-368`、`process.ts:83-85` 不改代码：它们仍对新建的每一级 `chmod 2770`。启动之后根已存在，`ensureSharedDir` 对已存在的分量不动（`dirs.ts:26-29`），所以生产里它们再也不会建到根这一级、也不会把 `3770` 改回去；`omp-process.test.ts:213` 直接调 `spawnOmp`、不经入口，断言的「惰性建出的根是 `2770`」仍是该函数的事实，不动。`createApp` 的测试装配（`withWorkspacesApp` 等）同样不经入口，继续靠惰性点。核对过的生产路径：三处惰性点分别在 `POST /api/sessions`（临时空间）、`POST /api/workspaces`、prompt 的 spawn 之后——都在请求处理体里，D1 的同步位置保证它们在根建出之后才可能运行。`app.ts:232-233` 的注释改为「启动已建出沙箱根（`server.ts` 的 `sandbox_root` 阶段）；这里只建账号根」。

**D4 读流的 fd 锚定（B1、B5，T3；编排方补充 1）。**

- **一个打开函数。** `openRegularFile` 从 `rest.ts:201-227` 移到新模块 `server/src/workspaces/regular-file.ts`，签名改为 `openRegularFile(absPath): {fd: number; size: number}`（`size` 取自同一次 `fstatSync(fd)`），errno 映射逐字保留：`ENOENT` / `ENOTDIR` → `not_found`（条目不在了）；`ELOOP` → `not_found`（末段是符号链接）；`ENXIO`（Linux）与 `EOPNOTSUPP`（macOS，按 errno 数值）→ `not_found`（末段是套接字）；其它 `open` 错误原样抛。打开成功后 `fstat` 不是普通文件（FIFO、目录、设备——FIFO 在 `O_RDONLY | O_NONBLOCK` 下会立即打开成功、不等写端，靠这一步拒绝）→ 关闭描述符、`not_found`。`rest.ts`（嗅探）、`rest-archive.ts` 改 import，行为不变。
- **两个 helper 改收描述符。** `openPreviewStream(file: {fd}, limit)`：`limit === 0` 时关闭 `fd`、返回空的二进制 `Readable`（零字节文件仍不开流，`X-Workbuddy-Size: 0` 语义不变）；否则 `createReadStream(null, {fd, start: 0, end: limit - 1, autoClose: true})`。`openRangeStream(file: {fd}, start, end)` → `createReadStream(null, {fd, start, end, autoClose: true})`。流结束、出错、被销毁时 `autoClose` 关闭描述符——`workspaces-file-range.test.ts:514` 的「客户端中止后描述符被释放」仍由原生 `Readable` 保证，只是测试取 fd 的办法换了（D5）。
- **`sendFileRange` 收 `{fd, size, headers, unsatisfiableHeaders}`。** 次序：调用方已 `openRegularFile` → `parseRange(range, size)`（`size` 是 `fstat` 的）→ 416 时**关闭 `fd`**、空体（不再是「不打开」，而是「打开过、没读、关了」）→ HEAD 时关闭 `fd`、给空流 → 否则把 `fd` 交给流。头注释改写：「调用方经沙箱 resolve、以 `openRegularFile` 打开并 `fstat` 过 `absPath`；这里不再查类型，`size` 是那次 `fstat` 的，描述符的所有权在这里移交给流或在 416 / HEAD 时关闭」。
- **`fstat` 是大小权威**（编排方补充 1）。`/file` 的分类（`classifyPreview(absPath, name, size, …)`）、文本上限与截断头、`Content-Length`、`Range` 区间、`/download` 的 `Content-Length` 与审计 `detail.size`、`/w/` 的 `Content-Length` 全部用打开那一刻的 `fstat.size`；`lstat` 的 `size` 不再被任何头或审计使用。`lstat` 之后、打开之前文件被截短或追加，响应与声明一致地按打开的 inode 走（场景写进 workspaces「文件预览」与 file-operations「下载」）。
- **`lstat` 保留为首道便宜拒绝。** 四条路由都保留今天的 `lstatExisting` 判「存在且普通文件」：它决定目录 / 缺失 / 非文件的 404 在**不打开任何东西**的情况下给出（与 `/archive` `rest-archive.ts:104` 的形状一致），`/w/` 与 `/o/` 共用的 `locate()` 还要给 `/o/` 的输入大小与文档上限用（`/o/` 的输入不由本进程打开，见 Non-Goals #1350）。描述符是类型与大小的权威，`lstat` 只是提前拒绝；`lstat` 与 `open` 之间的换入正是本决定要关的窗口。去掉 `lstat` 会让 `locate()` 分叉、让目录请求多开关一个描述符，换不来任何保证。
- **`/file` 的次序与描述符的归宿。** `lstat` → `openRegularFile` → 未知扩展名时从**同一个** `fd` `readSync` 前至多 8192 字节嗅探（不再按路径二次打开，`sniffedAsText` 改收 `fd`）→ `classifyPreview(absPath, name, fstat.size, …)`——它抛出 `preview_unsupported` / `preview_too_large` 时**关闭 `fd`** 再向上抛（零字节读出）→ 音视频 `sendFileRange({fd, size})`，其余 `openPreviewStream({fd}, limit)`。后果：已知扩展名的文件每次 200 请求恰一次同步打开（流的），没有按路径的异步打开；415 / 413 各打开一次又关闭。`workspaces-file-sniff.test.ts:198-220` 钉住的「已知扩展名零次 `openSync`、恰一次异步打开、415 一次都不打开」因此改写（D5），它守护的事实——已知扩展名**不被嗅探**（`sniffReads()` 为空）——原样保留。
- **`/download` 的次序。** `lstat` → `openRegularFile`（换入即 404、无审计行）→ `audit.emit({… detail: {path, size: fstat.size}})` → 审计抛错时**关闭描述符**、500、不发任何字节 → 头（`Content-Length` 取 `fstat.size`）→ `openPreviewStream({fd}, size)`。「发送首字节之前 SHALL emit 审计」保持；新增「打开与 `fstat` 先于审计」「被拒的目标没有 `file.download` 行」。
- **`/w/`。** `locate()` 不变；路由在它之后 `openRegularFile`，`not_found` 由既有错误处理器（`preview/app.ts:164-170`）答 404 纯文本（不回显令牌与路径，preview-origin「预览监听器」），再 `sendFileRange`。
- **`/o/` 转出的 PDF。** `:296-299` 的 `lstatExisting(outcome)` 保留，其后 `openRegularFile(outcome)`；打开失败（`not_found`）与 `lstat` 不是文件一样答 502 `FAILED_TEXT`（今天的语义：「缓存文件刚被周期清理删掉：按转换失败答」），不改成 404——持令牌方拿到的是「转换失败，请下载后查看」，与 `pdf/` 是应用私有 `0700` 目录、只有清理会删它的事实相符。状态码的取舍是起草者定的（「待编排方确认」）。
- **书面残余（B1）。** `resolve` / `lstat` 之后、`open` 之前，路径的**中间目录分量**被换成符号链接时 `open` 仍跟随它（`O_NOFOLLOW` 只管末段），读到的是空间外同名普通文件的内容；要关它得按目录描述符逐级 `openat`，Node 不提供。利用前提仍是 ADR-0010 的部署模型之外（以 omp uid 运行代码、卡准 `lstat` 与 `open` 之间的窗口、链接目标是应用 uid 可读的同名文件）。ADR-0014 的 #1286 表改为只剩这一条读侧残余（S3b）。
- **放弃的方案。** 只在路由层加 `fstat`、helper 不动：四条路由各写一份打开逻辑，`range-send.ts` 的「不再检查」头注释继续成立但不真；owner B5 选的是 helper 层。先 `open` 后去掉 `lstat`：见上。`O_PATH` / `/proc/self/fd` 重开：仅 Linux，开发机不可用。

**D5 封闭改写表（T4）。** 沿用 #910 / #915 的「通用纪律」第 3 种改法：既有断言钉住的正是被 owner 裁定推翻的旧行为时，改写为钉住新行为的反向断言，并在 PR 的偏离记录里引用该裁定。本 change 的清单：

1. **启动成功后 `SANDBOX_ROOT` 不存在 / 既有根保持原 mode**（B4、B2、编排方默认 `3770`）。
2. **读流按路径打开**（B1、B5）：`createReadStream(path, …)` 的路径参数、416 时 `openSync` 零次。
3. **「删除失败不影响响应」对残骸的精确内容断言**（B9）——不是反向断言，是把夹具收窄使断言不再有竞态（D8），列在这里只为封闭。

只有下表里的断言可以按第 3 种改法改写；新发现的停下来先补本表：

| 文件:行 | 钉住的旧行为 | 清单项 | 改写为 | 切片 |
|---|---|---|---|---|
| `server/test/server-startup-layout.test.ts:136` | 成功启动后 `<root>/sandbox` 不存在 | 1 | 存在、`mode & 0o7777 === 0o3770`、其下没有条目 | S1 |
| `server/test/server-startup-private-state.test.ts:113` | 同上（冷启动） | 1 | 同上 | S1 |
| `server/test/server-startup-private-state.test.ts:155-157` | 「既有沙箱根保持 `0o755`」 | 1 | 既有 `0o755` 的根被校正为 `0o3770`；`:161` 的「`u1` 不存在」不动 | S1 |
| `server/test/server-startup-private-state.test.ts:196` | 成功启动（`:memory:`）后沙箱不存在 | 1 | 存在且 `0o3770` | S1 |
| `server/test/server-startup-order.test.ts:135` | 成功启动后沙箱不存在 | 1 | 存在且 `0o3770` | S1 |
| `server/test/workspaces-download.test.ts:84-87`（`readStreamOpens`，用于 `:154`、`:164`） | 以 `createReadStream` 的路径参数计「为流打开的次数」 | 2 | 以 `openSync` 对目标路径的调用计数（同一个 `spyBodyIo`），期望值不变（1、2） | S2 |
| `server/test/workspaces-download.test.ts:391`（审计写入被拒的用例，describe 名「opens nothing」） | 审计失败时文件一次都没打开 | 2 | 文件被同步打开恰一次、描述符已关闭、零读取（D4：打开与 `fstat` 先于审计；file-operations「审计失败不发文件」改写后的 THEN）；describe 名随之改 | S2 |
| `server/test/workspaces-file-range.test.ts:150-152`（`streamsOpened`，用于 `:245`、`:335`、`:417`） | `createReadStream` 的路径参数列表为空 | 2 | `:417`（越界被沙箱拒绝）：`openSync` 对目标的调用列表为空，事实不变；`:335`（两次 HEAD，含 HEAD 416）：对目标恰两次同步打开、全部关闭、零读取 | S2 |
| `server/test/workspaces-file-range.test.ts:245-246` | 416 时不打开任何东西（`openSync` 零次） | 2 | 416 时对目标恰打开一次、零读取、描述符已关闭（D4 的 416 分支） | S2 |
| `server/test/workspaces-file-sniff.test.ts:207`、`:209`、`:212`、`:216` | 已知扩展名的文件零次 `openSync`、每个 200 恰一次按路径的异步打开（流的 `fs.open`）、415 的 `doc.pdf` 一次都不打开 | 2 | 每个 200 恰一次同步 `openSync`（流的）、零次按路径的异步打开；`doc.pdf` 同步打开一次又关闭、零读取；`:213` `sniffReads()` 为空与 `:220` LICENSE 恰一次打开不动 | S2 |
| `server/test/workspaces-file-range.test.ts:514-530` | 从 `createReadStream` 返回值取流的 `fd` | 2 | 从 `openSync` spy 的返回值取描述符（`workspaces-file-sniff.test.ts:430-433` 的取法），其余断言不动 | S2 |
| `server/test/workspace-preview.test.ts:197-217` | 以路径调 `openPreviewStream(emptyPath, 0)` | 2 | 自己 `openSync` 后以 `{fd}` 调；断言「不出现 `end: -1`」「空输出」「二进制模式」不动，另断言描述符已被关闭 | S2 |
| `server/test/session-delete-temp-workspace.test.ts:525` | 残骸恰为 `["sub", "sub/deep.txt"]`（夹具含同级 `notes.md`） | 3 | 该用例在删除前 `rmSync(join(temporary.dir, "notes.md"))`，断言不变（D8） | S3a |

不在表里、也不需要改写的同类断言：`server/test/omp-process.test.ts:213`（直接调 `spawnOmp`，D3）；全部失败路径上的「沙箱不存在」（Context 列出的六处）；`server/test/workspaces-file-sniff.test.ts` 与 `workspaces-archive-route.test.ts` 的换入用例（它们已经是描述符形状，`openRegularFile` 移模块后只改 import，断言不动——其中 `sniff:443-445` 断言 `createReadStream` 对目标零次，在 fd 设计下 `createReadStream` 的第一个参数是 `null`，该断言天然成立）；`workspace-preview.test.ts` 其余以路径调 `classifyPreview` 的用例（分类器不碰 IO，不变）。

**D6 换入用例与变异证据（T4）。** 换入钩子照抄 `workspaces-file-sniff.test.ts:404-452`：包裹 `fs.openSync`，第一次对目标打开时 `rmSync` 目标并换入，然后调真实的 `openSync`；断言 404（主站 JSON 信封 / 预览监听器纯文本）、零读取、描述符全部关闭、`createReadStream` 对目标零次（路径参数）且没有以该 fd 开流、审计零行、FIFO 一例在 1500ms 内返回（延迟写端兜底）。新文件 `server/test/workspaces-file-swap.test.ts`（`/file` 的文本流路径与音视频范围路径，各 FIFO / 符号链接 / 目录三例；加一例「`lstat` 之后文件被截短 → `Content-Length` 与字节按打开的 inode」）、`workspaces-download.test.ts` 扩写（三例换入 + 「换入后没有 `file.download` 审计行」+ 「审计抛错时描述符已关闭、无字节」+ 「大小按打开的 inode」）、新文件 `server/test/preview-app-swap.test.ts`（`/w/` 三例；`/o/` 的转出 PDF 用注入转换器替身，在替身返回路径与路由打开之间把该文件换成 FIFO / 符号链接 → 502 `FAILED_TEXT`、零读取、描述符关闭）。变异证据逐条做、逐条撤销：去掉 `O_NOFOLLOW` → 符号链接换入例判红；去掉 `fstat` 的普通文件判定 → FIFO 与目录换入例判红；`/download` 把审计挪回打开之前 → 「换入后无审计行」判红；`sendFileRange` 416 分支不关描述符 → 416 用例的「描述符已关闭」判红；`/file` 在分类抛出时不关描述符 → `workspaces-file-sniff.test.ts` 改写后的「`doc.pdf` 打开一次又关闭」判红；`Content-Length` 改回 `lstat` 的大小 → 截短用例判红。

**D7 #1237 挂载规则与 FUSE 用例（B6、B7，T5）。**

- **规格句子**（temporary-workspaces「临时空间目录的删除」MODIFIED）：递归删除 SHALL NOT 跨越挂载点——挂载点的定义同 workspace-snapshots:39（不跟随符号链接取得的 `dev` 与被删目录的 `dev` 不同的目录，不区分文件系统类型）；目录内有活挂载时，递归删除在该挂载点失败（Linux 对挂载点的 `rmdir` 是 `EBUSY`），挂载内的任何文件 SHALL NOT 被读取、修改或删除，挂载点之外已删的部分不恢复，残骸连同挂载留在 `<state>/trash/<随机名>/…`（trash 路径）或原地（EXDEV 路径），`DELETE` 仍 204，错误通道恰报告一次；宿主不卸载、不清扫、不重试，残骸由管理员卸载后手工删除。规格不写「Node 如何实现」——它写的是边界，与 #1237 在 Node 22 上观察到的一致，不多也不少。
- **为什么是 `EBUSY`、为什么不检测。** `rm(recursive)` 先对目录 `rmdir`，只有 `ENOTEMPTY` / `EEXIST` / `EPERM` 才列举子项（运行时源码 `rimraf.js` 的 `_rmdir`）；挂载点的 `rmdir` 是 `EBUSY`，直接作为错误上抛，不进入挂载。这是 issue 实测（Node 22）与源码一致的解释。要在它之外「检测后跳过」或「拒绝删除」都是 B6 之外的新行为（Non-Goals）。
- **用例文件** `server/test/linux/temp-dir-remove-fuse.test.ts`（新）：门控 `describe.skipIf(process.platform !== "linux" || process.env.WORKBUDDY_FUSE_TEST !== "1")`（`uid-isolation.test.ts:104` 的写法）；opt-in 之后缺前提**失败而不是再 skip**（omp-uid-isolation「Linux 隔离证明」的纪律）：`bindfs` 与 `fusermount3` 在 PATH、`/dev/fuse` 可用、`WORKBUDDY_FUSE_ALT_FS_DIR` 指向另一文件系统上的可写目录（EXDEV 用；容器里一个 tmpfs 挂载即可）。seam 取 `removeTemporaryWorkspaceDir`（模块公共边界）：`DELETE` 路由的 204 与「失败只报告」已被 `session-delete-temp-workspace.test.ts` 钉住，这里只证明文件系统边界；不起 HTTP、不起 omp。两例：
  1. trash 路径：账号根与 `<state>/trash` 同一文件系统；`tmp-<id>` 内有本地文件、一个空目录 `mnt`，用 `bindfs` 把测试自有的源目录（含文件）挂到 `mnt`；删除后断言：源目录字节不变、`mnt` 仍是挂载（`/proc/self/mountinfo` 里有）、`tmp-<id>` 已不在账号根、`<state>/trash` 下恰一个随机名目录且 `mnt` 在其中、本地文件已删、`report` 恰一次且 `code === "EBUSY"`；随后 `fusermount3 -u` 卸载并清理。
  2. EXDEV 原地路径：`<state>/trash` 放在 `WORKBUDDY_FUSE_ALT_FS_DIR` 下；同样的树；断言 `tmp-<id>` 仍在账号根（原地）、只剩 `mnt` 与挂载、源目录字节不变、`report` 恰一次 `EBUSY`。
  用例自己建挂载、自己卸载（`afterEach` 兜底 `fusermount3 -u`，失败则测试失败，不吞）。
- **实测与两种结果（B7）。** 一个 tasks 任务在测试主机上以一次性容器（Node 24.13.1 官方 Linux 构建、安装 `bindfs` 与 fuse3、`--device /dev/fuse --cap-add SYS_ADMIN`、`--tmpfs` 一块作另一文件系统）运行该文件，结果表（两例各自的 `report` errno、挂载是否仍在、源目录校验和、trash / 原地的残骸清单）写进 PR 与 ADR-0010 补充。两种结果都如实记录：(a) 两例绿——规格句子即 Node 24.13.1 上的事实，#1237 关闭；(b) 任一例红——最重要的一种红是「`rm` 进入了挂载、源目录有文件被删」（意味着 Node 24 的 `rm` 不再先 `rmdir`）：**停下报告，不改规格、不改产品代码**，交 owner 重开分支（B6 的「不做检测」与 B7 都要重议）；其它红（例如 errno 不是 `EBUSY` 而是 `EPERM`、挂载被连根拔掉）同样停下报告。用例不改成绿、不加 skip。证据等级在 PR 与 ADR 里逐项标「实测」；本地 macOS 上该文件恒 skip，CI 上恒 skip（无 FUSE、无 opt-in）。
- **部署文档**（S3b）：ADR-0010 补充一节与 `system.md` 部署一节写「`<state>/trash` 与账号根下带挂载的残骸：先 `fusermount3 -u <挂载点>`（或对应卸载命令），再以应用 uid 手工删除；宿主不清扫；残骸不被任何行引用」。

**D8 B9 的最小修复。** `session-delete-temp-workspace.test.ts:510-540` 只改这一个用例：在 `chmodSync(sub, 0o500)` 之前 `rmSync(join(temporary.dir, "notes.md"))`，使 `sub` 成为唯一的顶层条目——`rm` 的并行子项只剩一个，首错即返回时没有别的同级 `unlink` 在途，`:525` 的精确断言不再有竞态。不改共用的 `TREE` 夹具（八处使用），不加轮询（轮询掩盖的是同一个竞态），不改产品代码（产品里「部分失败、残骸留在 trash」的语义正确，只是测试对残骸形状的断言过严）。PR 注记：PR #1459 的 CI 红是该竞态的一次观测，本机 APFS 0/800。

**D9 文档与残余登记（S3b）。**

- **ADR-0010**：补充一节「2026-10-16 #1286 有界闭合」：B2/B3/B4 的裁定与 `sandbox_root` 阶段；排障行 `{"event":"server_start_failed","reason":"sandbox_root"}` 与补救（把根 `chown` 给应用 uid；或升级前预建为应用 uid 持有的 `3770`；应用 uid 须在共享组里）；同 uid 模式的 `sandbox_root_unchanged`；`.trash` 与账号根不再能被 omp uid 改名或替换（#1286 ① 的无竞态收编因此不再成立）；#1237 的 FUSE 实测结果表与残骸处置。原文里陈述现状为事实、现已为假的句子就地订正并注明日期：`:36`（「及其下目录 `2770`」→ 根 `3770`、其下 `2770`）、`:104`（「`SANDBOX_ROOT` 一侧仍是 `2770`，不变」→ 根 `3770`）、`:122-124` 与 `:184-185` 的残骸句加「管理员先卸载再删」。其余历史记录不动。
- **ADR-0014** `:59`（父目录可写的代价 → 粘滞位之后 omp 只能在根下**新建**、不能改名删除应用的条目）、`:61`、`:65-66`（#1286 表：① 划为已闭合、读路由四条划为已闭合，剩「中间分量」一条读侧残余与移动 / `moveToTrash` 源侧残余）、`:146-148`（恢复步骤里对 ① 的提醒改为「粘滞位之后 `.trash` 不会被换走；mode 不符的既有目录仍会被校正」）、`:181-183` 不变。
- **system.md** 部署一节：`sandbox_root` 的排障行与补救（与 ADR 同文）、「`SANDBOX_ROOT` 由启动建出并保持 `3770`」、带挂载残骸的手工清理。
- **源码头注释**：`server.ts:34-38`（残余登记改为「`sweep` 的 `.trash` 换入与四条读路由的末段换入已闭合（本 change）；`clearWork` 的 `work/` 与中间分量残余仍在」）、`trash.ts:18-60`（删去「`SANDBOX_ROOT` 无粘滞位」前提下的三段推演，保留批次内部句柄残余与源侧中间分量残余）、`rest-entries.ts:8-9`（「#1286 stays open」→ 「#1286 已有界闭合，移动路由的中间分量残余按 B1 保留」）、`preview/app.ts` 头（`/w/` 与 `/o/` PDF 的末段换入已闭合；`/o/` 输入侧仍是 #1350）、`office-cache.ts:36-40` 不变（`work/` 不在 `SANDBOX_ROOT` 下）、`range-send.ts:1-7` 与 `rest.ts:191-200` 的改写在 S2。
- **验收清单**：FL-01 是 2026-10-12 那次交付的签字记录，原样保留；新增 `FL-38`「阅读本 change 归档后 design D4 的『书面残余』一段与 ADR-0010 的补充一节；确认知悉：#1286 的粘滞位与读路由末段已闭合，中间目录分量的竞态作为书面残余保留，带挂载的临时空间残骸由管理员卸载后手工删除」，结论 `待签`（四列格式由 `web/test/functional-checklist.test.ts` 守卫）。是否加行是起草者定的（「待编排方确认」）。
- **关闭**：S3b 合并后关闭 #1286 与 #1237，关闭评论各引用本 change 的归档路径与实测结果。

**D10 CI 证据的等级（B7）。** uid-isolation job 不改：它预置的 `SANDBOX_ROOT`（`2770`、属 runner uid、共享组）在 S1 合入后由 `make smoke` 阶段的编译服务校正为 `3770`，chmod 失败即启动失败、job 红——「失败可见」；job 没有任何一步断言沙箱根启动后的 mode（`check_omp_modes` 只看 `OMP_STATE_DIR`；`test-ci-harness.sh` 只钉预置行）——「取值不断言」。这是 S1 chmod 分支在真实 uid 分离 Linux 上的旁证，不是对照用例；真正的断言在单元与编译入口测试（D2）。给它加一行 `stat` 断言是 CI 改动，B7 不做。

**D11 关键路径与白盒（AGENTS.md「沙箱与文件边界」）。** 每个切片都触及沙箱权限位或文件打开，**每个切片的 PR 都请求人工白盒审查**，审查清单（owner 必读的每一处权限 / 打开调用）：

- S1：`dirs.ts` 新函数全部（`mkdirSync` 递归、`realpathSync.native`、`lstatSync`、`ensureOwnedDir(root, 0o3770)` 调用与 strict / lenient 分支）；`server.ts` 的阶段位置（`:465-467` 之间）与 `sandbox_root_unchanged` 的写出；`app.ts:232-234` 注释。
- S2：`regular-file.ts` 的 `openSync` 标志位与 errno 表、`fstatSync` 判定与关闭；`preview.ts` 两个 helper 的 `createReadStream(null, {fd, …, autoClose: true})`；`range-send.ts` 的 416 / HEAD 关闭；`rest.ts` `/file` 的 `lstat → open → classify → send` 次序；`rest-entries.ts` `/download` 的 `open → audit → headers → send` 与审计抛错关闭；`preview/app.ts` `/w/` 的打开与 `/o/` PDF 的 502 映射。
- S3a：`temp-dir-remove.ts` 不改；审查 FUSE 用例的挂载 / 卸载与断言（源目录不变、挂载仍在）和 B9 的夹具收窄。
- S3b：无代码；审查 ADR 与头注释的措辞是否与 D4「书面残余」一致。

**D12 行数预算。** 见文末表。`rest.ts` 因 `openRegularFile` 移出净减；`range-send.ts` 50 → ≤ 80；`preview.ts` 246 → ≤ 260；`dirs.ts` 97 → ≤ 150；`server.ts` 711 → ≤ 730；测试新例进新文件，既有文件只做 D5 的改写与 `/download` 的扩写（`workspaces-download.test.ts` 467 → ≤ 640）。

### 通用纪律（沿用 #910 / #915 并扩展；tasks.md 各组照此执行）

- **合入门槛。** 每个 PR 合入后 `make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿，主干可运行。
- **永远不打真实模型端点。** 单测、冒烟、走查一律打假上游；本 change 的实测（FUSE）不涉及模型。
- **证据等级严格分开、不混写**：「实测」= 跑过并观察到（注明平台、Node 版本、文件系统）；「钩子辅助复现」= 包裹 `fs.openSync` / `lstatSync` 把窗口撑开之后经真实处理器得到，不是自然竞态；「读代码推出」= 未跑。PR、ADR、头注释里每条结论都带其一。
- **公开仓库卫生。** 测试主机在任何被跟踪文件（含 PR 正文、ADR、tasks、测试注释）里只称「测试主机」：不出现地址、登录名、密钥、容器名以外的任何标识；实测命令以容器内相对形式给出。
- **新逻辑进新模块，行数有预算**（D12 与文末表）。`scripts/size-guard.sh` 是硬门槛，不调阈值；每个切片在 PR 里写明预算表里被它改到的文件改动前后的行数。
- **行号核对。** 本文与 tasks 里的 `文件:行` 是在 `83c870f6` 上读的。每组开工先重跑该组第一个任务的核对；有出入，先改本 change 的 design 与该组任务，再继续。
- **既有断言不删不削弱。** 因本 change 而变化的既有断言，在 PR 的偏离记录里逐条列出旧 → 新。只允许四种改法：
  1. 改为「逐字节相等」；
  2. 在换入钩子或注入时钟下改为确定次数；
  3. 钉住的正是 D5 封闭清单里的旧行为时，改写为钉住新行为的反向断言，并引用该裁定；只限 D5 表里列出的断言；
  4. **换接缝**：helper 的形参由路径改为描述符时，调用处与 spy 的对象从 `createReadStream(path)` 换成 `openSync(path)` / 描述符，断言的事实（打开几次、读了多少、关没关）不变——D5 表第 2 项各行就是这种改法，同样逐条列进偏离记录。
  实现中发现 D5 表外的断言需要第 3 种改法，先停下更新 D5，不自行扩大。
- **不实现 Non-Goals 与「Not yet specified」。**
- **CI 文件不改。** B7；若某个切片发现非改 `.github/**` 或 `scripts/test-ci-harness.sh` 不可，停下报告，不自行改。
- **白盒。** 每个切片在 PR 里请求白盒审查（D11），PR 正文贴出该切片的审查清单。
- `Suggested fixture level` 只用 `none | compact | expanded`。

## 规格影响

- **改**（MODIFIED）：
  - http-service-skeleton「服务启动与装配」：枚举加 `sandbox_root`（在 `state_layout` 之后）；阶段步骤一句；同 uid 模式的 `sandbox_root_unchanged` 记录；「启动失败记录带失败阶段」加一例；「完整装配路由与惰性根」改 THEN。
  - sandbox-core「共享目录权限位」：加「`SANDBOX_ROOT` 自身不经它，由「沙箱根目录」在启动时建立与校正」。
  - omp-uid-isolation「自有状态不对组可读」：「Under SANDBOX_ROOT」一句改为「根以下」；「共享目录创建与兼容」场景的「existing sandbox modes are unchanged」改为「根以下不变、根为 `3770`」。
  - workspaces「预览分类元数据与有界字节流」（两个 helper 的签名与 `autoClose`、「流关闭和错误」场景）、「文件预览」（打开规则、换入即 404 且不读、大小按打开的 inode；新增两个场景）。
  - file-operations「下载」（打开与 `fstat` 先于审计、被拒无审计行、`detail.size` 与 `Content-Length` 按描述符；新增场景）。
  - preview-origin「预览监听器」（`/w/` 的打开规则；新增场景）。
  - office-preview「办公文档预览路由」（转出 PDF 经描述符发送、换入即 502；新增场景）。
  - temporary-workspaces「临时空间目录的删除」（挂载规则、残骸处置、门控的 FUSE 用例；新增场景）。
- **加**（ADDED）：sandbox-core「沙箱根目录」（`ensureSandboxRoot` 两种模式、realpath、精确 `3770`、不 chown、不改 umask）。
- **仍成立、不改**：
  - omp-uid-isolation「共享目录创建与兼容」里「newly created sandbox path levels are 2770」（根以下，D3）；「CI uid-isolation job」里脚本的 `chmod 2770`（脚本行为不变，D10）；「Linux 隔离证明」的自有 `2770` 沙箱目录（不经入口）。
  - omp-runtime「OMP_STATE_DIR 托管布局」：`<state>/home` 的 `3770` 与粘滞位措辞是本 change 的先例，不改。
  - workspaces「压缩包列表」：已是描述符形状；`openRegularFile` 移模块不改行为。
  - workspaces「工作空间 store 与惰性目录事务」「列表与创建」：账号根与空间根仍 `2770`。
  - file-operations「删除到回收目录」「回收目录的保留与清理」：四级 `ensureOwnedDir(…, 0o700)` 与 `sweep` 的逐级校验不改；「`SANDBOX_ROOT` 对 omp uid 组可写，它可以抢先放一个名为 `.trash` 的符号链接或自己的目录」仍真（新建仍可，粘滞位挡的是改名与删除），校验仍必要。
  - workspace-snapshots「快照内容规则」的挂载定义被 temporary-workspaces 引用，不改。
  - http-service-skeleton「Shared agent module assembly」：`createApp` 仍以 `runtime.sandboxRoot` 与 canonical `ensureSharedDir` 装配 store。

## Risks / Trade-offs

- **[既有 `OMP_USER` 部署的根不属应用 uid]** → 升级后启动失败 `sandbox_root`（B3 的裁定）。缓解：proposal Impact 与 ADR-0010 / system.md 的补救行（`chown` 给应用 uid，或预建 `3770`）；失败行不带路径，排障靠文档里的阶段名对照表。
- **[网络文件系统上的 chmod]** → `SANDBOX_ROOT` 在 NFS / SMB 上时 chmod 可能被拒或粘滞位被静默丢掉（`ensureOwnedDir` 的复查会抓住静默丢失）：`OMP_USER` 模式启动失败，同 uid 模式一行记录后继续、根没有粘滞位、#1286 ① 的保护不成立。接受：ADR-0010 的部署模型本就要求沙箱根在本地文件系统（`rename` 进 `.trash` 不跨文件系统的前提），文档写明。
- **[同 uid 开发机的根被收窄]** → `0o755` 的根变 `3770`，`other` 位消失；开发机上只有应用进程访问它。接受（编排方默认的精确 mode）。
- **[hosted runner 没有 FUSE]** → 新用例在 CI 恒 skip；它不是 CI 的保证，而是测试主机上的一次实测加一个可重跑的文件。B7 的取舍；ADR 记录实测日期、Node 版本与容器形态，升级 Node 时须重跑（tasks 写明）。
- **[Node 24 的 `rm` 若进入挂载]** → 实测会把 bindfs 源目录里的文件删掉（源目录是测试自有的，不碰别的）。D7 规定这是停下报告的结果，不是改规格或加检测的理由。
- **[`O_NONBLOCK` 在非 Linux 开发机]** → macOS 上普通文件读不受 `O_NONBLOCK` 影响（嗅探与 `/archive` 已在用）；套接字是 `EOPNOTSUPP` 而不是 `ENXIO`（按 errno 数值映射，`rest.ts:211-212` 已处理）；FIFO 在两种平台都能立即打开、由 `fstat` 拒绝。接受：既有 errno 表原样复用。
- **[416 现在会打开一次文件]** → 多一次 `open` / `close`（毫秒级）；换来 `size` 的单一来源。接受。
- **[`/download` 审计抛错时的描述符]** → 必须在 500 之前关闭；用 `try / catch` 包住 `emit`，测试钉住「描述符已关闭」。
- **[`createReadStream(null, {fd})` 的 `fs` spy]** → 测试里 `vi.spyOn(fs, "createReadStream")` 看到的路径参数恒为 `null`；按路径计数的 spy 全部改成 `openSync`（D5）。
- **[中间分量残余仍在]** → 读路由与 `moveToTrash` 源侧的中间目录被换成符号链接的竞态不闭合（B1）。写进 ADR-0014 表与 FL-38。
- **[B9 的修复是收窄夹具]** → 该用例不再覆盖「多个同级条目中一个失败」的残骸形状；产品语义（部分失败、残骸留在 trash）由其余断言（`:535-538`）继续钉住。接受。
- **[FUSE 用例在 opt-in 下的清理]** → 卸载失败会留下挂载让容器目录删不掉；用例在 `afterEach` 卸载并把失败抛出；一次性容器销毁时随容器消失。

## Migration Plan

- 切片次序：S1 与 S2 互不依赖，可并行；S3a（FUSE 用例 + B9 + temporary-workspaces 规格）不依赖任何切片；S3b（文档、ADR、头注释、验收行、关闭 issue）← S1、S2、S3a（终态措辞与实测结果都要先落地）。
- **部署**（随 S1 发布）：`OMP_USER` 模式部署在升级前核对 `SANDBOX_ROOT`（realpath）属应用 uid、应用 uid 在共享组；不符则 `chown <app-uid> <root>`（不动属组），或 `install -d -m 3770 -o <app-uid> -g <group> <root>`。同 uid 部署无动作。回滚到旧版本：根上的粘滞位无害（旧代码不检查也不改既有分量），可留着。
- S2 无部署动作；行为差异只在被换入的目标（旧版读链接目标或挂住，新版 404）与 416 多一次打开。
- S3a / S3b 无部署动作；运维文档新增的手工步骤只在出现带挂载的残骸时用到。

## Not yet specified

无。粘滞位、启动阶段、打开规则、挂载规则与残骸处置都已写进规格；FUSE 实测是一个两支都写定的任务（D7），不是雾。可能的后续（`/proc/self/fd` 逐级 `openat` 以关中间分量残余、#1350 的转换输入、给 uid-isolation job 加沙箱根 mode 断言）都在 B1 / B7 划出的范围之外，有需要另开 issue。

## 待编排方确认

B1–B9 与编排方 T1–T8、补充 1–6 之外由起草者决定的事项：

1. **同 uid 模式的记录行**：`{"event":"sandbox_root_unchanged"}`，只有 `event` 一个键，经受管 stderr writer，不是失败（D1）。事件名与「不带 reason」是起草者定的。
2. **阶段位置**：`state_layout` 之后、`preview_listen` 之前（D1），而不是 `listen` 之前；理由是保住全部既有失败路径的「不留沙箱」断言。
3. **`/o/` 转出 PDF 在打开失败时的状态码**：保持 502 `FAILED_TEXT`（D4），不改成 404。
4. **`lstat` 保留为首道拒绝、`fstat` 为权威**（D4），不删 `lstat`。
5. **FUSE 用例的前提变量**：`WORKBUDDY_FUSE_TEST=1` 门控，`WORKBUDDY_FUSE_ALT_FS_DIR` 给 EXDEV 用的另一文件系统目录；FUSE 工具取 `bindfs`（最轻；rclone 本地后端是备选，只在 `bindfs` 不可装时换）（D7）。
6. **验收清单新增 FL-38**（D9），FL-01 不动。
7. **ADR-0010 的就地订正范围**：只订正陈述现状为事实的四处（`:36`、`:104`、`:122-124`、`:184-185`），其余历史记录不动（D9）。
8. **brief 里一处与代码不符的事实**：「`O_NONBLOCK` 下无写端的 FIFO 报 `ENXIO`」——`rest.ts:196-197` 与 `workspaces-file-sniff.test.ts:479-481` 表明 FIFO 会打开成功、靠 `fstat` 拒绝；`ENXIO` / `EOPNOTSUPP` 是套接字。D4 按代码写。
9. **`ensureSandboxRoot` 放 `dirs.ts`** 而非新模块（97 → ≤ 150 行，与两个姊妹函数同一纪律）。
10. **415 / 413 现在会把文件打开一次再关闭**（D4）：`fstat` 作大小权威（编排方补充 1）要求先打开；另一种做法——已知扩展名按 `lstat` 大小先拒绝再打开——会让大小有两个来源。workspaces「预览分类元数据与有界字节流」的「在打开正文之前抛出」改为「在读出任何正文字节之前抛出」。
11. **任务 3.6 的执行者**：FUSE 实测要在测试主机上开容器，实现子代理不得接触远端主机，所以由编排方 / owner 手工执行；子代理只交付用例文件与结果表模板（tasks 3.6）。

## Sketch seams under test

- **`ensureSandboxRoot`（新，`core/sandbox/dirs.ts`，真实临时目录）**：冷建、`2770` / `0755` → `3770`、幂等、realpath、非目录、属主不符与 chmod 被拒在两种模式下的分支。权限位与属主只有在真实文件系统上才有意义；单测最便宜，也是唯一能注入「属主不符」的地方（沿用 `sandbox-dirs.test.ts:336` 的造法）。
- **编译入口 + `requireHook`（既有，`server-startup-*.test.ts`）**：阶段名 `sandbox_root`、输出不含路径、同 uid 模式的一行记录、既有根被校正为 `3770`、配置失败不建根。这是启动契约的最高接缝。
- **`openRegularFile` + 两个 helper + `sendFileRange`（`workspaces/`，经 `app.inject` 的真实路由，换入钩子包裹 `fs.openSync`）**：四条路由的换入、416 / HEAD 的关闭、大小按打开的 inode、`/download` 的审计次序。换入只能在 `open` 那一刻确定地造出来（`workspaces-file-sniff.test.ts` 同一 seam）。
- **`removeTemporaryWorkspaceDir`（既有模块边界，真实 FUSE，opt-in）**：挂载不被跨越、残骸位置、`report` 恰一次 `EBUSY`。只有真实挂载能证明 `EBUSY` 边界；HTTP 层的 204 已由既有用例钉住，不重复。
- **uid-isolation job 的 `make smoke`（既有，不改）**：chmod 分支在真实 uid 分离 Linux 上「失败可见」（D10）。

## 行数预算

| 文件 | 现在 | 预计合入后上限 | 改动的切片 |
|---|---|---|---|
| `server/src/core/sandbox/dirs.ts` | 97 | ≤ 150 | S1 |
| `server/src/server.ts` | 711 | ≤ 730 | S1 |
| `server/src/app.ts` | 488 | ≤ 490（只改注释） | S1 |
| `server/src/workspaces/regular-file.ts`（新） | — | ≤ 80 | S2 |
| `server/src/workspaces/rest.ts` | 521 | ≤ 500（`openRegularFile` 移出） | S2 |
| `server/src/workspaces/rest-entries.ts` | 232 | ≤ 250 | S2、S3b（头注释） |
| `server/src/workspaces/rest-archive.ts` | 126 | ≤ 128（只改 import） | S2 |
| `server/src/workspaces/preview.ts` | 246 | ≤ 260 | S2 |
| `server/src/workspaces/range-send.ts` | 50 | ≤ 80 | S2 |
| `server/src/preview/app.ts` | 311 | ≤ 330 | S2、S3b（头注释） |
| `server/src/workspaces/temp-dir-remove.ts` | 171 | 不改 | — |
| `server/src/workspaces/trash.ts` | — | 只改头注释，净减 | S3b |
| `server/test/sandbox-dirs.test.ts` | 484 | ≤ 620 | S1 |
| `server/test/server-startup-failure-reason.test.ts` | 357 | ≤ 420 | S1 |
| `server/test/server-startup-private-state.test.ts` | 见核对 | ≤ 800；超出则新例进新文件 `server-startup-sandbox-root.test.ts` | S1 |
| `server/test/workspaces-file-swap.test.ts`（新） | — | ≤ 400 | S2 |
| `server/test/workspaces-download.test.ts` | 467 | ≤ 640 | S2 |
| `server/test/workspaces-file-range.test.ts` | 569 | ≤ 580（只做 D5 改写） | S2 |
| `server/test/workspace-preview.test.ts` | 306 | ≤ 320 | S2 |
| `server/test/preview-app-swap.test.ts`（新） | — | ≤ 350 | S2 |
| `server/test/linux/temp-dir-remove-fuse.test.ts`（新） | — | ≤ 300 | S3a |
| `server/test/session-delete-temp-workspace.test.ts` | 783 | ≤ 785（一行 `rmSync`） | S3a |

## Traceability

| 来源 | 落点 |
|---|---|
| B1 | D4、D5、D9、Non-Goals；workspaces / file-operations / preview-origin / office-preview MODIFIED；tasks S2、S3b |
| B2、B3、B4 | D1、D2、D3；http-service-skeleton、sandbox-core、omp-uid-isolation；tasks S1 |
| B5 | D4；tasks S2 |
| B6 | D7、D9；temporary-workspaces MODIFIED；tasks S3a、S3b |
| B7 | D7、D10；proposal「流程记录」；tasks S3a 的实测任务 |
| B8 | proposal「流程记录」 |
| B9 | D5 第 3 项、D8；tasks S3a |
| T1 | D1、D2 |
| T2 | D3 |
| T3 | D4 |
| T4 | D5、D6 |
| T5 | D7 |
| T6 | D8 |
| T7 | Goals / Non-Goals |
| T8 | tasks 的切片与依赖；D11；Migration Plan |
| 编排方补充 1 | D4「`fstat` 是大小权威」；workspaces「文件预览」与 file-operations「下载」的新场景 |
| 编排方补充 2 | D10；Context「CI 证据」 |
| 编排方补充 3 | D9；proposal Impact「部署前提」；tasks S3b |
| 编排方补充 4 | D2 第 2 步 |
| 编排方补充 5 | D2「精确 `3770`」；「owner 的裁定」表下的编排方默认 |
| 编排方补充 6 | proposal「流程记录」 |
