# SPA↔app-server 用 REST + SSE，事件序号断点回放

CRUD 走 REST/JSON，流式会话走 SSE，与 omp 的单向事件流天然对齐。每活跃会话的事件带单调序号，
app-server 维持环形缓冲；浏览器刷新/断线后带 Last-Event-ID 重连，服务端从断点回放到实时，
正在生成的回复不闪断。用户输入/中断走普通 POST。

## Considered Options
- WebSocket：双向能力现阶段用不上，连接生命周期与内网代理兼容成本更高。
- tRPC：端到端类型安全，但把 API 绑进 TS 生态——kb-service 是 Python，API 须保持语言中立。
