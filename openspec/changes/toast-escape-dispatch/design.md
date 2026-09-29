# Design: toast-escape-dispatch（#643）

Change surface:
- `web/src/ui/toast.tsx`：`ToastPrimitive.Root` 增 `onEscapeKeyDown`。
- `web/src/ui/` 新增一个小 hook（例如 `escape-fallback.ts`）：返回 `{ onEscapeKeyDown, onKeyDown, ref }` 三件，供 Radix Dialog Content 使用。
- `web/src/ui/drawer.tsx`、`web/src/ui/dialog.tsx`（`DialogFrame`，覆盖 `Dialog` 与 `ConfirmDialog`）接上该 hook。

Must preserve:
- Toast：焦点在 toast 内时 Escape 关闭该条（`web/test/ui-toast.test.tsx` A7/A9），到期、悬停/聚焦暂停、epoch 重挂、最多 3 条的语义不变。
- Drawer/Dialog：Radix 层为最高层时 Escape 仍由 Radix 关闭且 `onOpenChange(false)` 恰一次；`dismissible=false`（`closeOnEscape=false`）时 Escape 不关闭；ConfirmDialog 的 Escape 视为取消；焦点进入/循环/归还（`useFocusHandoff`、`app-shell-responsive.test.tsx` R6 等）不变。
- 覆盖层内经 portal 渲染的嵌套基元（Drawer 侧栏里的用户 Menu、Dialog 内的 Popover）：Escape 只关它自己，外层覆盖层不动。
- 基元公共 props 不变；feature/routes 零改动。

Must add/change:
1. Toast Root `onEscapeKeyDown(event)`：若原生 `KeyboardEvent.target` 不在本 Provider 的 viewport（`.ui-toast-viewport` 的 `ol`，含其内 toast）内，`event.preventDefault()`——Radix 因此跳过 `handleClose`，Toast 保持到到期。目标在 viewport 内时不干预。判定用事件目标而非 `document.activeElement`：Radix 从两处调用该回调（层的 document 捕获监听、toast `li` 的 React `onKeyDown`，`react-toast/dist/index.mjs:403-406`），既有 A7/A9（`ui-toast.test.tsx:138`、`:151`）直接向 toast 派发 keyDown 而不移动焦点；真实按键的目标即焦点元素，两者等价。
2. 兜底 hook（Drawer 与 DialogFrame 共用，传入「Escape 时的关闭动作」与「是否允许 Escape 关闭」）：
   - `onEscapeKeyDown(event)`：本层 Radix 分派到本层时调用；记下「本次原生事件已由本层处理」（引用该 `KeyboardEvent`），再执行原有逻辑（DialogFrame 在 `!closeOnEscape` 时 `preventDefault`）。
   - `onKeyDown(event)`（Content 的 React 事件）：当 `event.key === "Escape"`、`!event.nativeEvent.isComposing`、事件目标在本 Content 的 DOM 子树内（`ref.current.contains(target)`，portal 出去的嵌套基元不算）、且本次原生事件**不是**本层已处理的那一个时，若允许 Escape 关闭则调用 `onOpenChange(false)`。不看 `defaultPrevented`：Toast 层的 `preventDefault` 与本层无关。
   - 次序依据：Radix 的 Escape 监听在 document 捕获阶段，先于 React 在根容器上的委托处理，所以「本层已处理」的标记总在 `onKeyDown` 之前写好。
3. 两条修改合起来的效果：Escape 时若最高层是 Toast 且焦点在覆盖层内——Toast 不关（1），覆盖层由兜底关闭（2）；若最高层是覆盖层本身——Radix 关闭，兜底识别为已处理，不重复调用。

Governing invariant: 焦点在某个可由 Escape 关闭的覆盖层内容里按一次 Escape，该覆盖层恰好关闭一次，与层栈里是否存在 Toast、层栈交接是否完成无关；焦点不在 toast 内时 Escape 不关闭 Toast。

