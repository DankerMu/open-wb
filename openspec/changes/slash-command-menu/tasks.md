# Tasks: slash-command-menu（#556）

## 10. chat-web — `/` 命令候选（父 tasks 10.5）

- [ ] 10.5 `web/src/lib/api-commands.ts`（新：`listCommands()` GET `/api/commands`，响应体恰 `{commands}`、元素严格五键；`api.ts` 接线）+ `web/src/features/chat/slash-menu-state.ts`（新，纯函数：`isOpen`、`filter`、`pickText`、`reduce`）+ `slash-menu.tsx`（新：`useSlashMenu` 的边沿触发拉取与缓存、按键拦截、选中；私有 `SlashMenu` 面板 `role="listbox"`）+ `composer.tsx` 可选 `slashMenu` 插槽与可选 `interceptKeyDown`（都不传时逐字同现状）+ `conversation-view.tsx` 透传 + `page.tsx` 接线（≤ +10 行）+ `chat.css` 面板样式。验证：新建 `web/test/api-commands.test.ts`（A1–A4）、`web/test/slash-menu-state.test.ts`（M1–M11）、`web/test/chat-page-slash.test.tsx`（J1–J14）；既有测试零 diff

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Accessibility / keyboard / focus | yes | 键盘拦截与既有 Enter / IME 规则交互；焦点必须留在输入框；listbox/option 语义 → J1、J3、J4、J6、J7、J10，design「已知残留」1–2 |
| Public API / CLI / script entry | yes | `Composer` 的两个新 prop、`ApiClient.listCommands`、`ConversationView` 的 `slash` prop → J13、A1、既有测试零 diff |
| Legacy compatibility / examples | yes | 不传 prop 的 `Composer` 逐字不变；未命中的 `/xxx` 原样发送 → J5、J13、`chat-composer.test.tsx` 与 `chat-page*.test.tsx` 零 diff 全绿 |
| Concurrency / shared state / ordering | yes | 在途拉取与条件翻转、`client` 变化、卸载 → J8、J9、J12 |
| Error handling / rollback / partial outputs | yes | 拉取失败静默且只在下一次上升沿重试；严格解析整体拒绝 → J9、A2、A3 |
| Schema / columns / units / field names | yes | `{commands}` 与五键元素的严格解析 → A1、A2 |
| Resource limits / large input / discovery | yes | skill 数量不受限：面板高度上限 + 高亮项滚入可视范围；不在每次按键上重试 → J4、J9、J14 |
| Auth / permissions / secrets | no | 复用既有 same-origin 与 401 通知（A3），无新的权限面 |
| File IO / path safety / overwrite | no | 无 |
| Config / project setup | no | 无 |
| Release / packaging / dependency compatibility | no | 无新依赖 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进新文件；既有测试文件零 diff。
- [ ] RED 集合 = A、M、J 中依赖新行为的用例；实现前就成立的护栏逐条标出。实现前后各跑一次并记录命令与结果。
- [ ] `page.tsx` 697 → ≤ 707、`api.ts` 722 → ≤ 800、`conversation-view.tsx`、`composer.tsx` 的前后行数写进 PR。
- [ ] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 克隆数 178 不增）、`bash scripts/size-guard.sh` 退出 0；`openspec validate slash-command-menu --strict --no-interactive` 通过。
- [ ] 真实浏览器走查不在本刀（#557）；编排者做一次一次性的 Chromium 观察（面板位置、点击后的焦点、390px 无横向溢出），结果写进 PR，不作为门禁。
