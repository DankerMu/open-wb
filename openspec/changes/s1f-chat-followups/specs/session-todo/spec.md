## MODIFIED Requirements

### Requirement: 任务清单面板
会话页 SHALL 在输入框上方的停靠区显示只读的任务清单面板。停靠区自上而下为：任务清单面板、待决审批提问卡、输入框；面板 SHALL 位于停靠区最上方，不在消息线程内、不随线程滚动。

可见条件：选中会话的 `ChatState.todo` 非 `null` 且至少有一个任务的 `status` 不是 `completed` / `abandoned` 时显示；`todo` 为 `null`、或全部任务都是 `completed` / `abandoned` 时 SHALL 不渲染面板（DOM 中没有其头部按钮）。欢迎态（未选中会话）SHALL 不显示面板。

头部 SHALL 是一个按钮，可访问名为 `任务清单 <完成数>/<总数>`：`<完成数>` 是 `status` 为 `completed` 的任务数，`<总数>` 是清单里全部任务数（含 `abandoned`、`blocked`）；按钮带 `aria-expanded`，默认 `true`（展开）。点击在展开与收起之间切换；收起时任务列表不渲染，只留头部按钮。

展开后 SHALL 按阶段次序、阶段内任务次序列出全部任务，每个任务一项列表项（`listitem`；承载它们的列表元素 SHALL 带显式的 `role="list"`，去掉列表符号的样式不致让浏览器丢掉列表语义），显示状态标记与 `content` 全文；清单多于一个阶段时每个阶段显示其 `name`，只有一个阶段时 SHALL 不显示阶段名。状态标记 SHALL 带可访问文本：`pending` → `待办`、`in_progress` → `进行中`、`completed` → `已完成`、`abandoned` → `已放弃`、`blocked` → `受阻`（状态不只靠颜色或图标表达）。`name` 与 `content` 按文本渲染，不解释为 Markdown 或 HTML。

面板 SHALL 只读：除头部按钮外没有任何可交互控件（任务列表被限高裁掉时可由键盘聚焦以便滚动，见下；它不是控件，不响应点击与除滚动之外的按键），不提供新增、勾选、编辑、删除或排序，也不发起任何请求。展开/收起状态 SHALL 按会话保存在内存里：切换到另一会话再切回时保持该会话上次的状态，一个会话的收起不影响另一会话；它不写入 `localStorage`、URL 或服务端，页面重新加载后恢复为默认展开。

面板高度 SHALL 有上限，任务超出时在面板内部滚动；列表的内容高度超过其可见高度时（两种上限下都一样），列表的滚动容器 SHALL 可由键盘聚焦（`tabindex="0"`），未超出时 SHALL NOT 带 `tabindex`——与提问卡 `title` 正文同一做法（tool-approval `web 审批条`），随清单内容、上限档位与元素尺寸变化重新判定；这个上限 SHALL 使展开的面板与第一张待决提问卡（含其 `允许` / `拒绝` 按钮）同时落在停靠区的最大高度之内——有待决提问卡时列表用较小的上限以满足这一条，没有待决提问卡时列表 MAY 用较大的上限（多显示几项任务），两种上限下任务超出时都在面板内部滚动（停靠区整体不超过会话页列高度的一半并在内部滚动，见 chat-web `输入框上方停靠区`）；面板展开时无论任务多少，输入框与其发送按钮 SHALL 仍完整位于视口内，页面不出现横向滚动。这条规则的证据按 seam 分工：200 个任务的清单由整页挂载测试断言结构（下方 `长清单在面板内滚动的结构`，不作视口或像素断言）；真实浏览器里的布局只对 ui-walk 栈能产生的清单（`WORKBUDDY_TODO` 的两项任务，面板展开）断言（chat-harness `UI 走查会话元数据` 第 13 步）。清单经 `todo.updated` 更新时面板 SHALL 就地更新，不改变展开/收起状态，不移动输入框焦点、不改草稿。

#### Scenario: 面板显示在停靠区最上方
- **WHEN** 选中会话的 `todo` 为 `{phases:[{name:"准备", tasks:[{content:"读取需求", status:"completed"},{content:"列出要点", status:"in_progress"}]},{name:"交付", tasks:[{content:"输出结论", status:"pending"},{content:"写周报", status:"abandoned"},{content:"等评审", status:"blocked"}]}]}`，且该会话同时有一条待决审批
- **THEN** 输入框上方自上而下依次是头部按钮 `任务清单 1/5`（`aria-expanded="true"`）及其任务列表、可访问名为 `需要你的确认` 的提问卡、输入框；面板不在任何消息 article 之内；列表显示阶段名 `准备`、`交付` 与五个列表项，其状态可访问文本依次为 `已完成`、`进行中`、`待办`、`已放弃`、`受阻`；面板内除头部按钮外没有按钮、链接或输入控件

#### Scenario: 单阶段不显示阶段名
- **WHEN** 选中会话的 `todo` 为 `{phases:[{name:"走查", tasks:[{content:"整理需求", status:"in_progress"},{content:"输出结论", status:"pending"}]}]}`
- **THEN** 头部按钮为 `任务清单 0/2`，列表有两个列表项（`进行中` `整理需求`、`待办` `输出结论`），页面上不出现文本 `走查`

