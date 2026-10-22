# chat-sessions Spec Delta

> s1d-experts-skills：以 `s1d-model-registry` 的 MODIFIED 文本为底，派发前对齐的第 1 步改为「审批档位、模型集合与会话能力」——`store.runtimeState` 另报 `expert_id`、`disabled_skills`，slot 记下能力指纹，有效能力的指纹不同即退役重启，三者都相符才复用；「不触发对齐」一句加上会话能力端点与专家写入，fork 临时进程另取源会话的有效能力（design D8）。改写「修改设置本身不动进程」的步骤，加三个场景；其余逐字沿用该 MODIFIED 文本。

## MODIFIED Requirements

### Requirement: 派发前按会话设置对齐进程
`store.runtimeState` SHALL 在既有内容之外报告会话行的 `approval_mode`、`model_id`、`reasoning_effort` 三个原始列与 `expert_id`、`disabled_skills` 两列；supervisor SHALL 在每一次派发——prompt 与 regenerate——时由前三列经 session-composer-settings「有效值解析」的同一个纯函数算出有效值，由后两列算出会话的**有效能力** `{expertPrompt, disabledExtensions}`——`expertPrompt` 为 experts「专家提示词注入」规定的有效专家的 `prompt`（没有有效专家时为 null），`disabledExtensions` 为停用集合的每个名称加前缀 `skill:`——并在写出该回合的 `prompt` 帧之前按下列次序使进程与之一致。有效值与有效能力在一次派发内只算一次；派发之间不缓存。

1. **审批档位、模型集合与会话能力**。每个 slot SHALL 记下其进程启动时所用的档位、启动时注册表快照的模型 id 集合（model-registry「变更即发布」：托管 `models.yml` 只在 spawn 时被 omp 读取，运行中的进程不认之后登记的模型），以及其进程的「能力指纹」：该次 spawn 写出的两份会话配置文件（omp-runtime「子进程 spawn 契约」）内容的 SHA-256——依次取 `<key>.yml` 的内容与 `<key>.md` 的内容，没有 `.md` 时以一个固定标记代替；指纹 SHALL 由同一个纯函数从有效能力算出（派发前比较与 spawn 写文件用同一份内容），有无专家 SHALL 得到不同的指纹，`<key>` 不进指纹（会话配置文件也只在 spawn 时被 omp 读取，运行中的进程不认之后的能力变化）。存活且可复用的 slot 的启动档位与有效档位不同、**或有效模型不在其启动时的模型集合里**、**或有效能力的指纹与其能力指纹不同**时，supervisor SHALL 先退役该 slot（与空闲回收、驱逐相同的退役路径，等待其完成），再走一次普通的新准入：新进程以有效档位、有效能力与最后已知的会话文件 `--resume` 启动，是一个正常的新 generation（`stream_epoch` 恰加一、新的 ring、经进程上限准入，`agent_capacity` 照常为 503）。启动档位与有效档位相同、有效模型在启动时的集合里、且有效能力的指纹与其能力指纹相同时——三者都相符——SHALL 复用存活进程，不因本条多一次重启（删除模型不改变存活进程的集合：有效值解析已把它回落为缺省模型，缺省模型在集合里则照常复用）。
2. **模型与推理强度**。每个 generation SHALL 记下在它上面最近一次成功应用的模型与强度（新 generation 为「尚未应用」）。取得进程之后：尚未应用、或有效模型与已应用的不同 → 经 `runtime.command` 发 `set_model{provider:"workbuddy", modelId:<有效模型>}`；随后若有效模型支持推理，且（本次刚发过 `set_model`，或有效强度与已应用的不同）→ 发 `set_thinking_level{level:<有效强度>}`。两者都未变时不发命令帧；有效模型不支持推理时不发 `set_thinking_level`。命令成功后才更新所记的已应用值。prompt 路径上这一步紧接在取得进程之后；regenerate 路径上它同样紧接在取得进程之后、`get_branch_messages` 之前（turn-control「重新生成 REST」的执行序），即先于 `branch` 与该路径的 SQLite 事务。
3. 写出 `prompt` 帧（既有的派发回执规则不变）。

