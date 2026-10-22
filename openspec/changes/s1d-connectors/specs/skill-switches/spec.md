# skill-switches Spec Delta

> s1d-connectors：以 `s1d-experts-skills` 新建的规格为底（该 change 先归档），「会话能力端点」的 body / 应答加 `disabledConnectors`（规则同 connectors「连接器账号缺省」，并集规则只管技能），改写一个场景、加一个场景；「停用技能对 omp 生效」的 `disabledExtensions` 改为 `skill:<停用技能>` 与 `mcp:<停用连接器>` 的并集；「输入框「能力」弹层」在技能段之后加 `连接器` 段，改写一个场景、加一个场景（design D7、D10）。其余逐字沿用该规格。

## MODIFIED Requirements

### Requirement: 会话能力端点
sessions 模块 SHALL 注册 `GET /api/sessions/:id/capabilities` 与 `PUT /api/sessions/:id/capabilities`（cookie guard 与 owner 预检：未认证 401、不存在或属他人 404，均先于 body；no-store）。两者的 200 body 恰为 `{expertId: string | null, disabledSkills: string[], disabledConnectors: string[]}`：`expertId` 为有效专家（experts「专家提示词注入」），`disabledSkills` 为会话的停用集合（字典序），`disabledConnectors` 为会话的停用连接器集合（`chat_sessions.disabled_connectors`，字典序；change s1d-connectors）。`PUT` 的 body SHALL 为 `{expertId, disabledSkills, disabledConnectors}` 三个键的非空子集：`expertId` 为可见专家 id 或 null，`disabledSkills` 规则同「技能清单与账号缺省」，`disabledConnectors` 规则同 connectors「连接器账号缺省」（字符串数组、至多 32 项、每项符合 connectors「连接器取值规则」的名称规则、去重后字典序存储、不要求名称当前已登记）；`{}`、多余键、不可见专家、不合规的 `disabledConnectors` SHALL 400；已归档会话 SHALL 409 `session_archived`；`PUT /api/sessions/:id/capabilities` 进 content-parser 归属集。**并集规则**：一个 body 只要把 `expertId` 设为某个（非 null 的）专家，新的停用集合 SHALL 为「（body 给出的 `disabledSkills`，没给时为会话当前的停用集合）减去该专家声明的技能」——专家需要的技能一定开着，body 同时给出的 `disabledSkills` 里与之重叠的名称也被去掉；body 不含 `expertId`（只含 `disabledSkills`）时按给出的集合原样存，这是加入专家之后再停用其某个技能的唯一途径（之后再一次只带 `disabledSkills` 的 `PUT`）；把专家清空（`expertId: null`）SHALL NOT 恢复任何停用。并集规则只作用于停用技能：专家不声明连接器，`disabledConnectors` 只由 body 给出的值整体替换，body 不含它时保持会话当前的停用连接器集合。修改 SHALL NOT 通知 supervisor：在途回合不受影响，下一次派发按 chat-sessions「派发前按会话设置对齐进程」对齐。会话视图（session-metadata「会话视图扩展键」）的键集不变。

#### Scenario: 并集与清空
- **WHEN** 会话停用 `["deploy","lint"]`；`PUT {expertId:E}`（E 声明 `["deploy"]`）；再 `PUT {expertId:null}`；再 `PUT {expertId:E, disabledSkills:["deploy"]}`；再 `PUT {disabledSkills:["deploy"]}`
- **THEN** 四次响应的 `disabledSkills` 依次为 `["lint"]`、`["lint"]`、`[]`、`["deploy"]`，`expertId` 依次为 E、null、E、E，`disabledConnectors` 都为 `[]`；每次响应恰为 `expertId`、`disabledSkills`、`disabledConnectors` 三个键

#### Scenario: 拒绝与归档
- **WHEN** 对他人会话 `GET`；对自己会话 `PUT {}`、`PUT {skills:[]}`、`PUT {expertId:"builtin:nope"}`；对已归档会话 `PUT {disabledSkills:[]}`
- **THEN** 404；三个 400；409 `session_archived`；会话行不变

