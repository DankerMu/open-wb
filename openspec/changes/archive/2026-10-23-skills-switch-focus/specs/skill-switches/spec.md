## MODIFIED Requirements

### Requirement: 中心「技能」tab
`/center?tab=skills`（`label` `技能`，对所有人可见，`CENTER_TABS` 第二项）SHALL 列出 `GET /api/skills` 的平台技能（名称、描述）与开关 `默认启用`（拷入层 switch，accessible name `默认启用 <名称>`）；开关初值为该名称不在 `GET /api/skills` 的 `disabledSkills` 里；切换任一开关 SHALL 恰调用一次 `PUT /api/skills/defaults`，body 为切换后的完整停用列表——最近一次取得的 `disabledSkills`（含不在列表里的名称）加上或去掉被切换的名称，在途期间全部开关不可切换（见下文「不可切换的开关」），失败回滚开关并 `role="alert"` 显示 `ApiError.message`；页顶说明 `只影响新建的会话；已有会话在输入框的「能力」里修改`；没有平台技能时显示 `尚未安装平台技能`。API 客户端 `web/src/lib/api-skills.ts` 提供 `listSkills` / `putSkillDefaults`，严格解析 `{skills, disabledSkills}`。成功后以响应替换列表与停用列表。**不可切换的开关**：本 tab 与输入框「能力」弹层的开关不可切换时 SHALL 带 `aria-disabled="true"` 且 SHALL NOT 带 `disabled` 属性——按下开关的那一刻它就进入在途，`disabled` 会让浏览器把焦点从它身上移走（落到 `body`），键盘用户要从页首重新 Tab；`aria-disabled` 的开关仍可聚焦、仍分派点击与空格，所以点击与键盘操作 SHALL 不发请求、不改开关状态。在途结束后焦点仍在原开关上。

#### Scenario: 切换账号缺省
- **WHEN** 用户在 `技能` tab 关闭 `weekly-report` 的 `默认启用`
- **THEN** 恰一次 `putSkillDefaults({disabledSkills:[…原停用, "weekly-report"]})`；成功后开关保持关闭；返回 500 时开关回到开启并显示错误
- **WHEN** `GET /api/skills` 返回 `skills` 为 `deploy`、`weekly-report`（均 `enabledByDefault:true`）、`disabledSkills` 为 `["ghost"]`（列表外），用户关闭 `deploy`
- **THEN** 恰一次 `putSkillDefaults({disabledSkills:["deploy","ghost"]})`，`ghost` 没有因为不在列表里而丢失

#### Scenario: 在途期间焦点留在开关上
- **WHEN** 键盘焦点在 `默认启用 deploy` 上，用户切换它，`PUT /api/skills/defaults` 挂起；挂起期间再点 `默认启用 weekly-report` 与 `默认启用 deploy`；随后应答成功
- **THEN** 挂起期间两个开关都带 `aria-disabled="true"`、都不带 `disabled`，`deploy` 显示切换后的状态，焦点仍在 `默认启用 deploy` 上；挂起期间的两次点击不发请求、不改开关状态（共恰一次 `putSkillDefaults`）；应答后两个开关都不再带 `aria-disabled`，焦点仍在 `默认启用 deploy` 上

### Requirement: 输入框「能力」弹层
会话页能力行 SHALL 在权限档位控件之后渲染 `能力` 按钮（拷入层 popover），弹层列出本会话可用技能（`GET /api/commands` 的 `skill:` 条目，带 `项目` 标记的保持标记，`overrides` 为真时同样显示 `项目 · 覆盖平台技能`）每项一个开关（开 = 未停用），底部注明 `改动从下一条消息起生效`。每个列出的技能——平台或项目技能同一规则——的开关初值为其名称不在当前停用集合里。欢迎态：停用集合初值为账号缺省停用列表（`GET /api/skills` 的 `disabledSkills`，含列表外的名称；欢迎态第一次打开弹层时恰取一次，之后在本页复用），选择存在页面状态里（与输入框其它待发选择分开存放），首次发送的 `POST /api/sessions` 在用户动过开关时带 `disabledSkills`（账号缺省停用列表加上或去掉被切换的名称，即完整集合）；`GET /api/skills` 未取得（读取中或失败）时开关不可切换：读取中弹层显示 `正在读取技能…`，失败显示 `技能读取失败，关闭后重新打开可重试`（`role="alert"`），下一次打开弹层重取一次。会话中：停用集合为该会话的能力（chat-web「输入框与能力栏」：选中的会话 id 每变化一次恰一次 `GET …/capabilities`，不按消息重取），切换开关恰一次 `PUT …/capabilities`（body `{disabledSkills}`，为切换后的完整集合，含不在弹层列表里的停用名称），失败回滚并显示 `ApiError.message`。没有技能时弹层显示 `暂无可用技能`。

#### Scenario: 会话中停用技能
- **WHEN** 会话可用技能 `deploy`、`weekly-report`；在 `能力` 里关掉 `deploy`；随后输入 `/`
- **THEN** 恰一次 `PUT …/capabilities {disabledSkills:["deploy"]}`；斜杠候选与「+」菜单不再有 `skill:deploy`，`skill:weekly-report` 仍在

#### Scenario: 欢迎态读取账号缺省之前不可切换
- **WHEN** 欢迎态第一次打开 `能力`，`GET /api/skills` 挂起；随后它以 500 失败；关闭弹层再打开，这次成功
- **THEN** 挂起期间各开关不可切换（`aria-disabled="true"`，见「中心「技能」tab」的「不可切换的开关」）并显示 `正在读取技能…`；失败后开关仍不可切换并显示 `技能读取失败，关闭后重新打开可重试`；再次打开恰再发一次 `GET /api/skills`，成功后开关可切换且初值按 `disabledSkills`

#### Scenario: 欢迎态带初值
- **WHEN** 账号缺省停用 `weekly-report`；欢迎态打开 `能力` 不改动即发送；另一次在欢迎态打开 `deploy` 的开关关掉后发送
- **THEN** 第一次 `POST /api/sessions` 的 body 不含 `disabledSkills`；第二次含 `disabledSkills:["deploy","weekly-report"]`；两次在欢迎态共恰一次 `GET /api/skills`
- **WHEN** 账号缺省停用列表为 `["ghost","weekly-report"]`（`ghost` 不在任何列表里），工作空间的 `listCommands` 含平台技能 `deploy` 与 `overrides` 为真的项目技能 `weekly-report`；欢迎态打开 `能力`，打开 `weekly-report` 的开关后发送
- **THEN** 弹层里 `weekly-report` 带 `项目 · 覆盖平台技能` 标记且开关初值为关、`deploy` 为开；发送的 body 含 `disabledSkills:["ghost"]`