Sibling surfaces:
- `ConfirmDialog` 经 `DialogFrame`（`closeOnEscape` 恒真 → Escape 取消），`Dialog` 的 `dismissible`。
- `Popover`、`Menu`、`Tooltip` 同样是 DismissableLayer：Toast 在场时它们的 Escape 也可能被接走。本刀不改（Non-goals）。兜底的 `contains` 条件保证 portal 在外的 Popover/Menu 的 Escape 不会误关外层覆盖层；Tooltip 除外（焦点留在覆盖层内的触发器上，兜底会连带关闭外层），目前生产上 Tooltip 只用于收起的内联侧栏（`sidebar.tsx:110`），不会出现在覆盖层内。
- 生产消费者：`app-shell.tsx:30` 的侧栏 Drawer；所有 `Dialog`/`ConfirmDialog` 使用点（auth 退出、files 对话框、工作空间创建等）。
- 诊断测试 `web/test/ui-toast-drawer-escape.test.tsx`：只在真实调度器下（`IS_REACT_ACT_ENVIRONMENT=false`、原生事件派发）才能看到交接窗口；act 版测试在 master 上是绿的，不得把这组测试简化为 act 版。

Seams under test: 真实应用壳（窄屏 matchMedia + `ToastProvider` + `RouterProvider`，同诊断测试的挂载）；单独渲染的 `Dialog`/`ConfirmDialog`/`Drawer` + `ToastProvider` 探针；`ui-toast.test.tsx` 既有探针。

Required evidence:
- 诊断测试收敛为回归闸门：删除 T1-act-same 与 T1-real-sync（Escape 时 Drawer 尚未进入 DOM，不属本缺陷）与已删的边界变体；保留其余变体，并在每个变体里增加断言「Escape 后 Toast 仍在」（到期变体除外）。T1-real-microtask、T1-real-macrotask-1、T2-appear 在 master 上为红，修复后全部为绿。
- D1 `Dialog`（dismissible）打开 → Toast 出现（T2 式，Toast 后入栈）→ 焦点在对话框内按 Escape → `onOpenChange(false)` 恰一次，Toast 仍在。
- D2 `Dialog dismissible={false}` + Toast → Escape → `onOpenChange` 未调用、对话框仍在。
- D3 `ConfirmDialog` + Toast → Escape → `onOpenChange(false)` 恰一次（取消），`onConfirm` 未调用。
- D4 无 Toast 时 Drawer 与 Dialog 的 Escape → `onOpenChange(false)` 恰一次（证明兜底不重复）。
- D5 窄屏 Drawer 内打开侧栏用户 Menu → Escape → Menu 关闭、`dialog 导航` 仍在；再 Escape → Drawer 关闭。
- D6 Toast：无覆盖层、焦点（即 Escape 事件目标）在页面其它元素时 Escape → Toast 仍在，推进 2400ms 后消失；事件目标在 toast 内时 Escape → 关闭（A7 语义，A7/A9 不改）。
- 红与变异：上述三个候选 A 变体、D1、D3、D6 第一段在 master 上为红。变异：去掉 Toast 的 `preventDefault` → 各变体「Toast 仍在」与 D6 红；去掉兜底 → T1-real-microtask、T1-real-macrotask-1、T2-appear、D1、D3 红；去掉「本层已处理」识别 → D4 红（两次调用）；去掉 `contains` 条件 → D5 红。
- 编排者另做：真实浏览器 `mobile-dark`（390×844）下，Toast 可见时打开 `导航` 覆盖层并立即按 Escape，覆盖层关闭；连跑 ≥10 次全绿，不借助 `page.evaluate` 探针或等 Toast 消失。

Review focus:
1. 兜底只在事件目标位于本 Content DOM 内、且本层未处理时触发；不重复调用 `onOpenChange`。
2. `dismissible=false` 与 ConfirmDialog 的 Escape 语义不变。
3. Toast 焦点判定用 viewport 容器，焦点在 toast 内的既有关闭路径不受影响。
4. 诊断测试保持真实调度器，没有退化为 act 版。

Non-goals:
- Popover/Menu/Tooltip 在 Toast 在场时的 Escape（同一层栈问题，影响更小，另议）。
- 撤掉 #484 fixture 的「等 Toast 消失」。
- 嵌套层刚打开、层栈交接完成之前的窗口：例如 Drawer 内刚打开用户 Menu 时，Drawer 仍是最高层，其 Radix 处理会关闭 Drawer。这是 master 既有问题，本刀不修。
- 升级 Radix 或替换层栈策略。

Open Questions: 无。
