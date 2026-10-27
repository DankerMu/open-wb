## Why

`ensureSharedDir`（`server/src/core/sandbox/dirs.ts:31-50`）每新建一级目录，就按路径 `chmodSync(current, 0o2770)`，而按路径 `chmod` 会跟随符号链接。`OMP_USER` 模式下，新建分量的父目录（owner 根、工作空间根及其下各级）是 `2770`、不带粘滞位，omp uid 可以改名其中的条目。于是在 `mkdir` 与 `chmod` 之间，它可以把刚建出的目录对调成一个指向任意路径的符号链接（`renameat2(RENAME_EXCHANGE)`），让应用 uid 对链接目标执行 `chmod 2770`。目标如果属应用 uid、属组 `workbuddy`，就会变成组可写；例如 `<state>/home/.omp/agent`（`2750`），里面放着 `models.yml` 和审批策略。#1567 D5 在 `repo-root-marker.ts` 里否决过同一类写法，`ensureSharedDir` 是当时漏掉的兄弟副本（#1782）。

## What Changes

- `ensureSharedDir` 对本次新建的分量不再按路径 `chmod`，改为 `mkdirSync(current, 0o770)` → `openSync(current, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)`，对句柄 `fstatSync` 校验是目录且属本进程 euid（`process.geteuid?.()`，与同文件 `ensureOwned` 一致），然后 `fchmodSync(fd, 0o2770)`，最后在 `finally` 里关闭句柄。分量被换成链接时 open 失败（darwin 实测为 `ENOTDIR`，Linux 为 `ENOTDIR` 或 `ELOOP`），函数抛出；被换成别的目录且不属本进程 euid 时，同样抛出。抛出之后走调用方现有的错误路径（通用 500 等）。
- 文件系统调用做成可注入的 `sharedDirFs`，写法同 `markerFs`，供用例在 `mkdir` 与 `open` 之间插入替换。
- `docs/adr/0012-omp-project-config-host-overlay.md:175` 末句「`ensureSharedDir` 的按路径 `chmod` 是同类既有代码」改为指向本修正（#1782）。
- MODIFIED sandbox-core「共享目录权限位」。

## Triage

```text
Issue type: bugfix (security)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: 所有新建沙箱目录的路径（建空间、POST dirs、上传 uploads/、spawn 建 owner 根、挂载点）；写错则建目录全部失败，或者竞态窗口仍在
Selected risk packs: File IO / path safety / overwrite; Auth / permissions / secrets; Concurrency / shared state / ordering; Error handling / rollback / partial outputs; Documentation / migration notes
Evidence floor: 注入式竞态单测红（改前）→ 绿（改后）；sandbox-dirs 既有用例全绿；make check；测试主机双 uid 竞态实测（N 与结果写进 PR）
```

## Impact

- `server/src/core/sandbox/dirs.ts`、`server/test/sandbox-dirs.test.ts`、`docs/adr/0012-omp-project-config-host-overlay.md`。调用方不改。
