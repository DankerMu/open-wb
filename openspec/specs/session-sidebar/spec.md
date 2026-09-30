# session-sidebar Specification

## Purpose
定义 web 会话页在侧栏列表区与欢迎态的会话元数据呈现：「置顶任务 / 任务 / 空间」三分区互斥列表、纯前端状态×时间筛选、条目「更多」菜单（重命名 / 置顶 / 删除）与顶栏重命名入口、欢迎页场景胶囊与场景化快捷任务、欢迎态 composer footer 的工作空间选择，以及会话 DTO 八键严格解析。视觉与文案对照 `resource/workbuddy-live-demo.html`（下称 demo）标注的行号；与 demo 的有意偏差在各 Requirement 内留痕。

## Requirements

### Requirement: 会话 DTO 八键严格解析
web 的会话解析 SHALL 要求会话对象恰含八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}`（`hasExactlyKeys`），并逐键校验：既有五键规则不变（`status` 含 A 的 `stopped`）；`scene` ∈ `office|code|design|null`；`workspaceId` 为 32 位小写十六进制字符串或 null；`pinnedAt` 为非负安全整数或 null。缺键、多余键或任一值不合法 SHALL 使该响应按既有规则视为无效成功响应（与其它 malformed success 相同的失败呈现，不部分采用）。该规则 SHALL 统一作用于 `GET /api/sessions` 列表项、`POST /api/sessions` 与 `PATCH /api/sessions/:id` 响应、消息快照的 `session` 与 fork 响应的 `session`。API 客户端 SHALL 新增 `patchSession(id, patch)`（`PATCH`，JSON body，成功 200 返回解析后的会话）与 `deleteSession(id)`（`DELETE`，无 body，成功恰为 204），`createSession(input?, options?)` SHALL 接受可选 input `{workspaceId?, scene?}` 并在提供时以 `application/json` 发送，`options` 为既有请求选项（含可选 `signal`）；三者沿用既有 same-origin、AbortSignal、错误信封与 401 通知机制，路径 id 编码。

#### Scenario: 八键接受与多余键拒绝
- **WHEN** `GET /api/sessions` 分别返回合法八键会话、缺 `pinnedAt` 的七键会话、多一个 `parentSessionId` 的九键会话、`scene:"chat"` 的会话
- **THEN** 第一种被接受并渲染；其余三种都使列表读取呈现既有的无效响应失败，不渲染任何部分列表

#### Scenario: 客户端新方法
- **WHEN** 调用 `patchSession(id,{pinned:true})`、`deleteSession(id)`、`createSession({scene:"code"})` 与无参 `createSession()`
- **THEN** 请求分别为 `PATCH /api/sessions/<id>` body `{"pinned":true}`、`DELETE /api/sessions/<id>` 无 body、`POST /api/sessions` body `{"scene":"code"}` 且 `Content-Type: application/json`、`POST /api/sessions` 无 body；`deleteSession` 对 200 视为无效响应
