## Why

#1821：入口拒绝类用例（配置非法、DB / 沙箱根失败等）在子进程退出后对 `reserveWildcardPort()` 取到、早已释放的端口 connect，以「被拒绝」证明从未监听。端口一直对整机开放，并行测试可能占到同一个号，CI 偶发红（PR #1820 的 run 40534696410，`mounts-config.test.ts:560`），阻塞无关 PR。`refused()` 对任何 error 都返回 true，通过时也证明不了什么。

## What Changes

- 12 处调用点（7 个测试文件）改为经共享助手启动（由助手注入每次尝试新取的 `orderTrace`，拒绝调用方自带 `NODE_OPTIONS`）：失败在 listen 之前的 11 处断言 trace 中没有 `listening:` / `listener-close:` 行；`sandbox_root` 一处（主端口已绑定后失败）断言恰主端口一次 listen + close、预览从未绑定。删除 5 份 `refused()` 副本与共享 `expectRefused(host, port)`。
- 不改产品代码，不改 `reserveWildcardPort` / 重试包装器的取号逻辑。

## Impact

- 规格：verification-harness ADDED「入口拒绝类用例以子进程自己的 listen 留痕证明从未监听」。
- 代码：仅 `server/test/**`：`mounts-config.test.ts`、`omp-max-processes-config.test.ts`、`server-config-vision.test.ts`、`server-config-browser.test.ts`、`model-proxy-reasoning.test.ts`、`server-startup-omp-user.test.ts`、`server-startup-private-state.test.ts`、`server-startup-order-helpers.ts`（及按需的共享小助手）。

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent
Blast radius: 入口拒绝类用例的「从未监听」断言；改坏会让「listen 挪到校验前」的回归漏网，或让既有 stderr / 目录断言被 trace 文件干扰
Selected risk packs: Concurrency / shared state / ordering（并行测试共享端口空间；每次尝试新 trace）
Evidence floor: 变异（runEntrypoint 开头多开一次 listen）使 12 处调用点全部变红且红只来自 trace 断言；12 处调用点的 test:focus 通过；make check
```

design.md 省略（compact）。`fake-upstream*` 的端口释放探针与各 store 测试里判 DB/HTTP 拒绝的同名 `expectRefused` 不在本 change（意图不同，见 #1821 边界）。