#### Scenario: 停用连接器
- **WHEN** 会话停用技能 `["lint"]`、停用连接器为 `[]`；`PUT {disabledConnectors:["wiki","gitlab","wiki"]}`；再 `PUT {expertId:E}`（E 声明 `["deploy"]`）；再 `PUT {disabledConnectors:["Git"]}`、`PUT {disabledConnectors:"gitlab"}`、`PUT {disabledConnectors:<33 个合规名称>}`
- **THEN** 第一次 200 `{expertId:null, disabledSkills:["lint"], disabledConnectors:["gitlab","wiki"]}`（`wiki` 未登记也照存）；第二次 200 `{expertId:E, disabledSkills:["lint"], disabledConnectors:["gitlab","wiki"]}`；后三次 400 `bad_request`，会话行不变

### Requirement: 停用技能对 omp 生效
每一次 spawn SHALL 把 omp-runtime「子进程 spawn 契约」规定的会话配置文件的 `disabledExtensions` 写为会话停用集合每个名称的 `skill:<名称>` 与会话停用连接器集合每个名称的 `mcp:<名称>` 的并集（去重、字典序；change s1d-connectors）；omp SHALL 因此不加载这些技能（平台与项目技能同样），也不拉起这些连接器（connectors「托管 mcp.json」的「官方 omp 读取并按会话停用」）。斜杠候选与输入框「+」菜单的命令段 SHALL 不列出名称为 `skill:<停用名>` 的条目（客户端按当前会话的能力过滤；`GET /api/commands` 不变）。

#### Scenario: 停用的技能不进系统提示词
- **WHEN** 官方 omp（`WORKBUDDY_OMP_TEST=1`）经模型代理连假上游，平台技能 `alpha` 与 `beta` 各有 description 哨兵（两者的 SKILL.md 都不带 `hide: true`；omp 的工具集含 `read`——omp 只在有 `read` 工具时把技能清单写进系统提示词），会话停用 `alpha`，发一条 prompt 后经 RPC `get_state` 读 `systemPrompt`（假上游不记录消息正文）
- **THEN** `systemPrompt` 含 `beta` 的哨兵、不含 `alpha` 的哨兵；另一例停用集合为空时两个哨兵都在

### Requirement: 输入框「能力」弹层
会话页能力行 SHALL 在权限档位控件之后渲染 `能力` 按钮（拷入层 popover），弹层列出本会话可用技能（`GET /api/commands` 的 `skill:` 条目，带 `项目` 标记的保持标记，`overrides` 为真时同样显示 `项目 · 覆盖平台技能`）每项一个开关（开 = 未停用），底部注明 `改动从下一条消息起生效`。每个列出的技能——平台或项目技能同一规则——的开关初值为其名称不在当前停用集合里。欢迎态：停用集合初值为账号缺省停用列表（`GET /api/skills` 的 `disabledSkills`，含列表外的名称；欢迎态第一次打开弹层时恰取一次，之后在本页复用），选择存在页面状态里（与输入框其它待发选择分开存放），首次发送的 `POST /api/sessions` 在用户动过开关时带 `disabledSkills`（账号缺省停用列表加上或去掉被切换的名称，即完整集合）；`GET /api/skills` 未取得（读取中或失败）时开关不可切换：读取中弹层显示 `正在读取技能…`，失败显示 `技能读取失败，关闭后重新打开可重试`（`role="alert"`），下一次打开弹层重取一次。会话中：停用集合为该会话的能力（chat-web「输入框与能力栏」：选中的会话 id 每变化一次恰一次 `GET …/capabilities`，不按消息重取），切换开关恰一次 `PUT …/capabilities`（body `{disabledSkills}`，为切换后的完整集合，含不在弹层列表里的停用名称），失败回滚并显示 `ApiError.message`。没有技能时弹层显示 `暂无可用技能`。

