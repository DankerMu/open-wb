## MODIFIED Requirements

### Requirement: 管理员最高档
`APPROVAL_MAX_MODE`（http-service-skeleton「服务启动与装配」）SHALL 是所有会话可用档位的上界：`GET /api/composer/options` 只列出不高于它的档位；创建与修改会话时高于它的取值被拒绝（400）；存储里高于它的原始选择在读取时被夹取到它。缺省 `yolo`，即三档都开放。
上界为 `always-ask` 时，缺省档 `write` 同样被夹取为 `always-ask`。上界只在服务启动时读取。
新建与 fork 写入会话行的档位 SHALL NOT 高于写入当时的上界（owner 2026-10-12 裁决 A，#1282；这是对 change `s1g-composer-capabilities` design D3「只在读取时夹取、入库不夹取」的局部推翻，只限这两处写入）：`POST /api/sessions` 没有给出 `approvalMode`、由账号最近选择继承时，继承来的档位高于上界即写入上界本身（session-composer-settings「创建会话时的设置与继承」）；fork 复制源会话的档位时同样处理（session-metadata「fork 继承会话元数据」）。封顶期间建出的会话与 fork 因此 SHALL NOT 在上界日后放回时变成比写入值更宽的档位。从未选过档位的情形不在此列（owner 2026-10-13 裁决）：继承来的或源会话的档位列为 NULL 时新行仍写 NULL，上界为 `always-ask` 期间它读作 `always-ask`，上界放回后读作缺省档 `write`（不写审计，到不了 `yolo`）。写入值被夹取不改变这次创建的有效档位，「档位变更审计」的条件照旧按有效档位判定。
既有数据 SHALL NOT 回填：上界调低之前已经写入的会话行、以及账号最近选择行里高于上界的原始值保持原样、读取时夹取，上界放回后重新生效——其中经创建或 `PATCH` 选出 `yolo` 的会话各自在选择当时已有一条 `session.permission`，由 `yolo` 的源会话 fork 出的会话自身没有（fork 不写审计），只能经库里的 `parent_session_id` 追到源会话；上界放回之后由最近选择继承 `yolo` 的新建会话照常写创建审计。

#### Scenario: 调低上界后既有会话被夹取
- **WHEN** 一个会话的 `approval_mode` 列为 `yolo`，服务以 `APPROVAL_MAX_MODE=write` 重启，owner 读取该会话并发一条 prompt
- **THEN** 会话视图 `approvalMode="write"`，进程的 argv 含 `--approval-mode write`；列值仍为 `yolo`；该次读取与派发不写审计
- **WHEN** 服务以 `APPROVAL_MAX_MODE=always-ask` 启动，一个三列均为 NULL 的会话被读取并发一条 prompt
- **THEN** 视图 `approvalMode="always-ask"`，argv 含 `--approval-mode always-ask`

#### Scenario: 封顶期间新建与 fork 的会话不随上界放回而放宽
- **WHEN** 一个账号的最近选择为 `yolo`，并有一个 `approval_mode` 列为 `yolo` 的既有会话 S0；服务以 `APPROVAL_MAX_MODE=write` 重启后，该账号以无 body 创建会话 S1，并对 S0 调用 fork 得到 S2
- **THEN** S1、S2 的视图 `approvalMode="write"`，两行的 `approval_mode` 列都是 `write`（不是 `yolo`）；创建与 fork 都没有新增 `session.permission`；S0 的列值与账号最近选择行仍为 `yolo`
- **WHEN** 随后服务不设 `APPROVAL_MAX_MODE`（上界 `yolo`）重启，读取三个会话并各发一条 prompt，再以无 body 创建会话 S3
- **THEN** S1、S2 的视图仍为 `write`，两个进程的 argv 含 `--approval-mode write`；S0 的视图为 `yolo`（上界调低之前写入的原始值重新生效）；S3 的视图为 `yolo`，并恰新增一条 `detail={sessionId:<S3>, from:null, to:"yolo"}` 的 `session.permission`
- **WHEN** 服务以 `APPROVAL_MAX_MODE=always-ask` 启动，最近选择为 `write` 的账号以无 body 创建会话，随后上界放回 `yolo`
- **THEN** 该会话行的 `approval_mode` 为 `always-ask`；上界放回后视图仍为 `always-ask`
