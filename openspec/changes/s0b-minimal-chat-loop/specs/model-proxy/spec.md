# Spec: model-proxy

## ADDED Requirements

### Requirement: 透传端点与 bearer 鉴权
app-server SHALL 提供 `POST /v1/chat/completions`。请求 SHALL 携带 `Authorization: Bearer <token>`，token 经 `TokenRegistry.lookup` 命中活跃会话 runtime 才放行；缺失、格式错误、未知或已注销的 token SHALL 返回 401 `unauthorized` 信封且不联系上游。放行请求 SHALL 原样转发 body 与 `content-type` 到 `${MODEL_UPSTREAM_BASE_URL}/chat/completions`，请求头 `Authorization` 替换为 `Bearer ${MODEL_UPSTREAM_API_KEY}`；响应 SHALL 透传上游状态码、`content-type` 与流式 body（逐块转发，不缓冲整段），并加 `Cache-Control: no-store`。上游连接失败或超时（连接 10s）SHALL 返回 502 `agent_unavailable`。请求体上限 4 MiB；该路由加入 content-parser 错误归属集，超限/非 JSON body SHALL 为 400 `bad_request` 信封而非 5xx。该路由 SHALL 不受 cookie guard 影响、不写任何消息内容日志。

#### Scenario: 有效 token 流式透传
- WHEN 以活跃会话 token 发起 `stream:true` 请求，上游为进程内假上游
- THEN 客户端按上游发出顺序逐块收到 SSE 数据块并以 `[DONE]` 结束，状态与 content-type 与上游一致

#### Scenario: 无效 token
- WHEN 无 Authorization、Bearer 值非 64 hex、或 token 已随 runtime 退出注销
- THEN 401 `{"error":{"code":"unauthorized",...}}`，假上游未收到请求

#### Scenario: 上游不可达
- WHEN `MODEL_UPSTREAM_BASE_URL` 指向未监听端口或 env 缺失
- THEN 502 `agent_unavailable` 信封；`/api/healthz` 仍 200

### Requirement: 托管 models.yml
启动期（`listen` 之后）SHALL 在 `<OMP_STATE_DIR>/agent/models.yml` 幂等写入：provider `workbuddy`（`api: openai-completions`，`baseUrl` 为**可连接**的代理地址：`HOST` 为 `0.0.0.0` → `http://127.0.0.1:<实际端口>/v1`，`::` → `http://[::1]:<实际端口>/v1`，其余为实际绑定地址（IPv6 加方括号），`apiKey: WORKBUDDY_MODEL_TOKEN`；不写 `authHeader`，openai-completions 默认注入 Bearer），`models` 恰含 `{id:<MODEL_ID>, name, contextWindow:128000, maxTokens:8192}`。文件内容 SHALL 不含任何上游 URL 或密钥。

#### Scenario: 生成内容
- WHEN 以 HOST=127.0.0.1、PORT=18016、MODEL_ID=deepseek-v4.1-flash 启动
- THEN 文件解析后 `providers.workbuddy.baseUrl == "http://127.0.0.1:18016/v1"`、`apiKey == "WORKBUDDY_MODEL_TOKEN"`，全文不含 `MODEL_UPSTREAM` 的值；重复启动内容不变
- WHEN 以 `HOST=0.0.0.0` 启动
- THEN `baseUrl` 为 `http://127.0.0.1:<实际端口>/v1`，且 omp 子进程经该地址可达代理（真实二进制 smoke 证明）

### Requirement: 假上游夹具契约
`server/test/support/fake-upstream.mjs` SHALL 是零依赖、可由 `node` 直接运行（`FAKE_UPSTREAM_PORT`，默认随机）的 OpenAI 兼容服务：`POST /chat/completions` 缺/错 `Authorization` → 401；messages 中不含 `role:"tool"` → 流式返回一个 `tool_calls`（function `bash`，arguments `{"command":"echo workbuddy-smoke"}`）且 `finish_reason:"tool_calls"`；含 `role:"tool"` → 以至少 3 个 `delta.content` 块返回固定文本 `你好，这是 WorkBuddy 的第一条流式回复。` 后 `data: [DONE]`；最后一条 `role:"user"` 消息内容含 `WORKBUDDY_FAKE_ERROR` → 返回 500 与 OpenAI 形状错误 JSON（用于触发 omp 侧 `stopReason:"error"`）。它 SHALL 同时可被单测进程内导入启动。

#### Scenario: 两轮脚本
- WHEN 先发不含 tool 消息的请求，再发含 tool 消息的请求
- THEN 第一轮得到 tool_calls 块，第二轮得到 ≥3 个文本块且拼接后精确等于固定文本
- WHEN user 消息含 `WORKBUDDY_FAKE_ERROR`
- THEN 500 与错误 JSON，不发流
