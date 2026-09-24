# Proposal: ui-toast-primitives（#279）

## Why
S1e 组 1 第五刀（组 1 收尾）。本仓无任何 Toast 基元：会话页 `复制` 失败提示（4.6）、越权 toast（audit §4:84）等待可用的通知通道；空态目前只是 `.ui-empty`（`styles.css:170-176`，纯布局类）加各页自写文案（`files/page.tsx:191`、`files/tree.tsx:227`、`files/preview.tsx:271`、`chat/conversation-view.tsx:218`、`routes/router.tsx:151`），没有 demo 的 icon/title/desc 三段形态。同时 issue 要求把"feature/routes 不直接 import `@radix-ui`"的依赖方向变成 grep 守卫（`web/src/ui/**/*.tsx` 无 `style={` 的守卫已在 #275 落地：`ui-guardrails.test.ts:59`）。demo 契约：`resource/workbuddy-live-demo.html:752-759`（`.toast-stack` 顶部 52px 居中、z 2000、`.toast` 卡片 + 三类型图标色、`:759 .leaving`）、1044-1052（`toast(message,type)`：2400ms 后离场、图标 success=checkCircle / error=alertTriangle / info=info）、724-728（`.empty-state`/`.empty-icon` 64px 圆角 20/`.empty-title`/`.empty-desc`）。

## What Changes
- 新增 `web/src/ui/toast.tsx`（`ToastProvider` + `useToast`，基于 `@radix-ui/react-toast`）与 `toast.css`；`web/src/ui/empty-state.tsx`（`EmptyState`）与 `empty-state.css`；`ui.css` +2 `@import`。
  - `ToastProvider({ children })`：内含 Radix `Toast.Provider duration={2400} label="通知"`、自有队列 context（`useState<ToastRecord[]>`，`show` 追加、超过 3 条丢弃最旧、Radix `onOpenChange(false)` 时移除）与 `Toast.Viewport className="ui-toast-viewport" label="通知"`（Radix 输出 `role="region"` + `<ol>`；F8 热键为 Radix 默认）。每条记录渲染 `Toast.Root type="background"`（Radix 用 `aria-live="polite"` 的隐藏播报区宣读，符合父 spec）+ 类名 `ui-toast ui-toast--<type>` + `Icon`（success `circle-check` / error `triangle-alert` / info `info`）+ `Toast.Description className="ui-toast-message"`。
  - `useToast()`：返回 `{ show({ type, message }) }`；Provider 外调用抛 `Error("useToast 须在 ToastProvider 内使用")`。
  - `EmptyState({ icon?, title, description?, children? })`：`div.ui-empty-state` > 可选 `div.ui-empty-state-icon`（`Icon size={20}` + css 放大到 28px）+ `p.ui-empty-state-title` + 可选 `p.ui-empty-state-desc` + 可选 children（操作区）。新类名不与既有 `.ui-empty` 撞名（既有类与消费者在迁移切片前不动）。
- 应用根：`web/src/main.tsx` 以 `<ToastProvider>` 包裹 `<RouterProvider>`；jsdom 页面级 fixture `web/test/render-app-router.tsx` 同步包裹（引入方 `chat-page-support.tsx`、`files-fixture.tsx`；`main.test.tsx` 经真实 `main.tsx` 已覆盖）。仍直接自挂 `<RouterProvider>`/`<ChatPage>` 的测试（`routes.test.tsx`、`auth-router.test.tsx`、`settings-footer.test.tsx`、`auth-session-client.test.tsx`、`chat-page-lifecycle-support.tsx`）本切片不包——无消费者，包了也无断言；4.6 让 `ChatPage` 调用 `useToast()` 时必须同 PR 包裹（design.md Sibling surfaces 列出行号）。
- `web/src/ui/index.ts` 增量导出 `ToastProvider`、`useToast`、`EmptyState`；`Icon` 名集合 +`circle-check`。
- 守卫：`ui-guardrails.test.ts` 新增用例——`web/src/features/**`、`web/src/routes/**` 的 `.ts/.tsx` 无 `from "@radix-ui/` 直接 import（`web/src/ui/**` 豁免）；既有 `style={` 用例保持。
- 单测 `web/test/ui-toast.test.tsx`（fake timers：出现/2.4s 移除/上限 3 条丢最旧/aria-live 播报区/Provider 外抛错/根挂载静态断言）与 `web/test/ui-empty-state.test.tsx`（三段/无 desc/children/icon aria-hidden）。
- 新依赖 `@radix-ui/react-toast`（MIT）；`ATTRIBUTION.md` §3 Radix 条目登记并删除"toast 由 #279 安装"尾句。

