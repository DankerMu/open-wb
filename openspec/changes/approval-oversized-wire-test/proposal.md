# Proposal: approval-oversized-wire-test（#657）

## Why
`server/test/session-approval-rest.test.ts` E15 用 `fetch` 把约 1.1 MB 的超限 body 发到真实监听端口。Fastify 只看 `Content-Length` 就回 400 并关闭连接、不排空请求体；undici 若还在写 body 就以 `write ECONNRESET`/`EPIPE` 拒绝，断言走不到。`make check` 因此偶发变红（本轮交付中已多次命中）。运行时行为正确，不改服务端。

## What Changes
- `server/test/raw-http-helpers.ts`：`rawHttpRequest` 接受额外请求头（只发请求头、不发 body）。
- `session-approval-rest.test.ts` E15：超限输入改走原始 socket——带 `Content-Type: application/json` 与大于 1 MiB 的 `Content-Length`，不发 body，读到连接关闭后解析状态行、`cache-control`、`set-cookie` 与 JSON 信封；其余三条输入不变（仍走 `fetch`）。
- 规格：tool-approval MODIFIED「审批作答 REST」——把「超限仅凭请求头拒绝并关闭连接」写成一句（测试方式的依据）。

## Non-goals
- 服务端 bodyLimit / parser 错误处理不改。
- 兄弟副本 `server/test/workspace-http-errors.test.ts`（17 KB 超限 body 走 `fetch`）未观测到失败，本刀不动，只在报告里记录。
