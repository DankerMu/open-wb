// 会话 DTO 元数据（#517）共享夹具：既有测试只经这些常量补键，不在各文件内重复字面量。

/** 新建行与未写入元数据的会话视图三键恒为 null（4.1 起才可能非 null）。 */
export const NULL_SESSION_META = { scene: null, workspaceId: null, pinnedAt: null } as const;

/** 公开会话视图的八键，按 `toPublicSession` 的键序。 */
export const SESSION_VIEW_KEYS = [
  "id",
  "title",
  "status",
  "createdAt",
  "updatedAt",
  "scene",
  "workspaceId",
  "pinnedAt",
] as const;
