## 1. 不跟随链接的权限设置

- [x] 1.1 `dirs.ts`：导出 `sharedDirFs = { mkdirSync, statSync, openSync, fstatSync, fchmodSync, closeSync }`，`ensureSharedDir(absPath, fs = sharedDirFs)` 只经它调用文件系统。新建分量走 `mkdir(0o770)` → `open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)` → `fstat`（是目录且 uid 等于 `process.geteuid?.()`，`geteuid` 缺席时跳过比较，与 `ensureOwned` 同一写法）→ `fchmod(0o2770)`，`finally` 里 close；不满足时抛出固定文本，errno 放 `cause`。文件头注释同步更新。
- [x] 1.2 `sandbox-dirs.test.ts` 新增用例：
  - 换成链接：`mkdirSync` 之后把分量换成指向 `0o700` 目录的链接 → 抛出，`cause.code` 属于 `{ENOTDIR, ELOOP}`（darwin 为 `ENOTDIR`），目标仍为 `0o700`；
  - uid 不符：注入的 `fstatSync` 返回不同 uid → 抛出，`fchmodSync` 未被调用；
  - 每次 open 都有对应的 close。
  改前的红：改前函数不接收注入参数，所以先在改前代码上跑一条临时用例（不入库），用 `vi.spyOn(fs, "mkdirSync")` 加 `syncBuiltinESMExports()` 在真实 mkdir 之后做同样的替换。预期没有抛出，目标变为 `0o2770`；报告里给出这条输出。
- [x] 1.3 既有 `ensureSharedDir` 用例原样通过（新建为 `0o2770`、已有分量不改、已有的沙箱根保持 `0o3770`）。
- [x] 1.4 `docs/adr/0012-omp-project-config-host-overlay.md:175` 末句改为：`ensureSharedDir` 的按路径 `chmod` 已由 #1782 改为不跟随链接的句柄加 `fchmod`。
- [x] 1.5 由 orchestrator 在测试主机上做双 uid 竞态实测，不入库。输入、helper 和判定规则见 design.md「Required evidence」。N、改前和改后两组的「被改次数 / 抛出次数」写进 PR，并写明用它替代了 issue 里的端点循环。

验证：
- `npm run test:focus --workspace server -- sandbox-dirs` → 退出码 0。
- `npm run test:focus --workspace server -- workspaces-rest workspace-store omp-process mounts-manager` → 退出码 0（调用方回归）。
- `make check` → 退出码 0。

## Risk packs

- File IO / path safety / overwrite — selected：1.1、1.2 的「换成链接」用例，以及 1.5。
- Auth / permissions / secrets — selected：双 uid 边界（ADR-0010）。由 1.2 的 uid 用例和 1.5 覆盖；PR 与仓库里不出现主机地址。
- Concurrency / shared state / ordering — selected：mkdir 到 chmod 的竞态窗口。由注入用例确定性地复现，1.5 做真实竞态验证。
- Error handling / rollback / partial outputs — selected：抛出后调用方的回滚和 500 不变。由 1.2 的句柄关闭用例，加上调用方回归命令覆盖。
- Documentation / migration notes — selected：1.4。
- Schema、Resource limits、Release、Legacy、Public API — not selected：没有新接口，签名只多一个可选参数，也没有 schema 变化。