#### Scenario: 全部完成或放弃时隐藏
- **WHEN** 面板可见时到达 `todo.updated`，其清单的任务状态全部为 `completed` 或 `abandoned`；随后到达一条含 `pending` 任务的 `todo.updated`；随后到达 `todo.updated{todo:null}`
- **THEN** 第一条之后面板不在 DOM 中（没有名称以 `任务清单` 开头的按钮），输入框与提问卡不受影响；第二条之后面板重新出现；第三条之后面板再次消失

#### Scenario: 展开状态按会话保存
- **WHEN** 用户在会话 A 点击头部按钮收起面板，切换到同样有未完成清单的会话 B，再切回 A；之后 A 收到一条新的 `todo.updated`；之后重新加载页面
- **THEN** A 收起后 `aria-expanded="false"` 且没有任务列表项；B 的面板为展开（`aria-expanded="true"`）；切回 A 仍为收起；新的 `todo.updated` 只改变头部计数、不展开面板；重新加载后 A 的面板为展开

#### Scenario: 刷新后由快照恢复
- **WHEN** 一轮带 `todo` 工具结果的回合结束、面板显示 `任务清单 0/2`，用户重新加载页面
- **THEN** 页面的消息快照请求返回同一份 `todo`，面板以相同的计数与任务出现在输入框上方，期间不依赖任何 `todo.updated` 事件

#### Scenario: 长清单在面板内滚动的结构
- **WHEN** 整页挂载（假 API 与假 EventSource）选中会话的清单有 200 个未完成任务且面板展开；另一例同一清单再加一条待决审批
- **THEN** 200 个列表项都渲染在面板的列表元素内（经实现暴露的稳定钩子如 `data-slot` 属性定位），该列表带有限高与内部滚动的样式声明；面板位于停靠区容器内，停靠区容器不在消息线程的滚动容器内、按文档顺序位于输入框之前；头部按钮不在列表的滚动容器之内；另一例里提问卡与面板在同一个停靠区容器内、提问卡在面板之后，其 `允许` / `拒绝` 不在面板列表的滚动容器之内。列表元素带 `role="list"`；列表的内容高度超过其可见高度时（测试里按该元素的 `scrollHeight` 大于 `clientHeight` 给出）它带 `tabindex="0"`，未超过的清单其列表没有 `tabindex`。本场景不对视口或像素尺寸作断言

#### Scenario: 面板展开时输入框仍在视口内
- **WHEN** ui-walk 在 `desktop-light`（1440×900）与 `mobile-dark`（390×844）下对真实栈发送 `WORKBUDDY_TODO` 回合并等到完成，面板展开（两项任务）
- **THEN** 输入框与发送按钮的包围盒完整位于视口内，消息线程的可见高度大于 0，文档没有横向滚动

#### Scenario: 欢迎态不显示
- **WHEN** 用户从一个面板可见的会话点「新建会话」回到欢迎态
- **THEN** 欢迎态没有任务清单面板；重新选中该会话后面板按其清单与该会话保存的展开状态出现

### Requirement: 任务清单快照
`GET /api/sessions/:id/messages` 的响应 SHALL 恰有四个顶层键 `session`、`messages`、`streamCursor`、`todo`。`todo` SHALL 为该会话 `chat_sessions.todo` 列解析后的归一化清单对象（`{phases:[{name, tasks:[{content, status}]}]}`），列为 NULL 时为 `null`；列里的文本解析不出来、或解析结果不符合归一化清单的结构时（带内唯一的写者只写归一化结果，这种值只可能来自带外改库）同样 SHALL 为 `null`，快照照常返回、不因此失败，读取不改写该列；它与消息树、`streamCursor` 在同一次 owner-scoped 读取与同一 preParsing 栈内取得（chat-sessions `会话 REST`），使快照里的清单与游标边界一致。会话 DTO（八键）SHALL 不变：`todo` 不进入会话列表、创建、PATCH 与 fork 响应的 `session`。服务端的四键快照与 web 的四键解析（本能力 `web 契约解析与归约` 的快照部分）SHALL 同刀落地，不设兼容窗口（严格键集使任一侧先合入都会让会话页整体失效）。

#### Scenario: 无清单的会话
- **WHEN** 账号新建会话后读取其消息快照；另一个账号读取该会话
- **THEN** 前者返回 200，响应体恰有 `session`、`messages`、`streamCursor`、`todo` 四键且 `todo` 为 `null`；后者返回与未知 id 相同的 404，不暴露清单

#### Scenario: 清单随快照返回
- **WHEN** 真实 fake-omp（`todo` 场景）的第一轮回合结束后读取快照，随后重启服务再读取一次
- **THEN** 两次的 `todo` 都恰为 `{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"in_progress"},{"content":"列出要点","status":"pending"}]},{"name":"交付","tasks":[{"content":"输出结论","status":"pending"}]}]}`；`GET /api/sessions` 的列表项与快照的 `session` 仍恰为八键、不含 `todo`

#### Scenario: 存量坏值降级为 null
- **WHEN** 某会话的 `chat_sessions.todo` 被带外改成 `{not json`；另一例改成合法 JSON 但结构不合规（`{"phases":"x"}`）；其属主分别读取消息快照
- **THEN** 两例都返回 200，四键齐全且 `todo` 为 `null`，`messages` 与 `streamCursor` 与该列为 NULL 时相同；读取之后该列的值没有被改写
