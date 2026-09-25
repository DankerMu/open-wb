## ADDED Requirements

### Requirement: 步骤 detail 不做路径改写
按 ADR-0011，工具步骤的 detail（由 args/result 派生，经 SSE 发布、落库并由历史接口返回）SHALL 原样保留其中出现的绝对沙箱路径，不做前缀替换或其它脱敏；截断、单行化与码点边界规则不受影响。

#### Scenario: 含沙箱路径的 args 原样进入 detail
- **WHEN** 映射器收到 `tool_execution_start`，其 args 含 `<SANDBOX_ROOT>/<ownerId>/<dir>/a.md` 形态的绝对路径且序列化后不超过 detail 上限
- **THEN** `step.start` 的 detail 包含该路径原文
