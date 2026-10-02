# Tasks: turn-control-fork-eight-keys（#543）

Fixture level: none（纯规格同步，无运行时行为）

## 9. 规格同步（父 tasks 9.2）

- [x] 9.2a turn-control MODIFIED「从此处分叉 REST」：按主规格现文整段重述；新会话行写明 `workspace_id` / `scene` 复制自源会话、`pinned_at` 为 NULL；201 响应的 `session` 为八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}`；追加 session-metadata「fork 继承会话元数据」的两个 Scenario（逐字）。验证：`openspec validate turn-control-fork-eight-keys --strict --no-interactive`；与主规格的 diff 只有这三处
- [x] 9.2b 归档后按主规格现文生成父 change 的 `specs/turn-control/spec.md`（MODIFIED「重新生成 REST」「从此处分叉 REST」）。验证：`openspec validate s1c-session-metadata-presentation --strict --no-interactive`；两个块与主规格逐字一致
