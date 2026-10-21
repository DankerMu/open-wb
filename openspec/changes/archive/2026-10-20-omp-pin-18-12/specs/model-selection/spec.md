# model-selection Spec Delta

## MODIFIED Requirements

### Requirement: 模型与强度从下一条消息起生效
会话的模型与推理强度被修改后（session-composer-settings「修改会话设置」），SHALL 从该会话下一次派发的回合起生效，SHALL NOT 影响正在进行的回合；会话的历史上下文照常保留。生效方式是派发前的 RPC（chat-sessions「派发前按会话设置对齐进程」，命令帧见 omp-runtime「模型与推理强度命令」）：

- 每个 generation 的第一次派发之前 SHALL 无条件发送 `set_model{provider:"workbuddy", modelId:<有效模型>}`；该模型支持推理时随后发送 `set_thinking_level{level:<有效强度>}`。不依赖 spawn 的 `--model` 与 `--resume` 恢复出的状态。
- 同一个 generation 之后的派发：有效模型与上次应用的不同才发 `set_model`；刚发过 `set_model`、或有效强度与上次应用的不同（且模型支持推理）才发 `set_thinking_level`。两者都未变时不发任何命令帧。
- 次序 SHALL 恒为先 `set_model` 后 `set_thinking_level`，两者都在该回合的 `prompt` 帧之前。模型不支持推理时 SHALL NOT 发送 `set_thinking_level`。
- 任一命令失败（应答 `success` 不为真、进程退出）SHALL 使这次派发以 `agent_unavailable` 失败，按派发前失败处理（prompt → 502 并补偿受理对；重新生成的对齐发生在 `get_branch_messages` 之前，失败为 502 且不改任何行——chat-sessions「派发前按会话设置对齐进程」）。

重新生成 SHALL 使用会话当前的设置（它走同一条派发路径）。分叉出的新会话继承源会话的设置（session-metadata「fork 继承会话元数据」），其第一次派发照常应用。消息 SHALL NOT 记录生成它所用的模型或强度：消息行、消息快照与事件里都没有这样的字段。

#### Scenario: 换模型与强度后的帧序
- **WHEN** 一个有效设置为 `{m1, high}` 的会话在假 omp 真子进程上完成第一个回合；owner PATCH `{modelId:"m3", reasoningEffort:"low"}` 后发第二条 prompt；不改设置再发第三条；PATCH `{reasoningEffort:"high"}` 后发第四条；PATCH `{modelId:"m2"}`（不支持推理）后发第五条；最后发一条 probe prompt
- **THEN** 假 omp 的入站帧记录恰为 `negotiate_protocol,get_state,set_model,set_thinking_level,prompt,set_model,set_thinking_level,prompt,prompt,set_thinking_level,prompt,set_model,prompt,prompt`（最后一个 `prompt` 是 probe）；五个回合由同一个进程处理（没有因模型或强度而重启）；每条 prompt 都返回 202

#### Scenario: 新进程重新应用
- **WHEN** 上述会话的进程被空闲回收后，owner 不改设置再发一条 prompt
- **THEN** 新进程在 `prompt` 之前收到 `set_model`（会话当前的有效模型不支持推理，所以没有 `set_thinking_level`）；若把模型改回 `m1` 再发，则依次收到 `set_model`、`set_thinking_level`、`prompt`

#### Scenario: 生成中修改不打断
- **WHEN** 回合在途时 owner PATCH `{modelId:"m3"}`
- **THEN** 假 omp 在该回合结束前没有收到 `set_model`；回合照常结束；下一条 prompt 之前收到它

#### Scenario: 命令失败按派发前失败处理
- **WHEN** 假 omp 对 `set_model` 应答失败（其文档化的失败模型 id），owner 在一个 `done` 会话上发 prompt
- **THEN** 响应为 502 `agent_unavailable`；受理的用户 / 助手消息对被移除，会话状态与 `updatedAt` 复原；假 omp 没有收到 `prompt` 帧；之后把模型改为可用的再发 prompt 返回 202

#### Scenario: 真实 omp 上的模型与强度
- **WHEN** 官方 omp v18.12.3 读取含两个模型的托管 `models.yml`（model-proxy「托管 models.yml」：第一个模型的 id 恰为 `deepseek-v4.1-flash`——omp 内置目录命中该 id 且目录标它 `input: [text, image]`、`reasoning: true`——而条目显式写 `vision: false` → `input: [text]`、`reasoning: false`；第二个 id 不在目录里，`vision: true` → `input: [text, image]`、`reasoning: true`；两个条目都带显式 `reasoning`），宿主在回合之间发 `set_model` 切到第二个模型，再依次对 `off`、六个强度档与 `auto` 发 `set_thinking_level`（`auto` 只为记录 omp 的行为，它不在取值域内），每次之后发 `get_state`；随后跑一个回合；整个用例从一个新会话的第一个回合开始，含一个工具轮，并在换模型后的回合结束之后、历史已超出压缩保留区的前提下（手段见 tasks 1.4：cwd 的 `.omp/config.yml` 把 `compaction.keepRecentTokens` 设为 1、把 `compaction.methodOrder` 钉为 `[soft]`——只有 `soft` 方法一定向上游发请求；`keepRecentTokens` 不生效时改用一条长用户消息，方法次序的预置保留）发恰一个 `/compact` 回合；另以 `--resume` 重启同一会话后不发命令直接 `get_state`；另在回合之前发 `get_available_models`
- **THEN** `set_model` 之后 `get_state.model` 的 `provider` 与 `id` 为第二个模型；没有一次 `set_thinking_level` 被拒绝，每次之后的 `get_state.thinkingLevel` 与对照用例记录的期望表逐项相等（该表在 tasks 1.4 首次运行时按实测填入并冻结，记的是 omp 实际报出的值——不在该模型强度集合内的取值被就近取低，不要求与所发的取值相同）；`get_available_models` 报出的第一个模型 `input` 恰为 `["text"]`、`reasoning` 恰为 `false`（两者都与内置目录对该 id 的记载相反：显式值没有被目录改写——这是 model-proxy 恒写两键的证明），第二个 `input` 恰为 `["text","image"]`、`reasoning` 为 `true`（条目上多出的 `identity`、`int` 等键不作断言）；该回合受控上游收到的请求体 `model` 为第二个模型的 `id` 且消息历史含此前回合的内容；整个用例里受控上游记录到的每一个请求（含工具轮、`/compact` 回合，以及 omp 在这些步骤里自己发起的任何请求——压缩、`modelRoles` 的 `smol` / `slow` 等角色、`--no-title` 下本不应出现的标题生成，以请求记录为准：记录到的全部 `model` 值都须在白名单内）的 `model` 都是托管 `models.yml` 里的 id（omp-test-harness「受控上游请求记录」），即都在白名单内；`/compact` 回合使受控上游的请求记录至少新增一条，且该回合的 `command_output` 文本不含 `Nothing to compact`，也不含 `Already compacted`——这一步零新增请求时本场景不成立；托管 `HOME` 下的全局配置文件在这些命令前后逐字节不变；重启后的 `get_state` 结果记入同一张表（它只用于说明「每个 generation 无条件应用」是否必要，不改变本条的规则）

#### Scenario: 消息不带模型
- **WHEN** 在两个不同模型下各完成一个回合后读取消息快照
- **THEN** 每条消息的键集恰为 chat-sessions「会话 REST」所列，没有任何表示模型或强度的键；`chat_messages` 没有这样的列
