## Context

Change surface: `web/src/features/files/{page,tree}.tsx`、必要的 feature-local helpers、auth/provider.tsx、routes/router.tsx 及其测试。
当前 `/` 与 `/files` 都是占位页；父 S1a route delta 描述最终聊天页，不能提前复制。以当前主 spa-shell 完整 requirement 为基线，仅晋升本切片。
父 files-web 的渲染、安全与 64 层规范化已在主 `文件预览纯组件` 晋升，本 delta 只引用该 canonical 要求，不建第二渲染规则。

## Goals / Non-Goals

Goals: 完成 #129 的所有 UI/URL/懒加载/错误合同，并满足 #118/#119 的资源及状态生命周期义务。
Non-goals: 服务端、挂载（S1b）、聊天页、正式新增 Playwright 步骤（#133）、新依赖、通用弹窗/请求框架、认证单槽重构。
Must preserve: 四个 Provider auth operations 的 supersede/abort/current-response 行为、登录目标 URL、设置与页脚行为、错误信封、相对 API 路径、PreviewPane 安全节点投影及 64 层 strong 规则。
Governing invariant: 仅当前认证会话、当前工作空间、当前请求代际可提交 UI/auth 状态；所有分配的图片 URL 必须有唯一页面 owner 并最终释放。

## Decisions

- Provider 新增通用会话绑定 client factory（如 createSessionClient），复用 createApiClient 预接 401 callback；不暴露裸 singleton，也不往 AuthContext 填五个文件端点。文件请求不占用 AuthOperation 单槽，不互相取消。
- 显式 auth version/epoch 在建立或清除会话时更新；factory 捕获代际。仅 mounted、authenticated、代际匹配且 caller signal 未 abort 的 401 可清会话；旧会话即使同账号重新登录也无权清除新会话。版本更新不能置于会被 StrictMode 重放的 state updater/render。factory 的会话生命周期须让新会话获得新 client。
- 页面 owner 负责每请求 AbortController 与代际检查；401 terminal-silent，守卫卸载页面，不显示旧 inline 错误。Provider 不维护页面请求池。
- listWorkspaces 完成并验证 ws 属本账号前不发 tree/file。缺省/非法 ws 用 replace 纠正或移除，保留其它参数/hash；用户主动选择更新历史。workspace 子树按 ws.id remount，认证变化也隔离旧缓存。
- 树每层首次展开加载，保留服务端顺序；折叠重开复用。新建目录下拉只含根和成功加载过的目录（折叠后仍可选），不为下拉递归探测。所有 API 路径相对 workspace。
- 图片响应 stale 时立即 revoke；当前结果替换时释放旧 URL；卸载 abort 并释放当前 URL。测试须包含 fetch 忽略 abort 仍迟到分配 URL 的路径，不能只测 signal。
- workspace 切换重置所有选择及 Markdown mode；同 workspace 同文件刷新保留 PreviewPane 实例/模式，不能在 loading 时卸载该 pane。换文件由现有 PreviewPane path key 重置。
- 前端可预览集为 md/txt/log/csv/json/js/ts/tsx/html/png/jpg/jpeg（demo:3818 与服务端一致，大小写归一）；其它本地 unsupported，零 file 请求。不新增 renderer/innerHTML。
- 原型绝对路径/hash 不移植；沿用仓库 native HTML/可访问 inline 对话框，页面 chrome 唯一 h1 为工作空间；预览用户 Markdown 的 h1 仍按纯组件合同保留，不计入 chrome 标题约束。菜单可 toggle/Escape 关闭。局部左右布局可用最小 scoped 样式，不引入 UI 系统；长名称/root 不得越过左栏覆盖预览。
- 新空间 dir 空白时省略字段，由服务端派生；不复制 non-u 正则。空空间新目录在页面/对话框显示既定文案，不调用 window.alert。mutation 完成只更新其所属 workspace/弹窗代际，迟到响应不污染后来选择。
- 移除 auth-router 中 incidental exposesApiClient shape pin，不改为 factory shape pin；保留状态/请求合同并以 current/stale 401、并发实际行为替代。endpoint-aware fetch assertions 替代被新增文件请求打破的全局索引，仍精确验证 auth 次数。

## Risks / Trade-offs

跨会话迟到 401、跨 workspace 迟到树/预览/创建 → deferred fetch 行为测试；同账号换会话必须覆盖。
Blob 泄漏/StrictMode effect 重放 → 替换、卸载、迟到分配及 StrictMode 生命周期测试；stub URL 静态方法时保留 URL 构造器供 router 使用。
文件 800 行/复杂度 15/重复 3% → feature-local 按职责拆分，禁止通用框架。auth-router 已在行数上限，新增 auth seam 用独立行为测试文件。
Sibling surfaces: provider 的 me/login/logout/info；routes.test、main.test、auth-router.test、settings-footer.test、ui-walk.spec；API fetchPreview 分配者和 PreviewPane 借用者。
Seams under test: 真实 AppRouter/AuthProvider + mock fetch（不 mock 被测页面），真实编译服务 HTTP + Chromium。

## Migration Plan

原子替换 /files，既有测试和 manifest 同 PR；无持久化迁移，回退使用 git revert。只归档本切片；父 S0b/S1a 保持 active，最终归档需 reconcile 已晋升条款，不能覆盖主规范其他切片。
Review focus: 会话代际、资源所有权、lazy/cache/URL 归属、旧消费者兼容及真实浏览器证据。
Open Questions: None.
