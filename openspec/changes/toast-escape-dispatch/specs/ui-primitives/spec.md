## ADDED Requirements

### Requirement: Escape 分派不受 Toast 层栈影响
Toast 与 `Dialog`/`ConfirmDialog`/`Drawer` 共用 Radix DismissableLayer 的模块级层栈，document 上的 Escape 监听只挂在最高层且交接需要一轮重新渲染。基元 SHALL 保证：焦点位于某个允许 Escape 关闭的覆盖层（`Drawer`；`dismissible` 的 `Dialog`；`ConfirmDialog`，其 Escape 视为取消）内容的 DOM 子树内时，一次 Escape 使该覆盖层的 `onOpenChange(false)` 恰被调用一次，与层栈中是否有 Toast、交接是否已完成无关；本层 Radix 已处理的 Escape SHALL 不被重复处理；嵌套层交接完成后，目标位于 portal 在外的嵌套基元（如覆盖层内的 `Menu`、`Popover`）时 SHALL 只由该基元处理，外层覆盖层不关闭；输入法组合中的 Escape SHALL 不触发兜底关闭；`dismissible=false` 的 `Dialog` 仍不因 Escape 关闭。Toast SHALL 只在 Escape 事件目标（即焦点）位于其通知区（viewport）内时响应 Escape 关闭该条；目标在通知区之外时 Escape SHALL 不关闭 Toast，Toast 按既有计时到期。

#### Scenario: Toast 在场时打开导航覆盖层后立即 Escape
- **WHEN** 窄屏已登录应用中 Toast 可见，打开 `导航` Drawer，焦点进入 Drawer 后在层栈交接完成之前（真实调度器下的同一微任务或下一个宏任务）按 Escape
- **THEN** `dialog 导航` 关闭，Toast 仍在

#### Scenario: 覆盖层打开期间出现 Toast
- **WHEN** `导航` Drawer、`dismissible` 的 `Dialog` 或 `ConfirmDialog` 已打开，随后出现一条 Toast，焦点在覆盖层内按 Escape
- **THEN** 该覆盖层的 `onOpenChange(false)` 恰调用一次（ConfirmDialog 的 `onConfirm` 未调用），Toast 仍在；`dismissible=false` 的 `Dialog` 同样情形下 `onOpenChange` 未调用

#### Scenario: 无 Toast 时不重复关闭，嵌套菜单只关自己
- **WHEN** 无 Toast 时在 Drawer 或 Dialog 内按 Escape；或在 `导航` Drawer 内打开用户 Menu、层栈交接完成后按 Escape
- **THEN** 前者 `onOpenChange(false)` 恰调用一次；后者只有 Menu 关闭、`dialog 导航` 仍在，再按一次 Escape 才关闭 Drawer

#### Scenario: 焦点不在通知区时 Escape 不关 Toast
- **WHEN** 无覆盖层打开，Toast 可见，Escape 的事件目标为页面其它元素；另一次事件目标在 toast 内
- **THEN** 前者 Toast 仍在，推进 2400ms 后消失；后者 Toast 关闭
