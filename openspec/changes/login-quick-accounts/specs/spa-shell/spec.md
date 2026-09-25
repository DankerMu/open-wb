## MODIFIED Requirements
### Requirement: 登录页与路由守卫
未登录时任一受支持 SPA 路由（本阶段为 `/`、`/files`、`/center`、`/settings`）SHALL 在保持当前 browser URL 不变的情况下渲染登录页（域账号+密码），该 URL 即原目标路由；登录失败 SHALL 展示错误信封的 message 字段文案；登录成功 SHALL 在同一 URL 恢复原目标壳。登录页 SHALL 镜像 demo:1721-1752 的结构：居中卡片宽 `360px`，自上而下为品牌区（`BrandMark` 自有 mark + 字标，高度与 demo:640 的 logo 一致 `26px`，不使用上游 logo 资产）、标题 `登录 WorkBuddy`（heading level 1）、副标题 `内网统一身份 · 本实例不出网`、`账号`（placeholder `域账号，如 zhangsan`，`autocomplete=username`，mount 时自动聚焦）、`密码`（placeholder `密码`，`autocomplete=current-password`）、错误行（`role="alert"`，位于主按钮之上，展示错误信封的 message 字段文案，文本内容恰为该 message）、主按钮 `登录`（提交中显示 `正在登录` 并禁用）；登录页不渲染无后端契约支撑的控件。当 `GET /api/info` 的 `auth.provider === "dev-stub"` 时 SHALL 在按钮下方渲染 `演示账号` 提示与快捷登录列表（静态常量镜像 dev-stub seed：`zhangsan`/`zhaoliu`/`lisi` 与各自 seed 角色，前端不伪造 display name/部门/角色映射；点击即以该账号与密码 `demo` 提交）。该 info 读取由 LoginForm 在每次 mount 时以匿名 API client 发起一次（relative path、`credentials:"same-origin"`、`cache:"no-store"`；StrictMode 双 mount 下首个请求随卸载 abort），**不占用** Provider 的单槽 operation、不与 login/logout 竞争，LoginForm 卸载时 abort，失败（含 `requestFailed(0)`、malformed）不重试；provider 非 dev-stub、body 不合法或请求失败时 SHALL 不渲染该区域，且不阻塞登录表单。`lib/api` SHALL 统一解析错误信封并在当前有效 operation 或当前认证会话所属、未取消页面请求的 401 响应时进入未登录态；旧会话（包括同账号重新登录之前）或已取消请求的迟到 401 SHALL 不改变当前认证状态。

#### Scenario: 未登录重定向
- WHEN 未登录直接访问 `/files`
- THEN 渲染登录页；账号框已聚焦；登录成功后落在 `/files`

#### Scenario: 停用账号提示
- WHEN 以停用账号登录
- THEN 页面展示"该账号已停用，请联系管理员"（来自信封 message）

#### Scenario: 快捷登录仅 dev-stub 可见
- WHEN `/api/info` 返回 `auth.provider="dev-stub"`；另一次返回 `auth.provider="oidc"` 或请求失败
- THEN 前者显示 `演示账号` 提示与三张快捷登录卡，点击 `zhangsan` 卡恰发一次 login 请求且 body 为 `{account:"zhangsan",password:"demo"}`；后者不渲染该区域，登录表单正常可用；info 尚未返回时提交登录不取消也不等待 info，登录失败后快捷区状态不变

#### Scenario: 文件请求使当前会话失效
- WHEN 当前认证会话发出的未取消文件请求返回 401（包括非法信封或非 JSON）
- THEN 清除 Principal，在保持 URL 的情况下显示登录页；并发文件请求不 supersede 彼此或既有 auth operation

#### Scenario: 旧会话与取消请求隔离
- WHEN 页面请求已取消，或用户退出并以同账号重新登录后旧请求才返回 401
- THEN 新会话与受保护页面保持不变，旧响应不得清除 Principal 或提交文件 UI
