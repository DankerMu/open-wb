## Why

`fast-checks` 与 `anti-drift` 把完整 `npm ci` clean install 放在 5 分钟总 job 预算内；历史运行中安装高尾达到 300–302 秒，使 job 在任何质量检查开始前被 GitHub 取消。聚合器随后正确拒绝 `cancelled`，但必过门禁因此产生基础设施噪音。

## What Changes

- 将 `fast-checks` 与 `anti-drift` 的总预算同步为 10 分钟：已观测最慢安装约 302 秒，后续检查约 2–6 秒，而同模式的 10 分钟 `unit-tests` 已证明可完成。
- 在 `constraints.yaml` 为两个预算建立机器可读镜像，并扩展 source-derived CI oracle，拒绝 timeout 回退、镜像漂移、下游检查删除/跳过及聚合器弱化。
- 更新现行 verification-harness 规范，允许本 issue 有依据地取代 S0a 的“既有 timeout 不得修改”冻结条款；历史 archive 保持不变。
- 用新的 PR/push CI 运行证明两个 job 实际执行完后续检查且聚合器全绿。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `verification-harness`: 为 fast-checks/anti-drift 规定有实测依据的 10 分钟预算、控制面镜像与 fail-closed 验证。

## Impact

影响 `.github/workflows/ci.yml`、`constraints.yaml`、`scripts/test-ci-harness.sh` 与 verification-harness 规范；不改产品代码、依赖集合、lockfile、质量阈值或聚合器失败语义。
