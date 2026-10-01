# Tasks: session-menu-rename-pin（#531）

## 7. web — 条目菜单重命名/置顶与顶栏重命名入口（父 tasks 7.2a）

- [x] 7.2a 新建 `web/src/features/chat/session-menu.tsx`（行尾 `更多操作：<显示标题>` 按钮打开 Menu，本刀两项：`重命名`/`置顶任务`|`取消置顶`，任何状态可用）+ `rename-dialog.tsx`（标题 `重命名任务`、输入 `任务名称`、trim 空时 `保存` 禁用、Enter/保存 → PATCH → 更新列表与面包屑、toast `已重命名`；失败保持打开并 `role="alert"` 显示信封 message）+ `session-actions.ts` 的 rename/pin handler（置顶/取消 → PATCH → toast `已更新置顶状态`）+ 新建 `web/src/features/chat/topbar-actions.ts`（有序常量 `CHAT_TOPBAR_ACTIONS`，固定槽位次序 `重命名` → `对话内搜索` → `产物面板`；页面只从该常量按序构造 `useTopbar` 的 actions，未实现的槽位不产出按钮）+ 会话页顶栏第二态填入 `重命名` 槽（pencil，打开同一 Dialog）。另：`session-path.ts` 加 `selectedSession()`、`chat.css` 行布局（proposal「偏差」1）。验证：新建 `web/test/chat-page-session-rename-pin.test.tsx` 与 `web/test/chat-page-session-pin.test.tsx`（M1–M16）；既有测试断言零 diff（两个夹具补 `ToastProvider`，proposal「偏差」6）；CI `ui-walk` 两个 project 全绿

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `CHAT_TOPBAR_ACTIONS` 槽位次序与 builder 是 7.6/7.7 的共同前提 → M15、M6 |
| Concurrency / shared state / ordering | yes | PATCH 在途时列表重读、乱序响应、账号切换、卸载、槽位节点卸载后的 Dialog → M4、M11、M12、M13、M14 |
| Error handling / rollback / partial outputs | yes | 失败保留 Dialog、关闭后迟到的失败走 Toast、置顶失败列表不变、不乐观更新 → M4、M5、M9、M10 |
| Schema / columns / units / field names | yes | 请求体恰为 `{title}`/`{pinned}`、只合并该请求修改的键 → M2、M8、M10、M11、M12 |
| Legacy compatibility / examples | yes | 条目钩子、`selectedSessionTitle`、既有测试零 diff → M1、M16、既有套件、CI ui-walk |
| Auth / permissions / secrets | no | 只调用本账号既有 PATCH；401 走既有通知 |
| File IO / path safety / overwrite | no | 无 |
| Config / project setup | no | 无 |
| Resource limits / large input / discovery | no | 标题长度上限由服务端 400 把关，前端只转显信封 message |
| Release / packaging / dependency compatibility | no | 不加依赖；图标已由 #529 注册 |
| Documentation / migration notes | no | spec delta 即文档；ui-walk 步骤归 8.2b |

## 通用纪律（继承父 tasks.md）
- [x] 新测试进新文件（两个测试文件 + 一个 support 模块）；既有测试断言零 diff，仅两个夹具补 `ToastProvider`。
- [x] RED 集合 = M1–M15 与 M16 后半。实现前后各跑一次并记录命令与结果。
- [x] `page.tsx`：666 → ≤676，PR 记录两个数。
- [x] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0；`openspec validate session-menu-rename-pin --strict --no-interactive` 通过。
- [x] 一次性真实浏览器观察（1440×900 与 390×844）结果写进 PR。
