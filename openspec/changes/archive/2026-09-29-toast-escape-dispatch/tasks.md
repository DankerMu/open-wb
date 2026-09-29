# Tasks: toast-escape-dispatch（#643）

## 1. 实现

- [x] 1.1 Toast Root `onEscapeKeyDown`：Escape 事件目标不在通知区时 `preventDefault`（design「Must add/change」1）。
- [x] 1.2 兜底 hook，接入 `drawer.tsx` 与 `dialog.tsx` 的 `DialogFrame`（design 2）。

## 2. 测试

- [x] 2.1 诊断测试 `web/test/ui-toast-drawer-escape.test.tsx` 按 design 收敛为回归闸门（保持真实调度器）；新增 D1–D6。
- [x] 2.2 红与变异按 design「Required evidence」末两条逐字执行，结果逐条写入报告。
- [x] 2.3 全部既有 web 测试全绿（重点：`ui-toast`、`app-shell-responsive`、`ui-primitives*`、auth 退出与 files 对话框相关测试）；如有期望改动，只允许加强断言并逐条列出。

## 3. 验证

- [x] 3.1 `make check`（Node 24.13.1）、`bash scripts/size-guard.sh` 退出 0。
- [x] 3.2 `openspec validate toast-escape-dispatch --strict --no-interactive` 通过。
- [x] 3.3（编排者）真实浏览器 mobile-dark ≥10 次连跑（design「Required evidence」末条）。
- [x] 3.4（编排者）归档 PR：ADDED 需求，父 change 均无 ui-primitives delta，无需同步。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 共享层栈、交接时序、document 捕获与 React 委托的先后 → 诊断闸门、D1、D4 |
| Legacy compatibility / examples | yes | Toast 焦点内 Escape、dismissible、ConfirmDialog 取消、焦点归还 → D2、D3、D6、2.3 |
| Public API / CLI / script entry | yes | 基元行为契约（ui-primitives）变化：焦点外 Escape 不关 Toast → D6、spec |
| Documentation / migration notes | yes | ui-primitives ADDED → spec delta |
| Error handling / rollback / partial outputs | no | 无异步失败路径 |
| Resource limits / large input / discovery | no | 不涉 |
| Config / project setup | no | 不涉 |
| File IO / path safety / overwrite | no | 不涉 |
| Auth / permissions / secrets | no | 不涉 |
| Schema / columns / units / field names | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不升级 Radix |

## 通用纪律

- [x] 源码边界：`web/src/ui/toast.tsx`、`drawer.tsx`、`dialog.tsx` 与新 hook 文件；feature/routes、server 零 diff。确需改动时先停下上报。
- [x] 不提交、不推送、不开 PR；报告改动文件、验证命令与结果、偏离（逐条写「内容/原因/影响」，没有就写「无偏离」）。