第 1、2 步的任何失败（退役或准入失败、`command` 以 `AgentUnavailableError` 拒绝、进程在其间退出）SHALL 作为派发前失败处理：不写 `prompt` 帧，该 slot 被退役，prompt 路径以 `agent_unavailable` 拒绝使 REST 补偿受理对（`agent_capacity` 保持 503）；regenerate 路径上这两步都发生在 `branch` 与事务之前，所以属于「事务前失败」：502 `agent_unavailable`（准入满为 503 `agent_capacity`），不发 `branch`，不改任何行——被重新生成的旧助手消息及其步骤、审批保持原样，`omp_session_file` 不变，占用释放。regenerate 的事务提交之后只剩写 `prompt` 帧一步，其失败映射不变（新助手行记 `failed`）。第 2 步发生在该会话的回合认领已登记之后，其间到达的 prompt / regenerate / fork 照常得到 `session_busy`。
走到派发时该会话没有在途回合也没有被持有的控制占用（既有的 prompt 与 regenerate 前置），所以第 1 步的退役 SHALL NOT 打断任何回合或待决审批。会话设置的修改（`PATCH`）、会话能力的修改（`PUT /api/sessions/:id/capabilities`，skill-switches「会话能力端点」）以及专家的修改与删除（`PUT` / `DELETE /api/experts`）SHALL NOT 触发本条的任何动作：supervisor 不被通知，存活进程与在途回合在下一次派发之前保持原状。
fork 的临时进程 SHALL 以源会话的有效档位、有效模型与有效能力作为 spawn 参数，SHALL NOT 执行第 2 步（它不派发 prompt）；fork 对源会话存活进程的先行退役规则不变。空闲回收、崩溃恢复、驱逐后的再次获取都经同一条派发路径，因而同样按当时的有效值启动并重新应用模型与强度。

#### Scenario: 档位不同则以新档位重启
- **WHEN** 一个 `write` 档的会话在假 omp 真子进程上完成一个回合（进程存活），owner PATCH `{approvalMode:"always-ask"}` 后再发一条 prompt；测试经注入的 spawn 包装记下每次的 argv
- **THEN** 第二条 prompt 返回 202；第一个进程已退出后第二个进程才启动；第二次 spawn 的 argv 含 `--approval-mode always-ask` 与 `--resume <第一回合持久化的会话文件>`；`stream_epoch` 比第一回合大一；全程活进程数不超过一；第二回合的事件来自新的 ring
- **WHEN** 之后不改档位再发第三条 prompt
- **THEN** 没有新的 spawn，`stream_epoch` 不变

#### Scenario: 修改设置本身不动进程
- **WHEN** 会话空闲且进程存活时 owner 依次 PATCH `{approvalMode:"yolo"}`、`{modelId:"m3"}`，再 `PUT /api/sessions/:id/capabilities` `{expertId:"builtin:test-engineer", disabledSkills:["deploy"]}`，此后不发 prompt
- **THEN** 进程没有退出、没有收到任何帧，`stream_epoch` 不变；空闲计时器未被这些 PATCH 与 PUT 重置

#### Scenario: 对齐失败按派发前失败补偿
- **WHEN** 换档后的 prompt 在重新准入时因进程上限已满且无可驱逐进程而失败；另一例 `set_thinking_level` 的 response 为失败
- **THEN** 前者 503 `agent_capacity`、后者 502 `agent_unavailable`；两例受理对都被补偿、会话状态与 `updatedAt` 复原，假 omp 都没有收到该回合的 `prompt` 帧；之后条件恢复再发 prompt 返回 202

#### Scenario: regenerate 的对齐失败不动任何行
- **WHEN** 一个回合结束后 owner 把模型改为假 omp 文档化的失败模型 id（在白名单里），随后调用 regenerate；另一例换档后的 regenerate 在重新准入时因进程上限已满且无可驱逐进程而失败
- **THEN** 前者 502 `agent_unavailable`、后者 503 `agent_capacity`；两例假 omp 都没有收到 `get_branch_messages`、`branch` 与 `prompt`；原助手消息及其步骤、审批行逐值不变，会话 `status`、`updated_at` 与 `omp_session_file` 不变；条件恢复后再 regenerate 返回 202

