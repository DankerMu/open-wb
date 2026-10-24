## MODIFIED Requirements

### Requirement: 中心「专家」tab
`/center?tab=experts`（`label` `专家`，对所有人可见，`CENTER_TABS` 第一项）SHALL 渲染：分类 chip `全部`、`开发`、`办公`、`设计`、`产品`（单选，缺省 `全部`）；搜索框（placeholder `搜索专家`，按名称、描述、标签子串匹配，不区分大小写）；专家卡片网格（名称、`内置` 或 `自建` 标记、描述、标签）；每张卡 `开始会话` 按钮——以 `navigate("/", {state: {expertId}})` 回到欢迎态，欢迎态读一次该 state 并选中该专家；自建卡另有 `编辑`、`删除`（拷入层 alert-dialog 确认，按钮 `取消` / `删除`）；页顶 `新建专家` 打开对话框表单（名称、分类 select、标签、描述、提示词 textarea、技能多选取自 `GET /api/skills`），提交前按「专家校验与可见性」在客户端逐字段校验并显示原因，提交恰一次 `createExpert` / `updateExpert`，在途禁用，失败在框内 `role="alert"` 显示 `ApiError.message`；对话框接 `useEscapeFallback`。每次写入成功后重取列表。**删除确认关闭后的焦点**：删除成功后该卡不再存在，焦点 SHALL 落到 `新建专家`——无论随后的列表重取早于还是晚于对话框关闭，SHALL NOT 先回到将被删除的那张卡、随其卸载落到 `body`；删除失败时卡片仍在，焦点回到该卡的 `删除`。没有匹配项时显示 `没有匹配的专家`。API 客户端 `web/src/lib/api-experts.ts` 提供 `listExperts` / `createExpert` / `updateExpert` / `deleteExpert`，`id` 经 `encodeURIComponent`，严格解析 `ExpertView`。

#### Scenario: 浏览、筛选与开始会话
- **WHEN** 普通用户打开 `/center`；点 `设计` chip；搜索 `海报`；点 `品牌视觉设计师` 的 `开始会话`
- **THEN** URL 变为 `/center?tab=experts` 且 tab 条为 `专家`、`技能`（无 `模型`）；`设计` 下只剩设计类卡片；搜索后只剩标签含 `海报` 的卡；点击后到 `/` 欢迎态，能力行显示 `专家 · 品牌视觉设计师`，没有发出任何会话请求

#### Scenario: 自建专家的增改删
- **WHEN** 用户 `新建专家` 填名称、分类、提示词提交；对该卡 `编辑` 改名；`删除` 并确认
- **THEN** 依次恰一次 `createExpert`、`updateExpert`、`deleteExpert`，每次成功后恰一次 `listExperts`；内置卡没有 `编辑` / `删除`

#### Scenario: 删除后的焦点
- **WHEN** 用户删除一张自建卡，`deleteExpert` 成功，随后的 `listExperts` 晚于对话框关闭（宏任务之后）才结算；另一例 `deleteExpert` 以 `ApiError` 失败
- **THEN** 成功一例：卡片消失、确认框关闭，`document.activeElement` 是 `新建专家`；失败一例：卡片仍在，焦点在该卡的 `删除`，页顶显示 `ApiError.message`
