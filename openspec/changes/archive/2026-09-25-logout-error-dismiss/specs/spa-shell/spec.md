## ADDED Requirements

### Requirement: 退出失败提示可关闭
侧栏用户区的退出失败提示（`role="alert"`，文本内容恰为错误信封 message）SHALL 在提示内提供一个仅图标的关闭按钮（accessible name `关闭提示`），在展开、折叠浮出与窄屏覆盖层三种呈现下一致。点击后 SHALL 移除该提示、将焦点移到 `用户菜单` 触发器，且不改变侧栏折叠状态与其持久化值、不发任何请求；关闭状态 SHALL 由认证 Provider 持有，使窄屏覆盖层关闭后重开仍不再显示已关闭的提示。之后再次退出失败 SHALL 重新显示提示。退出进行中的状态提示不提供关闭按钮。

#### Scenario: 折叠态关闭退出失败提示
- **WHEN** 桌面视口下折叠侧栏，经 `用户菜单` → `退出登录` → `退出` 发起退出且返回 403，浮出的 `role="alert"` 出现后点击 `关闭提示`
- **THEN** 该 alert 消失，焦点位于 `用户菜单`，侧栏 `data-collapsed` 仍为 `true`

#### Scenario: 关闭后再次失败重新显示
- **WHEN** 关闭提示后再次经 `用户菜单` 发起退出，且以与上次相同的 message 再次失败
- **THEN** `role="alert"` 重新出现，文本内容恰为该 message

#### Scenario: 窄屏覆盖层重开不复现已关闭提示
- **WHEN** 窄屏覆盖层内退出失败、点击 `关闭提示`，随后关闭覆盖层再重开
- **THEN** 覆盖层内不再出现该 `role="alert"`

#### Scenario: 退出进行中无关闭按钮
- **WHEN** 折叠侧栏后发起一个挂起的退出请求，状态提示出现
- **THEN** 不存在 accessible name 为 `关闭提示` 的按钮