技能段之后 SHALL 渲染 `连接器` 段（change s1d-connectors）：列出 `GET /api/connectors` 返回的启用的连接器（普通用户视图只含启用的行；管理员视图取 `enabled` 为真的行）每项一个开关（开 = 未停用，accessible name 为连接器名称），开关初值为其名称不在当前停用连接器集合里。欢迎态：停用连接器集合初值为账号缺省（`GET /api/connectors/defaults` 的 `disabledConnectors`，含列表外的名称）；欢迎态第一次打开弹层时 `GET /api/connectors` 与 `GET /api/connectors/defaults` 各恰取一次，之后在本页复用；选择与技能的选择一同存在页面状态里，首次发送的 `POST /api/sessions` 只在用户动过连接器开关时带 `disabledConnectors`（账号缺省列表加上或去掉被切换的名称，即完整集合），没动过时 SHALL NOT 带该键；两者未都取得（读取中或失败）时连接器开关不可切换：读取中该段显示 `正在读取连接器…`，失败显示 `连接器读取失败，关闭后重新打开可重试`（`role="alert"`），下一次打开弹层重取失败的那一个。会话中：停用连接器集合为该会话能力的 `disabledConnectors`（与技能共用同一次 `GET …/capabilities`），`GET /api/connectors` 在本页第一次打开弹层时（欢迎态或会话中，与 chat-web「能力读取时机」同一规则）恰取一次、之后在本页复用（读取中与失败态同欢迎态）；切换开关恰一次 `PUT …/capabilities`（body 恰为 `{disabledConnectors}`，为切换后的完整集合，含不在弹层列表里的停用名称），失败回滚并显示 `ApiError.message`。没有启用的连接器时该段显示 `暂无可用连接器`。

#### Scenario: 会话中停用技能
- **WHEN** 会话可用技能 `deploy`、`weekly-report`；在 `能力` 里关掉 `deploy`；随后输入 `/`
- **THEN** 恰一次 `PUT …/capabilities {disabledSkills:["deploy"]}`；斜杠候选与「+」菜单不再有 `skill:deploy`，`skill:weekly-report` 仍在

#### Scenario: 欢迎态读取账号缺省之前不可切换
- **WHEN** 欢迎态第一次打开 `能力`，`GET /api/skills` 挂起；随后它以 500 失败；关闭弹层再打开，这次成功
- **THEN** 挂起期间各开关禁用并显示 `正在读取技能…`；失败后开关仍禁用并显示 `技能读取失败，关闭后重新打开可重试`；再次打开恰再发一次 `GET /api/skills`，成功后开关可切换且初值按 `disabledSkills`

#### Scenario: 欢迎态带初值
- **WHEN** 账号缺省停用 `weekly-report`；欢迎态打开 `能力` 不改动即发送；另一次在欢迎态打开 `deploy` 的开关关掉后发送
- **THEN** 第一次 `POST /api/sessions` 的 body 不含 `disabledSkills`，也不含 `disabledConnectors`；第二次含 `disabledSkills:["deploy","weekly-report"]`；两次在欢迎态共恰一次 `GET /api/skills`
- **WHEN** 账号缺省停用列表为 `["ghost","weekly-report"]`（`ghost` 不在任何列表里），工作空间的 `listCommands` 含平台技能 `deploy` 与 `overrides` 为真的项目技能 `weekly-report`；欢迎态打开 `能力`，打开 `weekly-report` 的开关后发送
- **THEN** 弹层里 `weekly-report` 带 `项目 · 覆盖平台技能` 标记且开关初值为关、`deploy` 为开；发送的 body 含 `disabledSkills:["ghost"]`

#### Scenario: 连接器段
- **WHEN** `GET /api/connectors` 返回启用的 `gitlab` 与 `wiki`，账号缺省停用连接器为 `["ghost","wiki"]`；欢迎态打开 `能力`，打开 `wiki` 的开关后发送；另一次欢迎态不碰连接器开关只关掉一个技能后发送
- **THEN** 弹层在技能段之后有 `连接器` 段，`gitlab` 开、`wiki` 关；欢迎态 `GET /api/connectors` 与 `GET /api/connectors/defaults` 各恰一次；第一次 `POST /api/sessions` 的 body 含 `disabledConnectors:["ghost"]`；第二次 body 含 `disabledSkills`、不含 `disabledConnectors`
- **WHEN** 会话中能力为 `{expertId:null, disabledSkills:[], disabledConnectors:["ghost"]}`，在 `能力` 里关掉 `gitlab`；另一例该 `PUT` 返回 500
- **THEN** 恰一次 `PUT …/capabilities`，body 恰为 `{disabledConnectors:["ghost","gitlab"]}`；500 一例开关回到开启并显示错误
