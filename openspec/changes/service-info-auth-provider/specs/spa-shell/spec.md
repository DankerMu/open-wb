## MODIFIED Requirements
### Requirement: 设置页
设置页 SHALL 含且仅含两张设置卡：`外观`与`关于`（另有页面标题 `设置`，无 `通用` 卡）。外观卡 SHALL 提供 `浅色`、`深色`、`跟随系统` 三个可访问单选项，默认档为 `跟随系统`；所选值 SHALL 以 production key `workbuddy-theme` 持久化为 `light|dark|system`，并把解析结果 `light|dark` 写到 `document.documentElement[data-theme]`。初始 storage 缺失、未知或读取抛错时 SHALL 选择 system；写入抛错不得破坏当前内存选择或向 UI 抛错，刷新后按可读取值（不可读即 system）重新初始化。system 使用唯一 query `(prefers-color-scheme: dark)`，系统偏好 change 时实时更新；固定 light/dark 不改变。`storage` 事件只在 key 为 `workbuddy-theme` 时同步其他 tab，null/unknown 归一化为 system；所有 listener 在 owner 卸载时移除。`当前生效`行 SHALL 恰为 `当前生效：浅色|深色`。

关于卡 SHALL 在 mount 时经 Provider-owned API operation 请求 `GET /api/info`（relative path、`credentials:"same-origin"`、`cache:"no-store"`），但已有退出请求进行中时 Provider SHALL 返回 null，不启动 info operation、不发起该 GET、不打断退出；About 结束 loading 并显示稳定失败提示，退出结束后的新 mount 恢复普通读取。普通读取 loading 显示 `正在读取服务信息`；只接受恰为 `{name:string,version:string,auth:{provider:string}}`、非空 name、version 符合共享 semver contract、`auth` 恰含非空 `provider` 的 body，成功逐字展示 name 与 `版本 <version>`（provider 不在关于卡展示，仅供登录页快捷登录门控）。非 401 合法错误信封显示其 message；malformed/non-JSON/network 显示 `请求失败，请稍后重试`；current 401 依全局规则清 Principal。About component SHALL 在 effect cleanup 时 abort caller lifecycle signal，Provider SHALL 将其单向链接到自己的 operation controller，故离开设置 route element、更新 Provider operation或 app unmount 任一情况都 abort 传给 fetch 的 signal并移除 linkage；迟到响应不得写 UI/auth state。Provider 不感知 router/location。若 info 被 sibling operation supersede且该 operation 非 401 失败后 authenticated settings 仍 mounted，About SHALL 结束 loading并显示 `请求失败，请稍后重试`，不得永久停在 loading。不得硬编码 demo 的 `WorkBuddy`/`5.3.11` 作为成功 fallback。

#### Scenario: 主题切换即时生效
- WHEN 切换到 `深色`
- THEN 该选项立即选中，根元素 `data-theme` 变为 `dark`，`当前生效：深色` 可见，storage 写入 `workbuddy-theme=dark`；重新 mount 仍为深色

#### Scenario: 跟随系统
- WHEN 选择 `跟随系统` 且系统为深色，随后系统改为浅色
- THEN 先呈现 `当前生效：深色`/`data-theme=dark`，change 后呈现 `当前生效：浅色`/`data-theme=light`，持久化值仍为 `system`

#### Scenario: 存储失败与跨 tab 同步
- WHEN storage 初始读取抛错，或收到 `workbuddy-theme` 的 storage event
- THEN 读取失败稳定按 system 渲染且无异常；有效 event 值同步档位/解析结果，null/unknown event 值同步为 system，其他 key 不改变主题

#### Scenario: 关于卡真实版本
- WHEN 打开设置页且 `/api/info` 返回 `{name:"workbuddy-app-server",version:"0.0.0",auth:{provider:"dev-stub"}}`
- THEN 关于卡展示 `workbuddy-app-server` 与 `版本 0.0.0`，不展示 demo 版本 `5.3.11`，不展示 provider

#### Scenario: 关于卡失败
- WHEN `/api/info` 返回 malformed success（含缺失 `auth`、多余键或旧的 `{name,version}` 两键形状）、非 JSON 或网络失败
- THEN 关于卡显示稳定回退 `请求失败，请稍后重试`，不泄漏 response/transport details 或伪造 name/version
