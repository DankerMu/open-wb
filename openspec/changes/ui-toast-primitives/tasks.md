# Tasks: ui-toast-primitives（#279）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（revise ×2：消费者清单/A5 事件目标/rAF 事实/tasks 2.2 措辞）；`openspec validate ui-toast-primitives --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 新建 `web/test/ui-toast.test.tsx`（Seams A1–A9）、`web/test/ui-empty-state.test.tsx`（E1–E4）；`ui-guardrails.test.ts` 新增依赖方向用例 (G)；`ui-icon-brand.test.tsx` 名清单 +`circle-check`；先红。
- [x] 2.2 `npm i -w web @radix-ui/react-toast`；`web/src/ui/{toast,empty-state}.{tsx,css}`；`ui.css` +2 `@import`；`index.ts` +3；`icon.tsx` +`circle-check`；`main.tsx` 与 `web/test/render-app-router.tsx` 以 `ToastProvider` 包裹 `RouterProvider`；2.1 转绿；`main.test.tsx`、`render-app-router` 的两个引入方（chat-page*/files-* 两组测试）以及五处未包裹的直接挂载点（design.md Sibling surfaces）仍绿。
- [x] 2.3 反向注入九项各红并回退（修复通道 1 补：`dismiss` 不递增 `epoch` → (A9)、`ICONS.success` 改 `info` → (A2)；修复通道 2 补：`children` 移回 keyed Provider 内 → (A9) 重挂断言）：去 `.slice(-MAX_TOASTS)` → (A4)；去 `type="background"` → (A2)；`onOpenChange` 不移除 → (A3)；`useToast` 不抛错 → (A6)；`main.tsx` 去包裹 → (A8)；feature 临时直接 import `@radix-ui` → (G)。
- [x] 2.4 `ATTRIBUTION.md:37` 登记 `@radix-ui/react-toast` 并删除"toast 由 #279 安装"尾句；`ui-guardrails.test.ts` Radix 包断言绿。

## 3. Verification
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 `ci-compiled-server.sh ui-walk`（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：`ToastProvider`/`useToast`/`EmptyState` 契约与出口、`Icon` 名 +1——2.1/2.2 RTL + 出口导入断言 (A8)。
- Selected Config / project setup：Radix 依赖、应用根与 jsdom fixture 包裹、ATTRIBUTION、守卫用例——2.2/2.4 + (A8)/(G) + 3.1 knip。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：无数据结构。
- Not selected Auth / permissions / secrets：不触碰。
- Selected Concurrency / shared state / ordering：队列上限与函数式更新、Radix 计时/暂停/多条并发移除——(A3)/(A4)/(A5)。
- Not selected Resource limits / large input / discovery：上限 3 条即资源边界，已归 Concurrency 覆盖。
- Selected Legacy compatibility / examples：`.ui-empty`/`.ui-alert` 与消费者不动、`main.test.tsx` 与 `render-app-router` 引入方不变——既有 `web/test` 绿 + 3.3 ui-walk。
- Selected Error handling / rollback / partial outputs：Provider 外调用抛明确错误——(A6)。
- Selected Release / packaging / dependency compatibility：react-toast 首次进产物、fake timers 与 Radix 计时——3.2 build + (A3)。
- Selected Documentation / migration notes：design.md Sibling surfaces 记录 4.6 消费方式与 `.ui-empty` 迁移清单；ATTRIBUTION——2.4。
