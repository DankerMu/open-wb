# Spec: conversation-search

## Purpose
定义会话页的对话内搜索：纯前端，对当前会话已加载消息的正文（Markdown 源文本）做大小写不敏感子串匹配，按匹配消息计数，逐条跳转时把消息滚动入视并做消息级高亮。视觉与文案对照 `resource/workbuddy-live-demo.html`（下称 demo）1945-1952 与 2002-2031；跳转行为与计数口径相对 demo 的偏差在 Requirement 内留痕。

## ADDED Requirements

### Requirement: 对话内搜索框
会话页在顶栏第二态（有当前会话且标题已知）SHALL 经 spa-shell `useTopbar` 的 `actions` 插槽渲染 accessible name 与 Tooltip 均为 `对话内搜索` 的图标按钮（`Icon search`，demo:1952），带 `aria-expanded` 反映搜索框是否打开；欢迎态不渲染。点击 SHALL 切换搜索框：打开时在 `main` 内、转录区之上（紧邻顶栏下方）渲染 accessible name 为 `对话内搜索` 的 `role="search"` 区域，并聚焦其输入框。区域内依次为（demo:1945-1951）：accessible name 与 placeholder 均为 `搜索对话内容` 的输入框；计数器文本 `i/n`（`aria-live="polite"`）；accessible name 分别为 `上一个`、`下一个`、`关闭` 的图标按钮（`n=0` 时 `上一个`/`下一个` 禁用）。

匹配 SHALL 纯前端计算、不发请求：对当前会话视图中按转录顺序排列的每条消息（用户消息与助手消息，含流式中的助手部分正文），以其 `content`（助手为 Markdown 源文本，而非渲染后文本）与查询各自 `toLowerCase()` 后做子串判断；步骤 detail/output、深度思考、审批、文件变更与产物卡、错误文案 SHALL NOT 参与匹配。查询为空串时无匹配。`n` 为匹配的**消息**条数，`i` 为当前匹配在其中的 1 起序号，无当前匹配时 `i=0`；无匹配时计数器为 `0/0`。

键盘与按钮（demo:2010）：输入框内 Enter 或 `下一个` 前进到下一条匹配（末条之后回到第一条），Shift+Enter 或 `上一个` 后退（第一条之前回到末条）；Escape（焦点在输入框时）、`关闭` 或再次点击 `对话内搜索` SHALL 关闭搜索框、清空查询与高亮，并把焦点还给 `对话内搜索` 按钮。查询变化时 SHALL 重新计算匹配，有匹配则当前匹配为第一条（`1/n`）并按「跳转与消息级高亮」滚动与高亮，无匹配则为 `0/0` 且无高亮。消息集合在搜索框打开期间变化（流式正文增长、新回合、快照重载）时 SHALL 重新计算 `n`：原当前消息仍匹配则保持为当前并更新 `i`，否则当前匹配清空（`0/n`、无高亮）直到下一次前进/后退；这种重算 SHALL NOT 触发滚动。切换会话、回到欢迎态或页面卸载 SHALL 关闭搜索框并清空其全部状态。跨会话搜索不在本能力内。

#### Scenario: 计数为匹配消息数
- **WHEN** 当前会话有三条消息：用户 `帮我做 Report`、助手 `**report** 已生成，report 共 3 页`（Markdown 源）、用户 `谢谢`，且一个步骤的 output 含 `report`；打开 `对话内搜索` 并输入 `REPORT`
- **THEN** 输入框获得焦点；计数器为 `1/2`（助手消息内两处出现只计一条，步骤 output 不计）；输入 `不存在` 后计数器为 `0/0` 且 `上一个`/`下一个` 禁用；全程无网络请求

#### Scenario: 键盘循环与关闭
- **WHEN** 查询有 3 条匹配，在输入框依次按 Enter、Enter、Enter、Shift+Enter，然后按 Escape
- **THEN** 计数器依次为 `2/3`、`3/3`、`1/3`、`3/3`；Escape 后搜索框消失、无消息带高亮、焦点在 `对话内搜索` 按钮，按钮 `aria-expanded="false"`；再次打开时输入框为空、计数器 `0/0`

#### Scenario: 流式更新不抢滚动
- **WHEN** 搜索框打开且当前匹配为第 1 条时，一个运行中回合的助手正文流式增长并新出现一处匹配
- **THEN** 计数器的 `n` 增加、`i` 仍指向原消息，转录区滚动位置不因此改变

#### Scenario: 切换会话清空搜索
- **WHEN** 搜索框打开且有高亮时在侧栏选择另一会话
- **THEN** 新会话页面无搜索框、无高亮，`对话内搜索` 按钮 `aria-expanded="false"`

### Requirement: 跳转与消息级高亮
成为当前匹配的消息 SHALL 被滚动到转录区可视范围内，并获得消息级高亮：该消息的 `<article>` 带 `aria-current="true"` 与类名 `chat-msg--search-current`，同一时刻至多一条消息带此标记；当前匹配改变、清空或搜索框关闭时移除。`FollowTranscript`（`web/src/features/chat/scroll-follow.tsx`）SHALL 暴露按消息 id 滚动的接口供此使用；跳转后转录区的贴底跟随与 `回到最新` 规则照旧（跳转到非底部消息后新内容不把视图拽回底部，`回到最新` 按距底规则出现）。这是与 demo 的有意偏差：demo 只更新计数并 Toast `第 i / n 处匹配`、不滚动不高亮，且按匹配处数计数（demo:2022-2031）；本能力按匹配消息计数、滚动并高亮、不显示该 Toast。

#### Scenario: 跳转滚动并高亮
- **WHEN** 一个超过三屏的会话中第一条与最后一条消息匹配查询，转录区贴底，输入查询后按 Enter
- **THEN** 输入后第一条匹配（顶部附近的消息）进入转录区可视范围并带 `aria-current="true"` 与 `chat-msg--search-current`；按 Enter 后该标记移到最后一条匹配消息且第一条不再带标记；无 `第 1 / 2 处匹配` 之类的 Toast
- **WHEN** 跳转到顶部附近的匹配后，运行中回合继续追加正文
- **THEN** 转录区不自动滚回底部，`回到最新` 按钮出现
