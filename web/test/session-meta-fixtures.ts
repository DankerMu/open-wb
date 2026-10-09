// 会话 DTO 元数据（#517、#921）与输入框选项（#1022）共享夹具：既有测试只经这些常量补键，不在各文件内重复字面量。
import type { ComposerOptions } from "../src/lib/composer-contract.js";

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

/**
 * `GET /api/composer/options` 的「缺省配置」响应体（session-composer-settings「输入框选项端点」）：
 * 三档、单模型、缺省上传上限。API 客户端测试、整页测试的假 API 与输入框控件测试共用这一份。
 */
export const DEFAULT_COMPOSER_OPTIONS: ComposerOptions = {
  approvalModes: ["always-ask", "write", "yolo"],
  models: [
    {
      id: "deepseek-v4.1-flash",
      name: "deepseek-v4.1-flash",
      reasoning: true,
      vision: false,
      efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    },
  ],
  defaults: { approvalMode: "write", modelId: "deepseek-v4.1-flash", reasoningEffort: "high" },
  upload: { maxBytes: 524_288_000, maxFiles: 10 },
};
