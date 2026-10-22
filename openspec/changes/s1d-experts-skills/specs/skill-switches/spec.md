# skill-switches Specification

## Purpose
技能按会话启停：每个会话有一个停用技能集合，新会话的初值来自账号缺省，加入专家时打开该专家声明的技能；集合经会话专属配置文件的 `disabledExtensions` 交给 omp。本能力覆盖技能清单与账号缺省端点、会话能力端点、中心「技能」tab 与输入框「能力」弹层。

## ADDED Requirements

### Requirement: 技能清单与账号缺省
`skills` 模块 SHALL 注册（受 cookie guard，no-store）：`GET /api/skills` → 200 `{skills: [{name, description, enabledByDefault}]}`，列出平台技能——与 `GET /api/commands` 的平台技能同一读取规则与次序（托管 `<agentDir>/skills`），`enabledByDefault` 为该名称不在本账号 `account_skill_prefs.disabled_skills` 里；`PUT /api/skills/defaults`，body `{disabledSkills: string[]}`（键集严格；至多 128 项；技能名规则同 experts「专家校验与可见性」；去重后字典序存储；不要求名称当前已安装）→ 200，body 与随后的 `GET /api/skills` 相同。`PUT /api/skills/defaults` SHALL 进 content-parser 归属集。账号缺省只决定之后新建会话的初值，SHALL NOT 改动已有会话。不记审计。

#### Scenario: 缺省停用
- **WHEN** 平台技能目录有 `deploy` 与 `weekly-report`；账号 `PUT /api/skills/defaults {disabledSkills:["weekly-report","ghost"]}`；随后创建会话 A（body 不带 `disabledSkills`）；再 `PUT` 为 `[]`
- **THEN** `GET /api/skills` 中 `weekly-report` 的 `enabledByDefault` 为 false、`deploy` 为 true；A 的能力 `disabledSkills` 为 `["ghost","weekly-report"]`；第二次 `PUT` 后 A 的能力不变

### Requirement: 会话能力端点
sessions 模块 SHALL 注册 `GET /api/sessions/:id/capabilities` 与 `PUT /api/sessions/:id/capabilities`（cookie guard 与 owner 预检：未认证 401、不存在或属他人 404，均先于 body；no-store）。两者的 200 body 恰为 `{expertId: string | null, disabledSkills: string[]}`：`expertId` 为有效专家（experts「专家提示词注入」），`disabledSkills` 为会话的停用集合（字典序）。`PUT` 的 body SHALL 为 `{expertId, disabledSkills}` 的非空子集：`expertId` 为可见专家 id 或 null，`disabledSkills` 规则同「技能清单与账号缺省」；`{}`、多余键、不可见专家 SHALL 400；已归档会话 SHALL 409 `session_archived`；`PUT /api/sessions/:id/capabilities` 进 content-parser 归属集。**并集规则**：`expertId` 被设为某专家、且同一 body 不含 `disabledSkills` 时，停用集合 SHALL 去掉该专家声明的技能；body 同时含两键时按给出的 `disabledSkills` 存；把专家清空 SHALL NOT 恢复任何停用。修改 SHALL NOT 通知 supervisor：在途回合不受影响，下一次派发按 chat-sessions「派发前按会话设置对齐进程」对齐。会话视图（session-metadata「会话视图扩展键」）的键集不变。

#### Scenario: 并集与清空
- **WHEN** 会话停用 `["deploy","lint"]`；`PUT {expertId:E}`（E 声明 `["deploy"]`）；再 `PUT {expertId:null}`；再 `PUT {expertId:E, disabledSkills:["deploy"]}`
- **THEN** 三次响应的 `disabledSkills` 依次为 `["lint"]`、`["lint"]`、`["deploy"]`，`expertId` 依次为 E、null、E

