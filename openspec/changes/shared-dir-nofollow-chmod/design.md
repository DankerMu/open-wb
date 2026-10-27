## Design

Change surface: `server/src/core/sandbox/dirs.ts` 的 `ensureSharedDir`，以及新增导出的 `sharedDirFs`。

Must preserve:
- 只对本次新建的分量设 `0o2770`（umask `022`、父目录无 setgid 时也是精确值）；已存在的分量不改 mode。
- `EEXIST` 分支照旧：已存在的条目经 `statSync` 判定是目录就跳过，不是目录就抛出原错误。
- 不 chown、不改进程 umask。
- 签名 `ensureSharedDir(absPath: string): void` 不变，增加可选的第二参数 `fs = sharedDirFs`。
- 六个调用方行为不变：`workspaces/store.ts:373` 建 owner 根和空间根，抛出即走创建回滚；`workspaces/rest.ts:185` 建 `uploads/`；`rest.ts:392` 的 POST dirs；`sessions/omp/process.ts:86` 建 owner 根；`workspaces/mounts/manager.ts:208` 建挂载点；`app.ts:302` 处理沙箱根。

Must add/change: 新建分量 `mkdirSync(current, 0o770)` → `openSync(current, O_RDONLY|O_DIRECTORY|O_NOFOLLOW)` → `fstatSync(fd)`，要求是目录且 `uid === process.geteuid?.()`（`geteuid` 缺席即 Windows 等无 uid 平台时跳过 uid 比较，与 `ensureOwned` 同一写法） → `fchmodSync(fd, 0o2770)`；`finally` 里 `closeSync`。不满足时抛 `Error("shared dir component is not the directory just made")`，文本固定、不含路径，open 的 errno 放在 `cause`。

Governing invariant: 应用 uid 只对经不跟随链接的句柄确认为本进程 euid 所有的真实目录改 mode，绝不对路径解析出的任意目标（链接目标、omp uid 的目录）改 mode。句柄确认不了这就是 `mkdir` 刚建出的那个 inode：omp uid 可以在同一个 `2770`、无粘滞位的父目录里，用 `RENAME_EXCHANGE` 换进另一个应用 uid 所有的目录（PR #1805 安全与正确性座席）。现有布局下这种目录本来都是 `2770`：空间根、`uploads/`、`.git` 标记、未挂载的挂载点；`0o700` 和 `2750` 的应用目录都不在这类父目录下。所以没有可利用的目标，改前的按路径 chmod 也有同样问题，这次没有变坏。今后如果在这类父目录下放一个非 `2770` 的应用 uid 目录，这个缺口会重新打开。

Sibling surfaces:
- `sessions/omp/repo-root-marker.ts:20-32`：同一做法的先例，本次不改。
- `dirs.ts:143` 的 `ensureOwned` 是先 `lstat` 再按路径 `chmod`，父目录多为 omp 不可写的托管布局；`server/src/server.ts:798` 的 DB 文件 `chmodSync`。这两处只列出待核，不改（issue 边界）。
- 父级分量在 `mkdir` 之前就被换成链接（dirfd / `mkdirat` 一类，Epic #1563 (h)）：不在范围内，仍是 ADR-0012 已接受的残余。

Seams under test: 直接调用 `ensureSharedDir(path, fs)`，用注入的 fs 模拟竞态；既有的 `sandbox-dirs.test.ts` 用例；以及一次测试主机上的真实双 uid 竞态（不入库）。

Required evidence:
- 注入：`mkdirSync` 成功之后，把该分量删掉，换成指向一个 `0o700` 目录的符号链接 → `ensureSharedDir` 抛出，`cause.code` 属于 `{ENOTDIR, ELOOP}`（darwin 实测 `ENOTDIR`；不钉单一 errno），目标 mode 仍为 `0o700`。
- 改前的红：改前的 `ensureSharedDir` 不接收注入参数，所以改前那次运行用 `vi.spyOn(fs, "mkdirSync")` 加 `syncBuiltinESMExports()`，在真实 mkdir 之后做同样的替换（旧代码以 `node:fs` 具名导入，能被这样拦到）。预期输出：没有抛出，目标 mode 变为 `0o2770`。实现完成后，这条临时用例不入库，入库的是注入版本。
- 注入：分量被换成另一个目录，`fstat` 显示 uid 不同（经注入的 `fstatSync` 返回不同 uid 模拟）→ 抛出，没有调用 `fchmodSync`。
- 正常路径：`<tmp>/a/b/c` 三级均为 `0o2770`；再次调用 mode 不变；预先存在的 `0o755` 保持不变（既有用例）。
- 句柄关闭：每次 open 都有对应的 close，包括抛出的路径（经注入计数）。
- 测试主机实测（Ubuntu 一次性容器，名称前缀 `owb1700-`，结束后删除；主机地址不进任何被跟踪文件或 PR）：
  - 用户：容器内建 app、omp 两个用户，都加入组 `workbuddy`。
  - 父目录：app 所有、属组 workbuddy、`2770`、无粘滞位。
  - 目标：app 所有、属组 workbuddy、`0o2750`，模拟 `<state>/home/.omp/agent`。
  - omp uid 侧：一个 Python helper 经 ctypes 调 `renameat2(AT_FDCWD, <parent>/x<i>, AT_FDCWD, <parent>/lnk, RENAME_EXCHANGE)`，busy loop，其中 `lnk` 是指向目标的符号链接。
  - app uid 侧：一个 node 脚本 import 编译后的 `dirs.js`，循环 N 次 `ensureSharedDir(<parent>/x<i>)`，每次之后读目标 mode。
  - 报告：N、目标 mode 被改的次数、抛出次数。
  - 判定：改前 ≥1 次被改才算竞态可复现；N 次内 0 次命中算无结论，加大 N 重跑。改后要求被改 0 次，且抛出 ≥1 次，证明窗口确实被打中过。
  - 这条实测替代 issue 验收里的 `POST /api/workspaces/:id/dirs` 循环：竞态窗口完全在函数内部，HTTP 层不增加任何东西。PR 里写明这一替代，以及 harness 是本次的一次性脚本，不是 #1665 留下的现成 harness。

Non-goals: 父级替换（dirfd / mkdirat）；`ensureOwned` 和 DB chmod；same-uid 模式。

Residual（兼容性）：在会压掉或重映射 uid 的文件系统上，新建目录的 uid 与 euid 不一致，改后 `ensureSharedDir` 会抛出（POST dirs 返回 500，建空间回滚），改前的按路径 chmod 可能会成功。这类文件系统包括 NFS `root_squash` / `all_squash`、带 `uid=` 挂载的 CIFS。参考部署不在这类文件系统上，挂载内的目录按 D16 也不经本函数。

Review focus: 句柄的 open / close 在每条路径上都配对；`O_DIRECTORY|O_NOFOLLOW` 在 macOS 与 Linux 的语义；euid 校验在 same-uid 部署下不误报；调用方的抛出路径（store 回滚、POST dirs 500）不变；不残留按路径的 chmod。
