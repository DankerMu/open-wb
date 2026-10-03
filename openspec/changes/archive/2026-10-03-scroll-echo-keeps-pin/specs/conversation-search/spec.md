## MODIFIED Requirements

### Requirement: 跳转与消息级高亮
成为当前匹配的消息 SHALL 被滚动到转录区可视范围内，并获得消息级高亮：该消息的 `<article>` 带 `aria-current="true"` 与类名 `chat-msg--search-current`，同一时刻至多一条消息带此标记；当前匹配改变、清空或搜索框关闭时移除。`FollowTranscript`（`web/src/features/chat/scroll-follow.tsx`）SHALL 经 `handleRef` 暴露 `scrollToMessage(id)`：在自身 `.chat-transcript` 内查 `[data-message-id="<id>"]`，找到则 `scrollIntoView({ block: "center" })`，并在同一次调用内按滚动后的位置同步重算贴底状态（规则与用户滚动相同，见 chat-web「转录区尺寸变化触发贴底重算」：距底 ≤4px 为贴底并隐藏 `回到最新`；`scrollTop` 变小且距底 >4px 时解除贴底；距底超过一屏时显示 `回到最新`），不依赖浏览器随后派发的 scroll 事件；找不到该消息时不做任何事。跳转后转录区的贴底跟随与 `回到最新` 规则照旧（跳转到非底部消息后新内容不把视图拽回底部，`回到最新` 按距底规则出现；跳转到贴底位置的消息后仍继续跟随）。这是与 demo 的有意偏差：demo 只更新计数并 Toast `第 i / n 处匹配`、不滚动不高亮（demo:2022-2031）；本能力滚动并高亮、不显示该 Toast（计数口径与 demo 相同，都按匹配消息计数）。

#### Scenario: 跳转滚动并高亮
- **WHEN** 一个超过三屏的会话中第一条与最后一条消息匹配查询，转录区贴底，输入查询后按 Enter
- **THEN** 输入后第一条匹配（顶部附近的消息）进入转录区可视范围并带 `aria-current="true"` 与 `chat-msg--search-current`；按 Enter 后该标记移到最后一条匹配消息且第一条不再带标记；无 `第 1 / 2 处匹配` 之类的 Toast
- **WHEN** 跳转到顶部附近的匹配后，运行中回合继续追加正文
- **THEN** 转录区不自动滚回底部，`回到最新` 按钮出现

#### Scenario: 跳转到底部的匹配后继续跟随
- **WHEN** 转录区贴底，跳转到的匹配消息使转录区仍处于距底 ≤4px，随后运行中回合继续追加正文
- **THEN** 转录区继续跟随到底部，`回到最新` 不出现
