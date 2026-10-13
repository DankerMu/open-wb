## MODIFIED Requirements

### Requirement: 创建会话时的设置与继承
`POST /api/sessions` 的 body SHALL 可选携带 `approvalMode`、`modelId`、`reasoningEffort` 三键（键集与其余形状规则见 session-metadata「会话创建与空间绑定」）。校验 SHALL 在任何写入之前完成，任一不合法即 400 `bad_request`、不写会话行、不写审计、不改账号最近选择：

- `approvalMode` SHALL 是 `always-ask` / `write` / `yolo` 之一，且不高于 `APPROVAL_MAX_MODE`。
- `modelId` SHALL 是白名单里某一项的 `id`（字符串精确相等）。
- `reasoningEffort` SHALL 是字符串，且是七个强度名 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 之一（`auto` 不合法），且「本次创建所得模型」支持推理；该模型取 body 的 `modelId`，body 未给时取该账号最近选择经「有效值解析」得到的模型。模型不支持推理时任何 `reasoningEffort` 都不合法；`null` 不是合法取值。校验 SHALL NOT 要求取值在该模型的可选强度内：不在其内的强度名照常受理并原样存储（omp 就近取低，model-selection「推理强度集合」）。

合法请求 SHALL 在创建会话行的同一个 SQLite 事务内：把三列分别写为 body 给出的值，未给出的键取该账号 `account_composer_prefs` 行的同名原始列值（没有行或该列为 NULL 则写 NULL）——唯一的例外是 `approval_mode`：继承来的档位高于当前 `APPROVAL_MAX_MODE` 时写入上界本身而不是原始值（session-permission-tier「管理员最高档」，owner 2026-10-12，#1282），`model_id` 与 `reasoning_effort` 仍原样继承；对 body 给出的每一个键，把该值写入 `account_composer_prefs` 的同名列并更新 `updated_at`（没有行则插入，未给出的列保持原值或 NULL）；按 session-permission-tier「档位变更审计」写创建时的审计。
返回的会话视图 SHALL 带这三键的有效值。未携带这三键的创建 SHALL NOT 改动 `account_composer_prefs`。

#### Scenario: 缺省与显式
- **WHEN** 一个从未做过选择的账号以无 body 创建会话；随后以 `{approvalMode:"always-ask", modelId:"m3", reasoningEffort:"low"}` 创建第二个会话（白名单同「有效值解析」的场景，`APPROVAL_MAX_MODE` 未设置）
- **THEN** 第一次 201 的视图 `approvalMode="write"`、`modelId="m1"`、`reasoningEffort="high"`，会话行三列为 NULL，`account_composer_prefs` 没有该账号的行；第二次 201 的视图三键为 `always-ask`、`m3`、`low`，会话行三列为这三个值，该账号的最近选择行为同样三个值

#### Scenario: 新会话沿用最近选择
- **WHEN** 上一场景之后同一账号再以无 body 创建第三个会话；另一个账号也以无 body 创建会话
- **THEN** 第三个会话的视图三键为 `always-ask`、`m3`、`low`，其行三列为这三个值；另一个账号的会话视图为 `write`、`m1`、`high`
- **WHEN** 第三个从未做过选择的账号以 `{modelId:"m3", reasoningEffort:"xhigh"}` 创建会话（`xhigh` 不在 `m3` 的可选强度内）
- **THEN** 201；视图三键为 `write`、`m3`、`xhigh`；会话行三列为 NULL、`m3`、`xhigh`；该账号的最近选择行为 NULL、`m3`、`xhigh`；没有 `session.permission` 审计行

#### Scenario: 非法取值
- **WHEN** `APPROVAL_MAX_MODE=write` 时以 `{approvalMode:"yolo"}` 创建；以及任意配置下以 `{approvalMode:"Write"}`、`{approvalMode:null}`、`{modelId:"nope"}`、`{modelId:1}`、`{modelId:"m2", reasoningEffort:"high"}`、`{modelId:"m1", reasoningEffort:"auto"}`、`{modelId:"m3", reasoningEffort:"ultra"}`、`{reasoningEffort:null}` 创建
- **THEN** 均为 400 `bad_request` 与 no-store；没有新的会话行与审计行；`account_composer_prefs` 不变

#### Scenario: 继承的档位不高于上界
- **WHEN** `APPROVAL_MAX_MODE=write`，最近选择行为 `yolo`、`m3`、`low` 的账号以无 body 创建会话
- **THEN** 201 的视图三键为 `write`、`m3`、`low`；会话行三列为 `write`、`m3`、`low`；该账号的最近选择行仍为 `yolo`、`m3`、`low`；没有 `session.permission` 审计行