## Non-goals
消费 Toast 的 feature（4.6 复制失败等）；把既有 `.ui-empty` 消费者迁到 `EmptyState`（各页面切片）；离场动画（demo `.leaving` 260ms 淡出——记录移除即卸载，见偏差 3）；手动关闭按钮、操作按钮、滑动关闭方向定制（Radix 默认 `right`）、hover 暂停以外的计时策略；`Icon` size 枚举扩 28（用 css 放大）。

## Capabilities
### Modified
- `ui-primitives`：「基元组件库」整体重述，加入 Toast/EmptyState 契约与依赖方向守卫。

## Impact
- `web/package.json`（+`@radix-ui/react-toast`）、`package-lock.json`；`web/src/ui/{toast,empty-state}.{tsx,css}`、`ui.css`、`index.ts`、`icon.tsx`；`web/src/main.tsx`；`web/test/render-app-router.tsx`、`web/test/ui-guardrails.test.ts`、`web/test/ui-icon-brand.test.tsx`（名清单 +1）、新两份测试；`ATTRIBUTION.md`。
- `main.tsx` 改动使 Radix Toast 进入 `web/dist`（首个真正进产物的 Radix 覆盖层包）；`make ui-walk` 不变（Viewport 无 toast 时 `pointer-events:none`、无可见元素）。knip：`ToastProvider` 由 main.tsx 消费，`useToast`/`EmptyState` 由测试消费。

### 与 oracle / demo 的偏差留痕
1. 图标尺寸：demo toast 图标 15px、空态图标 28px；`Icon` size 枚举为 12–20，分别用 `Icon size={16}` + css `.ui-toast .ui-icon{width:15px;height:15px}`、`Icon size={20}` + css 放大到 28px，不扩枚举。
2. success 图标 demo 为 `checkCircle`，lucide 对应 `CircleCheck`（`circle-check`）。
3. 无离场动画：Radix `onOpenChange(false)` 即从队列移除并卸载（demo `.leaving` 260ms 淡出不移植），reduced-motion 下亦无差异。
4. 上限 3 条的丢弃策略 demo 未定义（demo 无上限）：本仓丢最旧。
5. Viewport 可访问名 `通知`（Radix 默认 "Notifications ({hotkey})"）；F8 热键沿用 Radix 默认。
6. issue 写"`web/src/ui/**/*.tsx` 无 `style={`"守卫为新增项，实际 #275 已落地（`ui-guardrails.test.ts:59`），本切片只新增 `@radix-ui` 依赖方向守卫。

## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：应用根 Provider 树改动 + 被 4.6 与后续页面切片继承的通知/空态契约)
Blast radius: `main.tsx` 是唯一入口，Provider 包裹错位会影响全部路由；`render-app-router.tsx`（chat-page*/files-* 两组测试的 fixture）不同步包裹、或 4.6 漏包五处直接自挂 Router/ChatPage 的测试，会让消费 `useToast()` 的页面测试整体抛错；上限/计时若写在 Radix 之外的手写定时器会与 Radix 暂停/恢复语义冲突。
Selected risk packs: Public API / CLI / script entry（`useToast`/`ToastProvider`/`EmptyState` 契约与出口）；Config / project setup（Radix 依赖、应用根与 jsdom fixture 包裹、ATTRIBUTION、守卫用例）；Legacy compatibility / examples（既有 `.ui-empty`/`.ui-alert` 与消费者不动，`main.test.tsx` 三用例不变）；Concurrency / shared state / ordering（队列上限、Radix 计时与 hover 暂停、多条并发移除）；Error handling / rollback / partial outputs（Provider 外调用抛明确错误）；Release / packaging / dependency compatibility（react-toast 首次进产物、jsdom fake timers 与 Radix `window.setTimeout`）；Documentation / migration notes（4.6 与页面切片的消费方式）。
Evidence floor: `make check` exit 0；两份测试先红后绿，出现/移除/上限/aria-live/Provider 外抛错各有可判别断言；`npm run build --workspace web` 通过；`make ui-walk`（CI 环境变量方式）exit 0。
