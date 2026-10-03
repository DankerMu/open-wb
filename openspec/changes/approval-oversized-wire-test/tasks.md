# Tasks: approval-oversized-wire-test（#657）

Fixture level: compact

## 1. 实现
- [ ] 1.1 `raw-http-helpers.ts` `rawHttpRequest`：可选 `headers`（名值对，原样写入请求头；现有调用点行为逐字节不变）。不发 body。
- [ ] 1.2 E15：四条 parser 输入仍全部在真实 socket 上覆盖（malformed / empty / unsupported media 走 `fetch`，oversized 走 1.1 的原始请求）；超限分支断言 400、`bad_request` 信封、`cache-control: no-store`、无 `set-cookie`；循环后 `expectUntouched`（`decide` 未调用、审批行仍 pending）不变。超限输入的 `Content-Length` 取自 `http-guard-helpers.ts` 现有超限载荷的字节长度（不另造魔法数）。
- [ ] 1.3 除上述两个测试文件（及确有必要时的 `server/test/http-guard-helpers.ts`）与本 change 目录外不改其它被跟踪文件；不改任何 `server/src/**`。

## Must preserve
- E15 之外的用例与断言不动；`rawHttpRequest` 的既有调用方全绿。
- E16 及 stop/bodyless 的 inject-only 超限覆盖不变。

## Required evidence
- E1 修复前的失败率：在未改的代码上对 E15 施压（例如 `vitest run … -t E15` 循环 ≥100 次并同时跑 CPU 负载，或并行多进程），记录 `ECONNRESET`/`EPIPE` 次数；若施压下仍 0 次，改用 issue 里的最小复现思路（裸 Fastify + 1 MiB bodyLimit + `fetch` 循环）证明机制，并如实说明套件内未复现。
- E2 修复后同样的施压 ≥200 次，0 失败。
- E3 证明新路径走的是同一个 parser 分支：超限请求的响应与原 `fetch` 成功时的响应（状态、信封、头）一致；把 `Content-Length` 改成 1 MiB 以内 → 不再是 400 超限（记录实际结果），证明断言依赖超限头而非别的 400 来源。
- E4 `npm test --workspace server` 全绿（文件数/测试数）；`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate approval-oversized-wire-test --strict --no-interactive` exit 0。

## Negative controls
- N1 路由对超限请求返回非 400（临时把 bodyLimit 调大）→ E15 超限分支失败。
- N2 E15 超限分支去掉 `Content-Type` 头 → 记录结果（预期变为 415/400 的另一分支，说明该头是必要的）。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Test reliability / flake | yes | 竞态消除 → E1、E2 |
| Coverage equivalence | yes | 仍是真实 socket 上的超限 400 → E3、N1 |
| 其它 | no | 无产品代码改动 |
