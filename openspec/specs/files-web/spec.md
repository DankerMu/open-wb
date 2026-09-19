# files-web Specification

## Purpose
定义文件工作空间与审计的浏览器 API 客户端契约，包括同源请求、错误信封、预览元数据和图片资源所有权；页面、预览组件及真实端点联调由后续切片补充。
## Requirements
### Requirement: API 客户端扩展
`lib/api` SHALL 新增 `listWorkspaces()`、`createWorkspace({name, dir?})`、`listTree(workspaceId, path)`、`createDir(workspaceId, path)`、`fetchPreview(workspaceId, path) → {kind:'text'|'image', text?|url?, size, truncated}`（`size` 取自 `X-Workbuddy-Size`，文本与图片响应均带）、`listAudit({limit?, before?})`，并把 403 `sandbox_denied`、409 `conflict`、413 `preview_too_large`、415 `preview_unsupported` 解析为带 `code` 的错误对象；沿用既有 401 → 未登录态。六方法 SHALL 保持同源凭证和既有可选取消信号契约；路径作为数据进行 URL 编码。图片 URL 的释放 SHALL 由调用方在替换或卸载时负责。
#### Scenario: 方法与错误码
- WHEN 以 mock fetch 分别返回合法 201/200 与四种错误信封
- THEN 六方法路径、方法、body 与返回形状符合 workspaces/audit-core 契约；错误保留 status/code/message，401 回调保持既有语义
#### Scenario: 预览元数据与资源
- WHEN 文本/图片响应携带原始大小头且正文长度与之不同，截断头为 1，或空文本 size 0
- THEN size 保留头值而非正文大小，truncated 为 true（空文件无截断头则 false），文本原样返回，图片以保留正文与 MIME 的 Blob URL 返回供调用方释放
#### Scenario: 失败不变成预览
- WHEN 响应是错误信封、非 JSON 401、成功响应缺失/非法大小头或不支持的 Content-Type
- THEN 使用既有 ApiError/稳定 request_failed 回退；401 通知一次；不得把错误正文返回为预览或分配图片 URL

