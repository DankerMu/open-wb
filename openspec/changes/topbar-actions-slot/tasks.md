# Tasks: topbar-actions-slot（#529）

## 7. web — 顶栏 actions 插槽（父 tasks 7.0 原文）

- [x] 7.0 `web/src/ui/icon.tsx` 只注册 master 尚缺的十个：`star`、`pencil`、`trash`、`more-horizontal`、`package`、`download`、`globe`、`palette`、`chevron-up`、`filter`（`folder`/`search`/`code`/`image`/`file-code`/`file-text`/`message-square`/`file-spreadsheet`/`layout-grid`/`chevron-right` 已在 master，A 加 `square`/`refresh-cw`/`git-branch`；重复登记即 TS1117）；`web/src/lib/topbar.tsx` context 增 `actions: readonly TopbarAction[]`（描述符 `{key, label, icon, expanded?, onSelect(trigger)}`），`useTopbar({breadcrumb, actions})` layout effect 上报、Provider 仅在 `key/label/icon/expanded` 浅比较变化时 setState、`onSelect` 经 ref 读最新闭包、卸载/未提供时清空；`routes/shell/topbar.tsx` 在 h1 之后渲染 `.topbar-actions`（ghost icon Button，accessible name 与 Tooltip 为 `label`，`expanded` 定义时带 `aria-expanded`；h1 名不含按钮）；无 actions 时三态 DOM 不变。验证：新建 `web/test/topbar-actions.test.tsx`：注入/清空/顺序/`aria-expanded`、每次渲染新回调不触发重复上报、无 actions 时与既有快照一致；既有 shell 测试不改动全绿

> 另加一条 `web/src/routes/shell/topbar.css` 的 `.topbar-actions` 规则（proposal「偏差」1）。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `useTopbar`/`TopbarAction`/按钮语义是后续三刀的公共契约 → 证据 1–4、6 |
| Concurrency / shared state / ordering | yes | effect 不成环、最新闭包、清空与恢复、StrictMode、路由交接、顺序 → 证据 4、5、8、12、13 |
| Legacy compatibility / examples | yes | 无 actions 时三态不变、既有 shell 测试零 diff → 证据 7、9、11、既有测试 |
| Release / packaging / dependency compatibility | yes | lucide 导出存在、不重复登记 → 证据 10、`make typecheck` |
| Auth / permissions / secrets | no | 纯前端呈现通道 |
| File IO / path safety / overwrite | no | 无 |
| Error handling / rollback / partial outputs | no | 无异步与失败路径 |
| Schema / columns / units / field names | no | 无 |
| Config / project setup | no | 无 |
| Resource limits / large input / discovery | no | 按钮数由页面常量决定（≤3） |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [x] 新测试进新文件；既有 shell 测试与 `web/src/features/chat/**` 零 diff（本刀不记录 `page.tsx` 预算基线）。
- [x] RED 集合以 design「Required evidence」括注为准：先实现前跑红，再实现跑绿（记录命令与结果）。
- [x] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate topbar-actions-slot --strict --no-interactive` 通过。
