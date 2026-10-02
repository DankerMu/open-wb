# Tasks: session-menu-delete（#532）

## 7. web — 条目菜单删除与删除当前会话回欢迎态（父 tasks 7.2b）

- [ ] 7.2b `session-menu.tsx` 增 `删除`（danger）项 + `session-actions.ts` 删除 handler + 新建 `delete-dialog.tsx`：ConfirmDialog 标题 `删除任务`、说明 `确定要删除「<显示标题>」吗？删除后不可恢复。`、确认 `删除` 请求中忙碌（可关闭、重开仍忙碌）；204 → toast `任务已删除`、移出列表，若响应到达时为当前会话则关闭事件流、以 replace 移除 `?session=`（保留其它 search/hash）回欢迎态；失败 → 关闭确认框、toast 信封 message、重新读取列表；409 `session_busy` 显示其信封文案。`session-sidebar.tsx` 透传回调、`page.tsx` 接线（672 → ≤682）。验证：新建 `web/test/chat-page-session-delete.test.tsx`（R1–R13）；既有测试除三处「恰两项」断言外零 diff（proposal「偏差」2）；CI `ui-walk` 两个 project 全绿

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 请求在途时切换会话、关闭并重开确认框、跨会话确认框、账号切换、卸载、槽位节点卸载后的确认框 → R3、R8、R9、R10、R12、R13 |
| Error handling / rollback / partial outputs | yes | 失败关闭确认框 + Toast + 重读列表、200 非 204、401、关闭后迟到的失败 → R6、R7、R8、R11 |
| Schema / columns / units / field names | yes | 恰一次无 body 的 `DELETE`、确认框与 Toast 文案 → R2、R3 |
| Legacy compatibility / examples | yes | 重命名/置顶、条目钩子、`refreshList` 时机不变；三处既有断言随规格更新 → R1、R4、既有套件、CI ui-walk |
| Public API / CLI / script entry | no | 无新的公开入口；`useSessionActions` 只有 `page.tsx` 一个调用方 |
| Auth / permissions / secrets | no | 只调用本账号既有 DELETE；401 走既有通知（R11 只钉不提示、不重读） |
| File IO / path safety / overwrite | no | 无 |
| Config / project setup | no | 无 |
| Resource limits / large input / discovery | no | 无 |
| Release / packaging / dependency compatibility | no | 不加依赖；`trash`、`triangle-alert` 图标已注册 |
| Documentation / migration notes | no | spec delta 即文档；ui-walk 步骤归 8.2b |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进新文件；既有测试只改 proposal「偏差」2 列出的三处断言，两个文件不增行。
- [ ] RED 集合 = R1–R13。实现前后各跑一次并记录命令与结果。
- [ ] `page.tsx`：672 → ≤682，PR 记录两个数。
- [ ] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 零新增）、`bash scripts/size-guard.sh` 退出 0；`openspec validate session-menu-delete --strict --no-interactive` 通过。
- [ ] 一次性真实浏览器观察（1440×900 与 390×844）结果写进 PR。
