# Spec delta: thinking-fold（#539，父 tasks 8.1）

> 父 delta 的同名 Requirement 逐字并入：前提（托管 `models.yml` 的 reasoning 声明，#511）与受控上游标记（#528）已在 master 上成立，取证断言落在本刀新建的 `smoke/session-meta.hurl`。

## ADDED Requirements

### Requirement: reasoning 前提与真运行时取证
托管 `models.yml` SHALL 在 `MODEL_REASONING` 为 `on`（缺省）时为唯一模型条目声明 `reasoning: true` 与 `compat.reasoningContentField: reasoning_content`，`off` 时两者皆省略（写法与确定性见 model-proxy `托管 models.yml`；环境变量到写入选项的映射由装配层 `server/src/agent-config.ts` 负责，`on|off` 之外的取值（含空串）SHALL 在启动时拒绝）。该声明面向真实模型：它让 omp 把模型视为 reasoning 模型（请求思考、并在回放历史助手轮次时按 `reasoningContentField` 写回思考字段，DeepSeek 类上游校验历史 `reasoning_content`）；omp openai-completions 对响应中 `delta.reasoning_content` 的解析本身不依赖该声明。
真运行时取证 SHALL 走「真 omp v18.0.10 → model-proxy → 受控假上游 `server/test/support/fake-upstream.mjs`」链路：假上游在最后一条 user 文本含 `WORKBUDDY_THINK` 标记时，于正文轮先发三个 `reasoning_content` 分片（拼接恰为 `先读需求，再列要点，最后作答。`）再发不变的正文分片，无标记请求逐字节不变（见 omp-test-harness `受控上游思考与写入标记`）。`server/test/support/fake-omp.mjs` 的代理中继只读 `delta.content`/`delta.tool_calls`，不在该链路上，SHALL 不承担此取证；fake-omp 的 `thinking` 场景（直接发 `thinking_start/delta/end` 帧，归 omp-test-harness）只服务服务端集成测试。`make smoke` SHALL 不论 `MODEL_REASONING` 取值，以含该标记的 prompt 断言回合快照助手消息 `thinking` 恰为 `先读需求，再列要点，最后作答。`（三分片在 2000ms 内到达且不足 2048 字节，合并后逐字相同）；该断言位于只由 `make smoke` 运行的 `smoke/session-meta.hurl`（chat-harness `会话元数据 HTTP 冒烟`），`make smoke-live` 与 `smoke/chat.hurl` 不断言 thinking（真实上游是否返回 reasoning 属 grill 未决项 1，返回 `null` 时「不渲染」成立）。该取证证明思考帧经真 omp 到达、落库与快照，不证明 `MODEL_REASONING` 开关对真实模型的效果。

#### Scenario: 真 omp 帧到达
- **WHEN** CI smoke 以真 omp v18.0.10、`MODEL_REASONING` 缺省与受控假上游运行 `make smoke`，`smoke/session-meta.hurl` 发送含 `WORKBUDDY_THINK` 的 prompt
- **THEN** 回合结束后快照助手消息 `thinking` 恰为 `先读需求，再列要点，最后作答。`，正文仍恰为 `你好，这是 WorkBuddy 的第一条流式回复。`；`smoke/chat.hurl` 既有断言不变（该文件不断言 `thinking`）；「上游未返回思考增量 → `thinking` 为 `null`」由服务端集成测试以不含 thinking 帧的 fake 场景（如 A 的 `abort-ok`）证明

#### Scenario: 关闭 reasoning
- **WHEN** 以 `MODEL_REASONING=off` 启动，托管 `models.yml` 被写出
- **THEN** 模型条目无 `reasoning` 与 `compat` 键，文件与本 change 之前的托管输出逐字节相同；以 `MODEL_REASONING=maybe` 或空串启动时进程在写 `models.yml` 之前以配置错误退出（错误信息含变量名）
