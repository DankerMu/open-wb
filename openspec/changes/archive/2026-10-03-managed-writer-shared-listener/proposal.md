# Proposal: managed-writer-shared-listener（#787）

## Why
`server/src/startup-writer.ts` 的 `writeManagedLine` 每条记录各挂一个 stream `error` 监听，摘除在 settle 后的 `setImmediate`。#664 把 supervisor 的每次保留故障接到这个 writer 后，同一 tick 可有多条记录在途；超过 10 条时 Node 向 stderr 打印 `MaxListenersExceededWarning`（两行非 JSON），破坏「application stderr 一行一条 JSON」的约定。实测：真实 `process.stderr` 同 tick 11 / 16 次调用即出现；10 次不出现。归在应用一侧：成因是应用自己的监听模式，不是平台特性。

## What Changes
- `writeManagedLine`：每个 stream 一个共享 `error` 监听 + 在途 settler 集合（按 stream 的 `WeakMap`）；集合为空且过一轮 `setImmediate` 后摘除。语义变化：一次 stream error 使全部在途记录一起 reject（此前也是如此——每个监听都会收到同一事件——只是现在由一个监听分发）。
- 规格：http-service-skeleton MODIFIED「服务启动与装配」。

## Non-goals
不合并/去重 `session_fault` 记录；不改记录内容；不动 `setMaxListeners`。
