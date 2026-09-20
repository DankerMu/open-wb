# files-web Specification

## Purpose
定义文件工作空间与审计的浏览器 API 客户端和安全预览组件契约，包括同源请求、错误信封、预览元数据、图片资源所有权及用户授权的病态格式深度规范化；页面接线与真实端点联调由后续切片补充。
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

### Requirement: 文件预览纯组件
`mdRender(src)`、`CsvTable`、`CodeView`、`PreviewPane` SHALL 提供无网络依赖的安全预览。Markdown SHALL 支持 demo 的标题、列表、代码块、表格、行内代码、粗体和不可跳转链接，源 HTML 作为文本转义；代码内容 SHALL 保持字面值。CSV SHALL 以首行为表头并显示 `共 N 行 · 大文件仅预览前若干行`；其余文本 SHALL 显示带行号代码表，JSON 尝试格式化、失败保留原文。预览 SHALL 显示路径、大小、mtime；Markdown 默认渲染且可切换 `查看源码`/`渲染视图`，切换文件重置模式。图片 SHALL 用提供的 URL 渲染 img；组件不负责 URL 分配/释放。不支持类型 SHALL 显示 `该类型不支持预览`，提供的错误 message SHALL 内联显示；截断状态 SHALL 显示提示和原始总大小。移植文件 SHALL 保留来源说明，demo 原始文件头不得改动。
用户授权的病态深度规范化 SHALL 将规范节点每条祖先链的 `strong` 限制为最多 64 层；可省略超出的冗余粗体包装，但 SHALL 保留全部文字顺序、所有不可跳转链接及其作用范围和可见格式。普通/浅层 demo 行为不变，代码保持字面值；HTML 与 React SHALL 使用同一规范化结构，不使用文本截断、纯文本降级或危险 HTML 注入。
#### Scenario: 安全 Markdown
- WHEN 输入标题/列表/代码/链接及 script、javascript 目标、onerror 属性注入载荷
- THEN 语义 DOM 与支持的 demo 子集一致；源载荷不生成执行元素或事件属性；HTML 与 React 预览链接均为 href="#" 且鼠标/键盘操作不跳转，代码中标记保持字面值
#### Scenario: 表格与代码
- WHEN CSV 为一行表头及两行数据，或代码含两行和末尾空行
- THEN CSV 表头可见且注记共2行；代码表有三行并显示1..3行号，内容安全且保留空白
#### Scenario: 预览状态
- WHEN 切换 Markdown 渲染/源码后换文件，或展示图片、不支持类型、错误、截断文本
- THEN 新 Markdown 默认渲染；各状态显示对应内容、错误消息与原始大小，图片使用传入URL且不发起API调用
#### Scenario: 深层结构生命周期
- WHEN 同一实例从浅层预览切换到接近 1 MiB 的深层重建格式，再切换到普通文档、操作源码按钮并卸载
- THEN `strong` 祖先最多 64 层，全部文字及链接保留，开发/生产及 StrictMode 生命周期完成且无新增控制台/页面错误

