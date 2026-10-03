## MODIFIED Requirements

### Requirement: 深度思考折叠块呈现
会话页 SHALL 在助手消息内、所有其它消息内容（审批条、正文）之前渲染深度思考折叠块：`<details class="thinking-block">`，`<summary>` 可见文本 `深度思考过程`（前置装饰性 `Icon chevron-right`），主体为 thinking 原文，以纯文本呈现（`white-space: pre-wrap`，不经 Markdown 渲染、不注入 HTML）。`thinking` 为 `null` 或空串时 SHALL 不渲染该块。折叠态：消息 status 为 `running` 时展开（`open`），消息由 `running` 进入任一终态（`done|failed|stopped`）时收起；从快照打开一条已终态消息时为收起，从快照打开一条 running 消息时为展开；两次状态迁移之间用户手动展开/收起的选择 SHALL 保留，不被随后到达的 `thinking.delta`、其它事件或同状态的快照重新同步重置。截断标记 `…（已截断）` 作为原文的一部分逐字显示。流式期间主体随 `thinking.delta` 增长；消息 status 为 `running` 时 `<details>` 带 `data-running` 属性且主体不限高（由转录区贴底跟随），终态消息的 `<details>` 不带该属性，主体 SHALL 限高 `12rem` 并在盒内滚动（`overflow: auto`，与步骤卡 `原始输出` 一致），因此贴底时手动展开一条终态消息的折叠块，转录区跟随位移不超过主体限高加其上外边距；折叠块不参与复制（`复制` 仍只复制正文）。

#### Scenario: 流式展开、终态收起
- **WHEN** running 助手消息先收到 `thinking.delta{delta:"先想一想"}`，再收到正文 delta 与 `turn.end done`
- **THEN** 折叠块在正文之前出现、`summary` 文本为 `深度思考过程`、处于展开态且主体为 `先想一想`；`turn.end done` 后折叠块收起、主体文本不变，正文与 `复制` 按钮行为不变

#### Scenario: 快照中的思考与截断标记
- **WHEN** 以 `/?session=<id>` 加载快照：一条 done 助手消息 `thinking` 以 `…（已截断）` 结尾，另一条 `thinking` 为 `null`，还有一条 `thinking` 为空串
- **THEN** 第一条渲染收起的折叠块，展开后主体末尾逐字显示 `…（已截断）`；后两条不渲染折叠块

#### Scenario: 用户手动切换保留
- **WHEN** running 期间用户收起折叠块，随后又到达两条 `thinking.delta`
- **THEN** 折叠块保持收起，展开后主体包含新增文本
- **WHEN** 用户展开一条 done 消息的折叠块，随后页面以一份该消息状态与思考不变、正文不同的快照重新同步
- **THEN** 正文更新为新快照的内容，折叠块保持展开

#### Scenario: 终态消息主体限高
- **WHEN** 转录贴底（距底 ≤4px），用户展开一条 done 助手消息的折叠块，其 thinking 为 120 行，点击前 `summary` 距转录滚动容器顶不少于 198px（视口 390×844 与 1440×900）
- **THEN** 主体高度为 `12rem`（192px）且可在盒内滚动到末行；`summary` 仍在转录滚动容器的可视区内；转录保持贴底
- **WHEN** 一条 running 助手消息的 thinking 增长到 120 行
- **THEN** `<details>` 带 `data-running` 属性，主体不出现盒内滚动（`scrollHeight` 等于 `clientHeight`），转录贴底跟随到最新一行；`turn.end` 后该属性消失
