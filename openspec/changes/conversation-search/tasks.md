# Tasks: conversation-search（#538）

## 7. web — 对话内搜索（父 tasks 7.7）

- [x] 7.7 新建 `search-match.ts`（`matchMessages(messages, query)`：空查询无匹配；否则转录顺序中每条消息 `content` 与查询各 `toLowerCase()` 子串判断；步骤/thinking/审批/卡片/错误不参与）+ `conversation-search.tsx`（`useConversationSearch` 与搜索框：`role="search"` 名 `对话内搜索`，打开即聚焦；输入 `搜索对话内容`、计数 `i/n`（`aria-live="polite"`）、`上一个`/`下一个`（`n=0` 禁用）/`关闭`；Enter/`下一个` 前进、Shift+Enter/`上一个` 后退、首尾循环、组合输入期间不生效；Escape/`关闭`/再点顶栏按钮关闭并清空、焦点还给顶栏按钮；查询变化 → 当前为首条匹配并滚动高亮；消息集合变化 → 重算 `n`，原当前仍匹配则保持并更新 `i` 否则清空当前、不滚动；切换会话/欢迎态/卸载即关闭）+ `scroll-follow.tsx` `FollowTranscript` 增 `handleRef` 暴露 `scrollToMessage(id)`（`[data-message-id]` + `scrollIntoView({block:"center"})` + 同步重算贴底）+ `conversation-view.tsx`（`data-message-id`、当前匹配 `aria-current="true"` 与类 `chat-msg--search-current`、搜索框位置）+ `topbar-actions.ts` 的 `对话内搜索` 槽（`expanded`）+ `page.tsx` 接线 + `messages.css`。验证：新建 `web/test/search-match.test.ts`（U1–U4）与 `web/test/chat-page-search.test.tsx` 与 `web/test/chat-page-search-follow.test.tsx`（S1–S20）；既有测试只改 proposal「偏差」1 列出的期望

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Legacy compatibility / examples | yes | 改 `FollowTranscript`、消息 `<article>`、顶栏上报；贴底跟随规则不得变 → `chat-scroll-follow.test.tsx` 零 diff 全绿、S10、S11、S14 |
| Public API / CLI / script entry | yes | 顶栏 `actions` 通道的最后一个槽位；`chatTopbar()` 签名变化；`FollowTranscript` 的新句柄 → S14、S16、M15（既有） |
| Concurrency / shared state / ordering | yes | 搜索框打开期间的流式更新与快照重载；跳转与贴底跟随的时序；切换会话 → S8、S9、S10、S11、S12、S15 |
| Accessibility / focus | yes | 打开即聚焦、关闭归还焦点、`aria-expanded`、`aria-live` 计数、`aria-current` 至多一条、输入法组合 → S1、S3、S4、S5、S6 |
| Error handling / rollback / partial outputs | yes | 历史未读到 / 读取失败时打开；找不到消息节点时的跳转 → S15（挂起与失败两组）、S17 |
| Resource limits / large input / discovery | no | 匹配是对已加载消息的一次线性扫描，只在搜索框打开且查询非空时每次渲染执行；不发请求、不建索引 |
| Auth / permissions / secrets | no | 不发请求、不渲染新来源的内容；查询只做字符串比较，不进 HTML、不进选择器（选择器里只有数字 id） |
| File IO / path safety / overwrite | no | 无 |
| Schema / columns / units / field names | no | 不改 DTO |
| Config / project setup | no | 无 |
| Release / packaging / dependency compatibility | no | 不加依赖；`search`、`chevron-up`、`chevron-down`、`x` 图标已注册 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [x] 新测试进新文件 `web/test/search-match.test.ts` 与 `web/test/chat-page-search*.test.tsx`（夹具从既有 support 导入，不改它们；缺的放新文件 `chat-page-search-support.tsx`）；既有测试只改 proposal「偏差」1 列出的期望；`chat-scroll-follow.test.tsx` 零 diff。
- [x] RED 集合 = U1–U4、S1–S17 中依赖新行为的用例；实现前就成立的护栏逐条标出。实现前后各跑一次并记录命令与结果。
- [x] `page.tsx` 694 → 697（+3：import、hook 调用、`search` prop；`useTopbar` 那一行原地改）；`conversation-view.tsx` 286 → 316、`scroll-follow.tsx` 119 → 148、`topbar-actions.ts` 44 → 47、`messages.css` 696 → 744；新文件 `conversation-search.tsx` 194、`search-match.ts` 16。
- [x] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 克隆数 178 不增（门禁本身是 3% 占比，克隆数是本仓库子刀沿用的自我约束））、`bash scripts/size-guard.sh` 退出 0；`make ui-walk` 由 CI 的 ui-walk job 覆盖（顶栏三按钮后 390px 的既有走查仍须通过）；`openspec validate conversation-search --strict --no-interactive` 通过。
- [x] 真实浏览器一次性观察（Chromium，1440 / 390 / dark）：design「真实浏览器观察」列出的各项，结果写进 PR。
