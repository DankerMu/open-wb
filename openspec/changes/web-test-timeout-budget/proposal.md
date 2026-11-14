# Proposal: web-test-timeout-budget

```text
Issue type: test config（#2008，CI flake）
Fixture level: compact
Upstream suggested level: (issue 未标) compact
Blast radius: web/vitest.config.ts 的单例预算。做错时：真挂起的 web 用例要 15 s 才报（原 5 s），或误改到 server / hookTimeout / retry
Selected risk packs: Config / project setup（只改 web vitest 配置；共享配置要求的措辞随之 MODIFIED）
Evidence floor: 解析 web 配置得到 testTimeout 15000、hookTimeout 10000、retry 未设或为 0，server 不变；npm test --workspace web；
  npm exec --workspace @workbuddy/web -- vitest run --coverage --configLoader native；make check；CI unit-tests-web 四个分片绿
```

design.md omitted (compact)：一个配置值。

## Why

#2008 的诊断（issue 评论 2026-11-14）：`chat-model-picker` 首例在 CI 上 `Test timed out in 5000ms` 不是挂起或竞态。

- 失败那次，同一文件 25 例相对本机全部慢 7–10 倍（首例 588 ms → 5084 ms）；通过的 run 里，这个文件也要本机的约 4 倍。
- 它是 web 套件里最长的单例；第二名 `chat-composer-options` 在 CI 上也到了 4.3–4.5 s。
- #1973 前后，本机首例耗时不变（约 555 ms 对 570 ms）。

只拆这一例，超时会落到下一例。Owner 裁定（2026-11-14）：「web 单测统一放宽预算」——`testTimeout` 15000，不动 server，不加 retry。

## What Changes

- `web/vitest.config.ts`：`test.testTimeout` 设为 15000，注释写来历（#2008）。15 s 约为本机最长单例（588 ms）的 25 倍。CI 上的 5055/5084 ms 是 5 s 预算触发时被杀掉的耗时，只是下限；按诊断的 7–10 倍减速估算，这一例在慢 runner 上约 4.1–5.9 s，15 s 留出约 2.5 倍余量。
- verification-harness：新增「web 单测的单例预算」；改写「共享 Vitest 配置的 native ESM 边界」里「web 只叠加 jsdom 与 e2e」一句，如实列出两个 workspace 的全部叠加项（此前 `setupFiles`、`coverage.exclude`、`resolve.alias` 与 server 的 `maxWorkers` 已越过原文）。

## Impact

- 规格：verification-harness 一条 ADDED、一条 MODIFIED。
- 代码：只有 `web/vitest.config.ts`。`vitest.shared.mjs`、server 配置、`hookTimeout`、retry、单个用例显式给的 `timeout`（如 `scheduler-drain.test.tsx`）都不动。