#### Scenario: 拒绝与归档
- **WHEN** 对他人会话 `GET`；对自己会话 `PUT {}`、`PUT {skills:[]}`、`PUT {expertId:"builtin:nope"}`；对已归档会话 `PUT {disabledSkills:[]}`
- **THEN** 404；三个 400；409 `session_archived`；会话行不变

### Requirement: 停用技能对 omp 生效
每一次 spawn SHALL 把会话停用集合的每个名称以 `skill:<名称>` 写进 omp-runtime「子进程 spawn 契约」规定的会话配置文件的 `disabledExtensions`；omp SHALL 因此不加载这些技能（平台与项目技能同样）。斜杠候选与输入框「+」菜单的命令段 SHALL 不列出名称为 `skill:<停用名>` 的条目（客户端按当前会话的能力过滤；`GET /api/commands` 不变）。

#### Scenario: 停用的技能不进系统提示词
- **WHEN** 官方 omp（`WORKBUDDY_OMP_TEST=1`）经模型代理连假上游，平台技能 `alpha` 与 `beta` 各有 description 哨兵，会话停用 `alpha`，发一条 prompt
- **THEN** 发往假上游的请求的系统消息含 `beta` 的哨兵、不含 `alpha` 的哨兵

### Requirement: 中心「技能」tab
`/center?tab=skills`（`label` `技能`，对所有人可见，`CENTER_TABS` 第二项）SHALL 列出 `GET /api/skills` 的平台技能（名称、描述）与开关 `默认启用`（拷入层 switch，accessible name `默认启用 <名称>`）；切换任一开关 SHALL 恰调用一次 `PUT /api/skills/defaults`，body 为切换后全部停用名称（含列表外已停用的名称），在途禁用全部开关，失败回滚开关并 `role="alert"` 显示 `ApiError.message`；页顶说明 `只影响新建的会话；已有会话在输入框的「能力」里修改`；没有平台技能时显示 `尚未安装平台技能`。API 客户端 `web/src/lib/api-skills.ts` 提供 `listSkills` / `putSkillDefaults`，严格解析。

#### Scenario: 切换账号缺省
- **WHEN** 用户在 `技能` tab 关闭 `weekly-report` 的 `默认启用`
- **THEN** 恰一次 `putSkillDefaults({disabledSkills:[…原停用, "weekly-report"]})`；成功后开关保持关闭；返回 500 时开关回到开启并显示错误

### Requirement: 输入框「能力」弹层
会话页能力行 SHALL 在权限档位控件之后渲染 `能力` 按钮（拷入层 popover），弹层列出本会话可用技能（`GET /api/commands` 的 `skill:` 条目，带 `项目` 标记的保持标记）每项一个开关（开 = 未停用），底部注明 `改动从下一条消息起生效`。欢迎态：初值为账号缺省（`GET /api/skills` 的 `enabledByDefault`，项目技能缺省开），选择存在页面状态里，首次发送的 `POST /api/sessions` 在用户动过开关时带 `disabledSkills`；会话中：打开会话时恰一次 `GET …/capabilities`，切换开关恰一次 `PUT …/capabilities`（body `{disabledSkills}`，为切换后的完整集合），失败回滚并显示 `ApiError.message`。没有技能时弹层显示 `暂无可用技能`。

#### Scenario: 会话中停用技能
- **WHEN** 会话可用技能 `deploy`、`weekly-report`；在 `能力` 里关掉 `deploy`；随后输入 `/`
- **THEN** 恰一次 `PUT …/capabilities {disabledSkills:["deploy"]}`；斜杠候选与「+」菜单不再有 `skill:deploy`，`skill:weekly-report` 仍在

#### Scenario: 欢迎态带初值
- **WHEN** 账号缺省停用 `weekly-report`；欢迎态打开 `能力` 不改动即发送；另一次在欢迎态打开 `deploy` 的开关关掉后发送
- **THEN** 第一次 `POST /api/sessions` 的 body 不含 `disabledSkills`；第二次含 `disabledSkills:["deploy","weekly-report"]`
