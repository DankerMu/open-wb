# Proposal: session-fault-stderr-record（#664）

## Why
生产装配不传 `assembly.onError`，`createApp` 的默认 sink `observeSessionFault`（`server/src/app.ts`）调用 `app.log.error`，而 Fastify 以 `logger:false` 创建，该 logger 是 no-op。supervisor 运行期保留的全部基础设施故障因此零记录；运维只能在关停时看到一个无上下文的退出码 1。

## What Changes
- `server/src/server.ts`：`appAssemblyOf` 增加 `onError`，同步调用 `void emitStderrRecord("session_fault")`（与 `listener_force_close` 同一出口、同一容错），返回 `undefined`。
- `server/src/app.ts`：删除 `observeSessionFault`；未注入 `onError` 时不观测（故障仍由 supervisor 保留并在关停时暴露）。
- 测试：入口 seam 的 `onError`（一行 exact JSON、无错误原文、同步非 thenable、写失败不抛不递归）；经生产 assembly 装配后一次真实保留故障恰写一行。
- 规格：http-service-skeleton MODIFIED「服务启动与装配」「Shared agent module assembly」。

## Non-goals
- 不开启 Fastify 请求日志，不引入 pino。
- 记录里不带故障类别、会话 id 或任何原始错误文本（issue 的「可选 kind 字段」不做：没有现成的固定枚举，YAGNI）。
- 握手超时记录（#652）不变。
