## Why

#120/#121/#126/#96 已提供 sudo spawn、probe、权限位和真实 SessionRuntime，但同 uid 的 probe 不能证明跨 uid 的 `/proc` 拒绝与共享写入。#131 增加一个可显式启用的 Linux 集成测试，机械验证该边界。

## What Changes

- 仅新增 `server/test/linux/uid-isolation.test.ts`：真实 SessionRuntime → native sudo → canonical fake omp probe；不改 src、配置、CI 或依赖。
- 非 Linux/未明确 opt-in 时可见 skipped；已 opt-in 但未配置环境必须失败，不得再 skip。
- Main 在隔离 Linux 容器做非 skipped 正向与故障注入证明，并保留 macOS/普通 CI skipped 记录。

## Capabilities

### New Capabilities
无新的 capability 名称。

### Modified Capabilities
- `omp-uid-isolation`：新增 Linux 隔离证明要求，引用既有 probe 合同；CI job 本身仍由 #132 交付。

## Impact

一个 server/test/linux 文件，default vitest discovery 自动纳入。Docker provisioning/证据脚本仅在系统 scratch，不入仓；不操作宿主 sudo、用户/组或 sudoers。

## Risk triage

Issue type: test
Fixture level: expanded
Upstream suggested level: expanded (agree: auth/process/file IO/跨 uid 安全 oracle)
Blast radius: 错误 oracle 可能把同 uid 或泄漏环境伪报为隔离成立。
Selected risk packs: Public API / CLI / script entry; Config / project setup; File IO / path safety / overwrite; Auth / permissions / secrets; Concurrency / shared state / ordering; Resource limits / large input / discovery; Legacy compatibility / examples; Error handling / rollback / partial outputs; Documentation / migration notes.
Evidence floor: 真实 Linux 换 uid GREEN + 安全失败类 semantic RED + 恢复 GREEN；Mac/unset 显式 skipped；完整 server coverage/类型/静态与 exact-head CI；三席独立审核。

## Merge versus deployment proof

按 issue 的单文件最小可合并边界，本切片交付测试，#132 才创建 GitHub `uid-isolation` job。pre-merge Linux 证据来自 Main-owned Ubuntu 容器的真实 sudo/proc/fs，不把普通 CI skipped 当隔离证明，也不把容器证据冒充 GitHub runner job。正式 job 的首次全绿及 downgrade 关闭仍跟踪 #132/#134；本切片不改该门禁、也不宣称 Epic 隔离验收完成。
