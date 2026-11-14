# omp-runtime Spec Delta

> s2c-harness-followups（#2004）：host tool 真实 omp 回归补 regenerate、fork、撤下全部、always-ask 拒绝四个场景与项目层同名工具的实测。

## MODIFIED Requirements

### Requirement: host tool 的真实 omp 回归
`kb_search` 的注册、调用、审批放行与 `details` 不进上游，SHALL 有一条以钉住的官方 omp 二进制跑的回归用例（`server/test/omp-official-host-tools.test.ts`，`WORKBUDDY_OMP_TEST=1` 门下，CI 跳过）：
- 服务端用应用装配起来，接受控假上游与假 RAGFlow，所有者有一个 `ready` 的库。
- 会话档位为 `write`，prompt 带受控上游的知识库检索标记（omp-test-harness「受控上游知识库检索标记」）。

#### Scenario: 两轮检索
- **WHEN** 官方 omp v18.12.3 跑上述回合到 `turn.end`
- **THEN** SSE 依次有两个名为 `kb_search` 的 `step.start` / `step.end` 与两条 `kb.hits`，每条 `kb.hits` 的 `stepId` 等于它之前那个 `step.start` 的 `stepId`；没有 `approval.request`
- **THEN** 假 RAGFlow 恰收到两次检索请求，`question` 依次为原问句与改写后的问句
- **THEN** 受控上游的第二、第三次请求的 tool 消息只含 `kb_search` 给模型的文本，不含 `details` 里的键名 `bases`

#### Scenario: regenerate 之后仍可检索
- **WHEN** 上述回合结束后对同一条回答 regenerate（同一进程上 `get_branch_messages` → `branch` → `get_state`，宿主不重发 `set_host_tools`），新回合带同一检索标记跑到 `turn.end`
- **THEN** 新回合发给受控上游的每个请求的 `tools` 里恰有一个 `kb_search`，SSE 有名为 `kb_search` 的 `step.start` / `step.end` 与 `kb.hits`，假 RAGFlow 收到检索请求
- **AND** 该会话进程 stdout 上 `set_host_tools` 的应答帧整个用例恰一次（`branch` 之后没有重新注册），结论写进实测记录新 §2.9

#### Scenario: fork 之后仍可检索
- **WHEN** 对上述会话 fork 一次，在 fork 出的会话里带同一检索标记发一条 prompt 跑到 `turn.end`
- **THEN** fork 提交之后，fork 出的会话那一代进程的 stdout 上 `set_host_tools` 的应答帧恰一次（新一代重新注册），上游 `tools` 里恰有一个 `kb_search`，SSE 有 `kb.hits`

#### Scenario: 撤下全部 host tool
- **WHEN** 一个已注册过 `kb_search` 的进程，在所有者删掉唯一的库之后再发一条不带检索标记的 prompt（宿主发 `set_host_tools {tools:[]}`）
- **THEN** omp 的应答被宿主接受（`toolNames` 恰为 `[]`），这一回合以 `turn.end` 正常结束，该回合发给上游的请求的 `tools` 里没有 `kb_search`
- **AND** 应答原文写进实测记录 §2.1

#### Scenario: always-ask 下拒绝
- **WHEN** 会话档位为 `always-ask`（`write` 档对 `kb_search` 由传输层自动放行，到不了所有者），带检索标记的回合里 omp 为 `kb_search` 发出 `Allow tool: kb_search` 的确认，所有者拒绝（测试装配对每个审批请求经 supervisor 的 `decide` 自动拒绝，与审批端点同一路径）
- **THEN** 回合以 `turn.end` 结束；名为 `kb_search` 的步骤以拒绝结束，没有 `kb.hits`；假 RAGFlow 没有收到检索请求
- **AND** 用例记下宿主应答 `Deny` 之后 omp 的帧序与上游下一请求里这次调用的 tool 消息，写进实测记录 §2.4；与 `server/test/support/fake-omp-host-tool.mjs` 的自选帧序不一致时改假 omp 照实测

#### Scenario: 项目层同名工具的并存
- **WHEN** 会话的工作空间里有一个项目层自定义工具 `.omp/tools/kb_search`（omp v18.12.3 能加载的最小形式），宿主照常注册 host tool `kb_search`，带检索标记跑一回合
- **THEN** 用例断言实测到的上游 `tools` 里名为 `kb_search` 的项数与这次调用的落点（宿主收到 `host_tool_call` 与否、假 RAGFlow 收到检索与否），结论写进实测记录新 §2.10，并替换 `docs/architecture/knowledge-base.md` 审批放行段「同名项目工具与宿主 `kb_search` 在真实 omp 上怎样共存没有测过」一句
