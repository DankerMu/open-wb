# Tasks: ui-walk-sessions-walk-two（#541）

Fixture level: expanded

## 8. chat-harness — UI 走查会话元数据，走查二（父 tasks 8.2b）

- [ ] 8.2b `web/e2e/ui-walk-sessions.spec.ts`：接第 6 步之后、同一会话、同一 `try` 块内追加第 7、8、9、11 步——行菜单 `置顶任务` → 条目移到 `置顶任务`、`空间` 不再含它、菜单改为 `取消置顶` → `重命名`（对话框 `重命名任务`、`任务名称`、`保存`）→ 侧栏条目与顶栏标题更新、reload 后标题与置顶分区保持、REST 回读 → 顶栏 `对话内搜索`：UUID → `1/1` 与当前匹配、`WorkBuddy` → `1/2`、无匹配 → `0/0`、`Esc` 关闭并清除高亮 → 行菜单 `删除`（确认框 `删除任务` 与文案）→ Toast `任务已删除`、条目消失、URL 无 `session`、欢迎态、REST 404。去掉「离开会话页」一步；`查看详情` 的 `waitForEvent` 与 click 并成 `Promise.all`。验证：`make ui-walk` 两个 project 全绿；design「Required evidence」E1–E8

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `make ui-walk` 的旅程变长；选中的文件集合不变 → E1、E2 |
| Legacy compatibility / examples | yes | 第 1–6 步不被削弱；`ui-walk.spec.ts` 照常通过 → E2、E5 末项 |
| Concurrency / shared state / ordering | yes | 置顶 / 重命名 / 删除改的是共享库里的会话；UI 删除与事件流收尾的先后；不留残留 → E3、E4、N11、不变量 5 |
| Error handling / rollback / partial outputs | yes | 失败路径的清理（含 `Promise.all` 修复）；`finally` 在 UI 已删时得 404 → N11、N14、N15、E4 |
| Schema / columns / units / field names | yes | `title`、`pinnedAt` 的 REST 回读；确认文案模板；计数格式 `i/n` → N6、N7、N9、N12 |
| Resource limits / large input / discovery | yes | 每测试 30 s；多一次 reload → E2、E3、E8 |
| Accessibility / keyboard / focus | yes | 按可访问名定位行菜单、对话框、搜索框；`Esc` 关闭搜索；mobile 覆盖层的 `aria-hidden` 与 `Escape` → D7、E3 的 mobile 五遍、N10 |
| Auth / permissions / secrets | no | 无新的权限面 |
| File IO / path safety / overwrite | no | 无 |
| Config / project setup | no | `web/playwright.config.ts` 零 diff |
| Release / packaging / dependency compatibility | no | 无新依赖 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 改动只有 `web/e2e/ui-walk-sessions.spec.ts`；其它被跟踪文件零 diff。
- [ ] 没有 RED 阶段；负对照 N1–N16 在两个 project 上逐条记录失败所在的步骤，#540 仍适用的负对照在 `desktop-light` 重跑。
- [ ] `make lint`、`make typecheck`、`make anti-drift`（jscpd 179 不增）、`bash scripts/size-guard.sh`、`npm test --workspace web`、`make test-guardrails` 退出 0；`openspec validate ui-walk-sessions-walk-two --strict --no-interactive` 通过。
- [ ] 实测时长（本地全新状态、复用状态；CI）写进 PR。
