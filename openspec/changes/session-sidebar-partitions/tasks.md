# Tasks: session-sidebar-partitions（#530）

## 7. web — 三分区侧栏与筛选（父 tasks 7.1）

- [ ] 7.1 新建 `web/src/features/chat/session-groups.ts`（纯函数：筛选 状态 全部/进行中=`running`/已完成=`done|failed|stopped` × 时间 全部时间/今天=本地日历日/更早，取交集；分区 置顶 > 空间（按 `workspaceId` 分子组、顺序为工作空间列表顺序、不在列表 → 末位 `未知空间`）> 任务，互斥、保持服务端顺序）+ `session-sidebar.tsx`（取代并删除 `session-nav.tsx`；分区 `置顶任务`（无计数）/`任务 (n)`/`空间 (n)` 及子组为带名 `role="group"`，空分区不渲染，无任何会话 → `没有匹配的任务`；保留选择按钮、`新会话` 标题回退与状态元素；`新建会话` 名称不变）+ `session-filter.tsx`（`筛选任务` Popover，两个 `role="radiogroup"`，选择即生效、弹层保持打开，Escape 关闭且焦点回到 `筛选任务`，状态只在页面内存）+ `workspace-list.ts`（`useWorkspaceList`，design D3）；`ChatPage.refreshList` 并行触发工作空间读取，读取失败只影响归组（全部落 `未知空间`）、会话列表照常渲染。保留 design「Must-preserve」的 DOM 钩子。既有测试改动限 design D7 的封闭清单。验证：新建 `web/test/session-groups.test.ts`（G1–G5）与 `web/test/chat-page-sidebar.test.tsx`（S1–S12）；CI `ui-walk` 两个 project 全绿

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Legacy compatibility / examples | yes | jsdom 与 ui-walk 依赖的 DOM 钩子不变、既有测试只做 design D7 封闭清单的改动 → S11、既有套件、CI ui-walk |
| Concurrency / shared state / ordering | yes | 两请求互不等待、迟到响应、槽位卸载后状态保留、StrictMode → S1、S6、S7、S8、S9 |
| Error handling / rollback / partial outputs | yes | 工作空间读取失败只影响归组、不出错误提示 → S5、S6 |
| Schema / columns / units / field names | yes | `updatedAt` 毫秒与本地日历日、计数口径、`pinnedAt`/`workspaceId` 判空 → G1–G5 |
| Documentation / migration notes | yes | `session-nav.tsx` 删除后的引用 → S12、proposal「Non-goals」（checklist 行） |
| Public API / CLI / script entry | no | 无对外接口；组件 props 为 feature 内部 |
| Auth / permissions / secrets | no | 只读既有 `GET /api/workspaces`（本账号），401 走既有通知 |
| File IO / path safety / overwrite | no | 不渲染空间根路径 |
| Config / project setup | no | 无 |
| Resource limits / large input / discovery | no | 单次线性遍历；列表规模由既有 `GET /api/sessions` 决定 |
| Release / packaging / dependency compatibility | no | 不加依赖；`filter` 图标已由 #529 注册 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进两个新文件；既有测试只做 design D7 的改动，不增长（一行映射例外见父 tasks 头部 7.1 条）。
- [ ] RED 集合 = G1–G5、S1–S10、S12；S11 实现前即绿。实现前后各跑一次并记录命令与结果。
- [ ] `page.tsx`：基线 659，合入后 ≤669，PR 记录两个数。
- [ ] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0；`openspec validate session-sidebar-partitions --strict --no-interactive` 通过。
- [ ] 一次性真实浏览器观察（390×844 与 1440×900）结果写进 PR 与 #715。
