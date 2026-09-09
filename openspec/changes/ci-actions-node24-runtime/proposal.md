## Why

GitHub hosted runner 已将四种 Node 20 action 强制运行在 Node 24，并在当前 master 的七个直接 CI job 上持续产生弃用 annotation。检查仍能成功，但验证链路依赖临时兼容层，基础设施告警会淹没真正的 CI 警告；项目 `.tool-versions` 的 Node 24 不控制 action 自身 runtime。

## What Changes

- 将 workflow 中 `actions/checkout@v4`、`actions/setup-node@v4`、`astral-sh/setup-uv@v5`、`gitleaks/gitleaks-action@v2` 分别原子升级到最小 Node 24 major：`@v5`、`@v5`、`@v7`、`@v3`。
- 覆盖当前七个 direct jobs 的全部 15 个 action 使用点，保留 checkout/full-history、Node version/npm cache、uv install/cache、gitleaks token 和所有下游步骤/聚合语义。
- 同步 source-derived CI oracle 的 exact action identities，并增加旧 major、混合 major、缺失/替换 action 和关键 input 漂移的 fail-closed mutation evidence。
- 用新 PR CI 的 step metadata、check-run annotations 与日志证明所有 required jobs 继续成功且不再出现 Node.js 20 action-runtime 注解。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `verification-harness`: 规定 CI 中四个第三方 action 的 Node 24 major identity、七个 job 的使用矩阵、关键输入与无 Node 20 fallback/annotation 的验证合同。

## Impact

影响 `.github/workflows/ci.yml`、`scripts/test-ci-harness.sh` 与 oracle 实现；用户于 2026-09-08 授权根直接开发依赖 `yaml@^2.9.0` 及必要 package/lockfile 更新，以成熟 YAML AST 替代三次修复仍不完整的手写扫描器。不修改应用 Node 版本、产品代码、其他依赖、质量步骤、timeout、阈值、权限、secret 值或 aggregate 规则。四个 action major 的上游 release/action metadata 兼容性审阅记录见 design。
