// 会话 DTO 元数据（#517、#921）共享夹具：既有测试只经这些常量补键，不在各文件内重复字面量。

/** 未写入元数据的会话 DTO：三个元数据键为 null，未归档、无待决审批、不是临时空间。 */
export const NULL_SESSION_META = {
  scene: null,
  workspaceId: null,
  pinnedAt: null,
  archivedAt: null,
  pendingApproval: false,
  temporaryWorkspace: false,
  approvalMode: "write",
  modelId: "m1",
  reasoningEffort: null,
} as const;
