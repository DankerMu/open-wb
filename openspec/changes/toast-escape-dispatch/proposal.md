# Proposal: toast-escape-dispatch（#643）

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (override: 共享的 Radix 层栈交接时序，跨 Toast/Drawer/Dialog 三个基元)
Blast radius: 修错会让 Escape 关错层（关掉覆盖层内嵌菜单的同时关掉覆盖层、dismissible=false 的对话框被 Escape 关闭）、双重 onOpenChange，或 Toast 的焦点内 Escape 关闭失效
Selected risk packs: Concurrency/ordering; Legacy compatibility; Public API (基元行为); Documentation
Evidence floor: 诊断测试的候选 A 变体（T1-real-microtask、T1-real-macrotask-1、T2-appear）在 master 上红、修复后绿；新增 Dialog/ConfirmDialog 与内嵌菜单用例；ui-toast 与 app-shell-responsive 既有测试不回归；真实浏览器 mobile-dark ≥10 次连跑全绿；make check；openspec validate --strict
```

## Why
诊断（jsdom，真实调度器，不在 act 内）确认是候选 A：Radix 的 DismissableLayer 层栈是模块级共享的（Toast 的每条 Root 也是一层），document 上的 Escape 监听只挂在「最高层」，交接要等一轮重新渲染。于是：
- Toast 可见时打开窄屏 `导航` Drawer，Drawer 已在 DOM、焦点已进入之后还有约 1–2 个宏任务，Escape 仍由 Toast 层接收：Toast 随 Escape 消失，Drawer 不动，要再按一次（T1-real-microtask、T1-real-macrotask-1）。
- Drawer 打开期间出现 Toast，Toast 层后入栈成为最高层，在它 2.4s 的整个存活期内 Escape 都只关 Toast（T2-appear，不依赖时序）。
- 候选 B（Toast 到期卸载 / epoch 重挂）已排除：两条路径下接收 Escape 的都是 Drawer 层。
- 所有红的变体里，Escape 发生时 Drawer 层都没有监听；因此只让 Toast 不关自己，Escape 会变成空操作，覆盖层必须自己兜底。

2026-09-29 owner 拍板：诊断为 A 则按 issue 推荐修复。

## What Changes
- `web/src/ui/toast.tsx`：Toast Root 的 `onEscapeKeyDown` 在 Escape 事件目标不在通知区（viewport）内时 `preventDefault`，被动的 background Toast 不再被全局 Escape 关闭；事件目标在 toast 内时 Escape 照旧关闭该条。
- 新的共享兜底（`web/src/ui/` 内一个小 hook，Drawer 与 Dialog 内核共用）：覆盖层 Content 的 React `onKeyDown` 收到 Escape、事件目标在本 Content 的 DOM 内、且本层 Radix 的 `onEscapeKeyDown` 没有处理这次按键时，按本层的关闭规则关闭（Drawer 恒关闭；Dialog 仅在 `dismissible`/`closeOnEscape` 为真时，ConfirmDialog 视为取消）。
- spec：ui-primitives ADDED「Escape 分派不受 Toast 层栈影响」。

## Capabilities
- ADDED ui-primitives「Escape 分派不受 Toast 层栈影响」。
- MODIFIED ui-primitives「基元组件库」：只给 Toast 的 Escape 关闭措辞加「事件目标在通知区内」的限定，与新需求一致（审查第 1 轮 integration 指出的字面冲突）。

## Impact
- `web/src/ui/toast.tsx`、`drawer.tsx`、`dialog.tsx`（及新 hook 文件）。无服务端改动。
- 行为变化：没有覆盖层时，焦点不在 toast 内按 Escape 不再关闭 Toast（等 2.4s 到期）；这是 issue 推荐方案的一部分。
- 不在范围：Popover/Menu（同一层栈问题理论上存在，影响更小，记入 Non-goals）；撤掉 #484 fixture 的「等 Toast 消失」。
