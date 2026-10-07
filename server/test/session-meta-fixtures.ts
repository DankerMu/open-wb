// 会话 DTO 元数据（#517、#921）共享夹具：既有测试只经这些常量补键，不在各文件内重复字面量。

/**
 * 未绑定空间、未写入元数据的会话视图（直接写库的行；#930 起 REST 不再创建未绑定会话）：
 * 三个元数据键为 null，未归档、无待决审批、不是临时空间。
 */
export const NULL_SESSION_META = {
  scene: null,
  workspaceId: null,
  pinnedAt: null,
  archivedAt: null,
  pendingApproval: false,
  temporaryWorkspace: false,
} as const;

/** 公开会话视图的十一键，按 `toPublicSession` 的键序。 */
export const SESSION_VIEW_KEYS = [
  "id",
  "title",
  "status",
  "createdAt",
  "updatedAt",
  "scene",
  "workspaceId",
  "pinnedAt",
  "archivedAt",
  "pendingApproval",
  "temporaryWorkspace",
] as const;
