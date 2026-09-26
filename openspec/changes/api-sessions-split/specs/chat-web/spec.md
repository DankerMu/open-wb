# Spec delta: chat-web（#471 api.ts 纯搬迁拆分）

## ADDED Requirements

### Requirement: API 客户端源码模块划分
`web/src/lib/` 下的 API 客户端实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。`createApiClient`、`ApiClient`、`ApiClientOptions`、`ApiError`、`REQUEST_FAILED_MESSAGE` 与既有公开 DTO 类型 SHALL 保持从 `api.ts` 导出，`api.ts` 是浏览器 API 客户端的唯一公共入口。`api-sessions.ts` SHALL 承载会话族方法（会话列表、新建会话、消息快照、prompt 及回合控制方法）的实现，其请求传输（same-origin 请求、错误信封、request_failed 构造与 401 通知）SHALL 由 `api.ts` 注入而非另行实现；会话 DTO 的严格解析 SHALL 保持在 `session-contract.ts`。`api.ts` 与 `api-sessions.ts` 之间的值导入 SHALL 只沿 `api.ts → api-sessions.ts` 方向，`api-sessions.ts` 对 `api.ts` 只允许类型导入（无运行时环）；`api-sessions.ts` 的导出 SHALL 只供 `api.ts` 使用，不新增未被引用的导出。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 web 测试
- **THEN** size-guard 退出 0，knip 无未引用导出，`api-sessions.ts` 对 `./api.js` 只有 `import type`，既有调用方仍从 `lib/api.js` 取得 `createApiClient`/`ApiClient`/`ApiError`，web 测试全绿
