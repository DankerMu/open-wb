# Tasks: thinking-fold-block（#534）

## 7. web — thinking.delta 解码归约与深度思考折叠块（父 tasks 7.4）

- [ ] 7.4 新建 `stream-thinking.ts`（`thinking.delta` 严格解码与归约：按 `messageId` 追加到消息 `thinking`，`null` 视为空串；不存在的 assistant 按 `text.delta` 的既有方式补建，user 消息不改）+ `thinking-block.tsx`（`<details class="thinking-block">`，summary `深度思考过程` 前置 `chevron-right`，主体 `pre-wrap` 纯文本不经 Markdown；消息 running 展开、进入 `done|failed|stopped` 收起、快照终态为收起、两次迁移间手动开合保留；null/空串不渲染；不参与 `复制`）+ `conversation-view.tsx` 助手块插入折叠块位（位于审批条之前）+ `stream.ts`：视图 `thinking` 字段、`turn.start` 复位、`DATA_EVENTS`/`ChatEvent`/`decodeEvent`/`applyChatEvent` 接线 + `messages.css` 样式。验证：新建 `web/test/chat-thinking.test.tsx`（T1–T12）；既有测试只改 proposal「偏差」1 列出的视图字面量

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 新消费一类 SSE 事件，须走既有游标/队列/恢复路径 → T1、T2 |
| Schema / columns / units / field names | yes | payload 严格键集 `{messageId, delta}`；视图新增必有键 `thinking` → T2、T4、既有套件的整对象断言 |
| Concurrency / shared state / ordering | yes | 游标过滤与去重；用户的手动开合与事件到达、重同步的先后 → T1、T6、T8、T9 |
| Error handling / rollback / partial outputs | yes | 非法 payload → 完整快照重同步、不交付 → T2 |
| Legacy compatibility / examples | yes | `复制`、审批条、步骤卡、已停止徽章的既有行为与次序 → T6、T10、既有套件 |
| Auth / permissions / secrets | no | 不涉及 |
| File IO / path safety / overwrite | no | 不涉及 |
| Config / project setup | no | 无 |
| Resource limits / large input / discovery | no | 上限 32768 码点由服务端保证；主体是单个文本节点 |
| Release / packaging / dependency compatibility | no | 不加依赖；`chevron-right` 已注册 |
| Documentation / migration notes | no | spec delta 即文档；ui-walk 步骤归 8.2a |

模型输出按纯文本渲染（不经 Markdown、不注入 HTML）不归上面任何一个 pack，单列证据 T11。

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进新文件 `web/test/chat-thinking.test.tsx`；既有测试只按 proposal「偏差」1 在视图字面量里加 `thinking: null`，不改断言语义。
- [ ] RED 集合 = T1–T12 中依赖新行为的用例；实现前后各跑一次并记录命令与结果。
- [ ] `stream.ts` 773 → ≤800；`page.tsx` 688 不变；`chat.css` 不动。PR 记录这些数。
- [ ] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 零新增）、`bash scripts/size-guard.sh` 退出 0；`openspec validate thinking-fold-block --strict --no-interactive` 通过。
- [ ] 页面级用例点 summary 用真实点击（jsdom 29 同步翻转 `open`）；不 fake `setTimeout`（`chat-approval-bar.test.tsx:170` 只 fake Date/setInterval 的写法可照搬）。
