// 会话 DTO 元数据（#517）共享夹具：既有测试只经这些常量补键，不在各文件内重复字面量。

/** 未写入元数据的会话 DTO 三键恒为 null。 */
export const NULL_SESSION_META = { scene: null, workspaceId: null, pinnedAt: null } as const;
