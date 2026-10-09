// 会话 DTO 元数据（#517、#921、#1004）共享夹具：既有测试只经这些常量补键，不在各文件内重复字面量。
import type { ComposerConfig } from "../src/sessions/store-composer.js";

/**
 * 缺省配置下 store 拿到的输入框配置（未设 `APPROVAL_MAX_MODE` / `MODEL_CATALOG` / `MODEL_ID` /
 * `MODEL_REASONING`）：最高档 `yolo`，白名单只有缺省模型一项、支持推理、不带 efforts。
 * 手写字面量，不经 `resolveModelCatalog`：夹具不拿被测代码当判据。
 */
export const TEST_COMPOSER: ComposerConfig = {
  approvalMaxMode: "yolo",
  modelCatalog: {
    models: [
      { id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash", reasoning: true, vision: false },
    ],
    defaultModelId: "deepseek-v4.1-flash",
  },
};

/**
 * 未绑定空间、未写入元数据的会话视图（直接写库的行；#930 起 REST 不再创建未绑定会话）：
 * 三个元数据键为 null，未归档、无待决审批、不是临时空间；三列输入框设置为 NULL，读成缺省配置
 * （`TEST_COMPOSER`）下的有效值。
 */
export const NULL_SESSION_META = {
  scene: null,
  workspaceId: null,
  pinnedAt: null,
  archivedAt: null,
  pendingApproval: false,
  temporaryWorkspace: false,
  approvalMode: "write",
  modelId: "deepseek-v4.1-flash",
  reasoningEffort: "high",
} as const;

/** 公开会话视图的十四键，按 `toPublicSession` 的键序。 */
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
  "approvalMode",
  "modelId",
  "reasoningEffort",
] as const;
