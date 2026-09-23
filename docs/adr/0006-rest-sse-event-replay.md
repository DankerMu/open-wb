# SPA↔app-server 用 REST + SSE，事件序号断点回放

CRUD 走 REST/JSON，流式会话走 SSE，与 omp 的单向事件流天然对齐。每活跃会话的事件带单调序号，
app-server 维持环形缓冲；浏览器刷新/断线后带 Last-Event-ID 重连，服务端从断点回放到实时，
正在生成的回复不闪断。用户输入/中断走普通 POST。

## 快照与在途事件边界（#214）
缺口恢复不把尚未刷盘的正文当作缺失：GET messages 返回持久正文加 store 自有待刷尾部的完整视图，以及同一同步步骤捕获的 `streamCursor:{epoch,seq}`。读取不强制刷盘，完整视图不等于 crash-durable。
数值 seq 表示活跃 generation 已记录到的序号；null 封口整个 epoch，只有该 generation 不会再发布事件时才成立。token 撤销早于 stdout/pump 排空，不单独构成封口条件。客户端安装快照后丢弃被该边界覆盖的排队事件，仅消费后继；旧 turn.start 不得清空快照。replay.gap 控制帧使用空 id 重置浏览器游标，不占数据序号。

## Considered Options
- WebSocket：双向能力现阶段用不上，连接生命周期与内网代理兼容成本更高。
- tRPC：端到端类型安全，但把 API 绑进 TS 生态——kb-service 是 Python，API 须保持语言中立。
