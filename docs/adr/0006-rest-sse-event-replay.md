# SPA↔app-server 用 REST + SSE，事件序号断点回放

CRUD 走 REST/JSON，流式会话走 SSE，与 omp 的单向事件流天然对齐。每活跃会话的事件带单调序号，
app-server 维持环形缓冲；浏览器刷新/断线后带 Last-Event-ID 重连，服务端从断点回放到实时，
正在生成的回复不闪断。用户输入/中断走普通 POST。

## 快照与在途事件边界（#214）
缺口恢复不把尚未刷盘的正文当作缺失：GET messages 返回持久正文加 store 自有待刷尾部的完整视图，以及同一同步步骤捕获的 `streamCursor:{epoch,seq}`。读取不强制刷盘，完整视图不等于 crash-durable。
数值 seq 表示活跃 generation 已记录到的序号；null 封口整个 epoch，只有该 generation 不会再发布事件时才成立。token 撤销早于 stdout/pump 排空，不单独构成封口条件。客户端安装快照后丢弃被该边界覆盖的排队事件，仅消费后继；旧 turn.start 不得清空快照。replay.gap 控制帧使用空 id 重置浏览器游标，不占数据序号。

## 传输背压与连接所有权（#103）
SSE 复用 Supervisor 当前 generation 的唯一 ring 和已分配 ID；订阅登记与回放读取同步完成，不能另设序号或事件缓冲。初始回放数组最多1000条，写入返回 false 时已接受的帧不重发，暂停到 drain 后继续。暂停期间到达实时事件、或实时写入返回 false，只结束该客户端，重连通过 ring/完整快照补齐；不以无界实时队列换取长连接不断开。gap 控制帧同样遵守背压，暂停时不发 heartbeat。

逻辑退订与物理响应关闭分开：取消订阅/定时器后，尚在 end/flush 的响应仍由传输持有，直到实际 close；preClose 必须能销毁它们。空闲订阅的真实 HTTP 头立即 flush，不能等15s首个 heartbeat。请求在 preClose 之后才进入 handler 时不得新建流；已认证 owner 获既有502 `agent_unavailable` 和 `Connection: close`。普通 REST 在关停期间完成后仍保留 keep-alive 的既有问题独立跟踪 [#227](https://github.com/DankerMu/open-wb/issues/227)，不是本次 SSE 交付对全部 HTTP 关停时长的保证。

请求与响应寿命不能混同：Node 的 `IncomingMessage.destroyed` 在正常读完请求体后也可能为 true，而 SSE 响应仍可写。登记流之前检查响应 destroyed/ended 或真正的 request abort；若客户端已在异步 hook 中断开，不能因错过 close 事件而重新登记订阅。此边界由真实 TCP 的「先断开再恢复 handler」及「正常读完请求仍返回200」两条相反用例约束。

## Considered Options
- WebSocket：双向能力现阶段用不上，连接生命周期与内网代理兼容成本更高。
- tRPC：端到端类型安全，但把 API 绑进 TS 生态——kb-service 是 Python，API 须保持语言中立。