#### Scenario: regenerate 用当前设置
- **WHEN** 一个回合结束后 owner PATCH `{approvalMode:"yolo", modelId:"m3", reasoningEffort:"low"}`，随后调用 regenerate（假 omp `branch`）
- **THEN** 202；处理它的进程 argv 含 `--approval-mode yolo`；该进程依次收到 `set_model`、`set_thinking_level`、`get_branch_messages`、`branch`、`get_state`、`prompt`（对齐先于 `get_branch_messages`）；被替换的助手消息之外的行不变

#### Scenario: 对齐期间的并发请求
- **WHEN** 换档后的 prompt 正在等待旧进程退役时，同一会话又到达一条 prompt 与一条 regenerate
- **THEN** 后两者都得到 409 `session_busy`，没有新增行；第一条 prompt 照常完成对齐并返回 202

#### Scenario: 新登记的模型使存活进程重启
- **WHEN** 一个会话在假 omp 真子进程上完成一个回合（进程存活，启动时注册表只有 `m1`）；管理员登记 `m2` 并设为全局缺省；该会话（`model_id` 列为 null）再发一条 prompt；之后不改任何东西再发第三条
- **THEN** 第二条 prompt 返回 202；第一个进程退出后第二个进程才启动，第二次 spawn 的 argv 含 `--model workbuddy/m2`，`stream_epoch` 恰加一；新进程在 `prompt` 之前收到 `set_model{modelId:"m2"}`；第三条没有新的 spawn
- **WHEN** 另一例会话的 `model_id` 为 `m2`，管理员删除 `m2`（缺省为 `m1`，进程启动时集合含 `m1`），该会话再发一条 prompt
- **THEN** 没有新的 spawn；进程在 `prompt` 之前收到 `set_model{modelId:"m1"}`；会话行的 `model_id` 列仍为 `m2`

#### Scenario: 真实 omp 对未加载模型的 set_model（真实 omp）
- **WHEN** 官方钉住的 omp v18.12.3 以只含 `m1` 的托管 `models.yml` 启动，宿主在启动后把 `m2` 加进 `models.yml` 并发 `set_model{provider:"workbuddy", modelId:"m2"}`
- **THEN** 应答的 `success` 不为真（实现 PR 记录确切应答；若实测为真则本条「模型集合」判据改为可选并在 design 登记——这是本场景存在的原因）

#### Scenario: 会话能力变化则在下一条重启
- **WHEN** 一个专家为 `builtin:data-analyst` 的会话在假 omp 真子进程上完成一个回合（进程存活）；owner `PUT …/capabilities {expertId:E}`（E 是 owner 自建的专家）后发一条 prompt；随后 owner `PUT /api/experts?id=E` 只改提示词，再发一条；随后 `PUT …/capabilities {disabledSkills:["deploy"]}`，再发一条；测试经注入的 spawn 包装记下每次的 argv 并在 spawn 时读取会话配置文件
- **THEN** 三条 prompt 都返回 202；每条之前前一个进程已退出、新进程才启动，`stream_epoch` 每次恰加一，argv 含 `--resume <上一回合持久化的会话文件>`；三次新 spawn 的 `<key>` 互不相同且旧 key 的文件已不存在；第一、二次的 `--append-system-prompt` 文件分别为 E 的原提示词与改后的提示词；第三次的 `disabledExtensions` 为 `["skill:deploy"]`、提示词仍为改后的 E

#### Scenario: 能力未变则复用
- **WHEN** 上一场景之后不改任何东西再发一条 prompt；随后 owner `PUT …/capabilities` 给出与当前相同的 `{expertId:E, disabledSkills:["deploy"]}`，再发一条
- **THEN** 两条都没有新的 spawn，`stream_epoch` 不变

#### Scenario: 在途回合中修改能力不打断
- **WHEN** 一个回合运行中（假 omp 正在流式输出）owner `PUT …/capabilities {expertId:"builtin:test-engineer"}`；回合结束后再发一条 prompt
- **THEN** `PUT` 即时返回 200；在途回合照常以 `agent_end` 结束，其间进程没有退出、没有收到额外的帧；下一条 prompt 前进程被退役重启，新 spawn 的 `--append-system-prompt` 文件内容为 `测试工程师` 的提示词，`stream_epoch` 恰加一
