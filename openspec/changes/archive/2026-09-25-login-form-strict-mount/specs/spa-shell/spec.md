## ADDED Requirements

### Requirement: 登录表单在 StrictMode 下失败后可重试
登录表单的挂载标记 SHALL 在挂载 effect 体内置为已挂载、在 cleanup 中置为未挂载，使 React StrictMode 的模拟卸载→重挂之后组件仍被视为已挂载。登录请求（表单提交或快捷登录卡）失败后，无论是否处于 StrictMode，表单 SHALL 清空密码框、解除提交锁并恢复提交按钮可用，后续提交 SHALL 再次发出登录请求；登录成功导致表单卸载后 SHALL NOT 再写入其状态或 DOM。

#### Scenario: StrictMode 下表单登录失败后可重试
- **WHEN** 在 `<StrictMode>` 中渲染登录页，填写账号密码提交，`/api/auth/login` 返回 401 且错误行出现
- **THEN** 提交按钮可用、密码框为空；再次提交发出第 2 次 `/api/auth/login` 请求

#### Scenario: StrictMode 下快捷登录失败后可重试
- **WHEN** 在 `<StrictMode>` 中渲染 dev-stub 登录页，点击一张快捷登录卡，`/api/auth/login` 返回 401
- **THEN** 快捷登录卡与表单恢复可用；再次点击快捷登录卡发出第 2 次 `/api/auth/login` 请求
