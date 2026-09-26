# Spec delta: omp-pool（#450 agent_capacity 错误码）

## ADDED Requirements

### Requirement: agent_capacity 错误码
`core/errors` 定义映射 SHALL 新增 `agent_capacity`(503, `Agent 容量已满，请稍后重试`)，随 `approval_settled` 一并把 typed 错误码由十一码扩为十三码；HTTP 映射器、既有"意外错误不伪装"与 no-store 路由归属规则对新码同样成立。

#### Scenario: 信封形状
- **WHEN** 路由抛出 `HttpError("agent_capacity")`
- **THEN** 响应 503，body 恰为 `{error:{code:"agent_capacity",message:"Agent 容量已满，请稍后重试"}}`，无 Fastify 默认字段；伪造 `statusCode:503` 的普通 Error 仍为 generic 5xx
