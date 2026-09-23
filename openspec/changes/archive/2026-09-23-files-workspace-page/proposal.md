## Why

#129 将已完成的 #118/#119 客户端与预览、#127/#128 真实端点接入 `/files`，替换占位页，完成账号工作空间浏览与新建目录的用户路径。

## What Changes

- 工作空间 URL、切换器、两种新建对话框、逐层目录树与已有 PreviewPane 接线。
- Provider-owned、会话代际绑定的 API client factory，支持独立并发文件请求及 current 401 清会话，不改变既有 auth operation 单槽规则。
- 原子更新路由和既有 web/jsdom/ui-walk 断言；本切片不增加正式 Playwright 流程（#133），但执行独立真实浏览器验收。

## Capabilities

### New Capabilities
无新的 capability 名称。

### Modified Capabilities
- `files-web`：新增工作空间页和树/预览集成要求，复用已晋升纯组件合同。
- `spa-shell`：只替换 `/files` 占位页；明确当前会话请求 401 与取消/旧会话响应的边界。

## Impact

web files feature、AuthProvider、router；routes/main/auth-router/settings-footer 测试及既有 ui-walk 断言。无服务端、依赖、CI、配置或数据库变更。

## Risk triage

Issue type: feature
Fixture level: expanded
Upstream suggested level: compact (override: 共享 AuthProvider 接缝、401 会话代际、并发与 Blob 资源所有权触发 expanded)
Blast radius: 文件浏览、路由恢复、登录生命周期及其既有消费者。
Selected risk packs: Public API / CLI / script entry; Auth / permissions / secrets; Concurrency / shared state / ordering; Resource limits / large input / discovery; Legacy compatibility / examples; Error handling / rollback / partial outputs; Documentation / migration notes.
Evidence floor: 语义 RED→GREEN；全 web coverage、类型/构建、范围 lint/反漂移；真实 HTTP 驱动浏览器截图和零非预期错误；既有 make ui-walk。
