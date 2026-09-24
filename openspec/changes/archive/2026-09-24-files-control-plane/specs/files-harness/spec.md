## ADDED Requirements

### Requirement: 控制面与 oracle 同步
AGENTS.md Directory Map 的 server/ 描述 SHALL 含沙箱、审计、工作空间并保留对话职责，smoke/ 描述 SHALL 提及沙箱夹具并保留对话链路与深链 exact-byte fixture。Verification Matrix 的 HTTP smoke evidence SHALL 逐一列出 public.hurl、auth.hurl、chat.hurl、files.hurl 四文件真实HTTP断言全绿及退出码0，保持调用方拥有已运行服务；各行命令、UI走查行及其errororacle、十个verification surfaces SHALL 不变。既有四文件Make recipe、八directjob/aggregate、OMP_USER透传、checkout8/setup-node6及已证明UIDdowngrade关闭 SHALL 保持此前已晋升合同。相关文案与source-derived oracle/mutation anchors SHALL 同PR同步，不改解析逻辑或阈值，不固定随轮询变化的请求总数。

#### Scenario: oracle 随控制面文案同步
- **WHEN** make test-guardrails validates the active Directory Map and HTTP evidence after the documentation cutover
- **THEN** exact sandbox-fixture/four-file wording passes; stale or missing wording fails the existing owner-aware oracle, restored baseline passes, and prior controls remain intact
