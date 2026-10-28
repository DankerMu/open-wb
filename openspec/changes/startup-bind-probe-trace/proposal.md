## Why

#1825：启动用例（启动失败退出，或启动期 / 关停中收到信号退出）在子进程退出后调 `expectBindable("127.0.0.1", port)`，在 `reserveWildcardPort()` 取到、早已释放的端口上重新 bind，以证明「子进程释放了端口」。进程退出时内核已回收全部 fd，这一 bind 观察不到被测进程：并行测试占到同一个号就 `EADDRINUSE` 偶发红；「漏关监听器、靠进程退出兜底」的回归它也拦不住。5 个文件 29 处。

## What Changes

- A 组（已有 trace 逐字断言）：`server-startup-order.test.ts`、`server-startup-preview.test.ts`、`server-startup-office.test.ts` 中的 `expectBindable` 直接删掉，trace 断言原样保留。
- B 组（无 trace）：`server-startup-failure-reason.test.ts`、`server-startup-layout.test.ts` 改经 `startListenTraced` 启动（助手扩展：异步 `launchFor`、`stdout`），按失败阶段断言监听行，删掉 bind；唯一例外 `preview_listen`（故意占住预览端口、不能走重试）直接传每次新取的 `orderTrace`，期望含 `listening:` 行故不会空过。
- 共享断言补「主端口绑定且预览绑定失败」「两个端口都绑定并关闭（预览端口可能为临时号）」两种形状。
- `expectBindable` 无调用方后从 `server-startup-helpers.ts` 删除。
- 不改产品代码与产品 spec 措辞。

## Impact

- 规格：verification-harness ADDED「启动用例以 listener-close 留痕证明端口已释放」。
- 代码：仅 `server/test/**`。

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent
Blast radius: 启动失败用例对「端口已释放 / 从未监听」的断言；改坏会让漏关监听器或提前监听的回归漏网，或误伤既有 trace 逐字断言
Selected risk packs: Concurrency / shared state / ordering（并行测试共享端口空间；每次尝试新 trace）
Evidence floor: 变异 1（失败清理漏关主监听器）使主端口绑定过的 B 组各例变红、并记录旧 bind 写法在同一变异下仍绿；变异 2（入口开头多开一次监听）使从未监听各例变红；A 组 diff 只删 bind 行；test:focus 5 文件通过；make check
```

design.md 省略（compact）。
