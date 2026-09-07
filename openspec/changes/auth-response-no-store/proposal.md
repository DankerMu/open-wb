## Why

认证会话端点返回当前身份或会话有效性，但登录失败与内容解析错误目前会在设置响应头之前退出，允许浏览器或中间缓存保存身份相关结果。服务端必须在所有客户端可见的认证终态上统一声明不可存储，同时不改变其他 API 或静态资源的缓存策略。

## What Changes

- 为 exact `POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout` 的成功及端点自身产生的业务、认证、请求解析和内部错误响应规定精确 `Cache-Control: no-store`。
- 将登录路由的该策略前移到内容解析和认证逻辑之前，使失败路径与成功路径一致。
- 以 `app.inject()` 覆盖认证终态矩阵，并证明 health、info、静态资源及非 auth API 不继承该策略。
- 保持既有 Principal、错误信封、cookie、会话写入/删除、TTL 与惰性清理语义不变。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `dev-stub-auth`: 补全三个认证会话端点的服务端不可缓存响应契约及其作用域。

## Impact

影响 `server/src/auth/index.ts`、认证 HTTP seam 测试及 `dev-stub-auth` 规范；不增加依赖，不改变响应 body、状态码、cookie 或数据库 schema。
