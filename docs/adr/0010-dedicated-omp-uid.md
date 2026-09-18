# omp 子进程以单一专用系统用户运行，与 app-server 分离 uid

同 uid 下 omp 的 bash 工具可读 `/proc/<app-server pid>/environ` 与 app-server 的配置文件，
CONTEXT.md 不变量 4（网关/kb 凭证不进 omp 可读环境）在同 uid 下**无法成立**——ADR-0003/0008 的
"凭证不上命令行/不可猜测 token"只挡命令行与猜测，挡不住这个。决定：所有 omp 子进程运行在一个
**专用系统用户**（如 `omp`）下，与 app-server 不同 uid；这是让不变量 4 成真的最小代价——
一个系统用户 + 一个以该用户 spawn 的机制（sudoers 限定到该二进制、或等价手段，S1a Stage 2 定）。

## Consequences

- 工作空间根目录与挂载点必须对 omp uid 可读写、app-server 配置与 rclone 配置文件（ADR-0003）对其不可读——
  沙箱白名单推导（`core/sandbox`）从此同时是权限位的依据。
- macOS 开发机同 uid 运行，不做分离；隔离性质只在测试 VPS（Linux）上验证并纳入 smoke。
- 每账号独立 uid（跨租户进程级隔离）记为 S3b/S4b 的升级路径，不在本决策内。

## Considered Options

- 每账号独立 uid：隔离更强，但需动态建系统用户与配额，重得多；作为升级路径保留。
- 同 uid 接受泄漏：须在 constraints.yaml downgrades 记为对不变量 4 的降级——等于承认不变量不成立，弃。
