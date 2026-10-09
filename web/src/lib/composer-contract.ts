import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";
import { APPROVAL_MODES, type ChatSession, REASONING_EFFORTS } from "./session-contract.js";

type ApprovalMode = ChatSession["approvalMode"];
type ReasoningEffort = NonNullable<ChatSession["reasoningEffort"]>;

/** 白名单里的一个模型：`efforts` 是它的可选强度（不支持推理时为空），`defaultEffort` 是其缺省强度。 */
type ComposerModel = {
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  efforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort | null;
};

/** `GET /api/composer/options` 的响应：可选档位、模型白名单、本账号的缺省值与上传上限。 */
export type ComposerOptions = {
  approvalModes: ApprovalMode[];
  models: ComposerModel[];
  defaults: {
    approvalMode: ApprovalMode;
    modelId: string;
    reasoningEffort: ReasoningEffort | null;
  };
  upload: { maxBytes: number; maxFiles: number };
};

function parseApprovalMode(value: unknown): ApprovalMode | null {
  return APPROVAL_MODES.has(value) ? (value as ApprovalMode) : null;
}

function parseEffort(value: unknown): ReasoningEffort | null {
  return REASONING_EFFORTS.has(value) ? (value as ReasoningEffort) : null;
}

function isEffortOrNull(value: unknown): value is ReasoningEffort | null {
  return value === null || REASONING_EFFORTS.has(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function parseModel(value: unknown): ComposerModel | null {
  if (!hasExactlyKeys(value, ["id", "name", "reasoning", "vision", "efforts", "defaultEffort"])) {
    return null;
  }

  const { id, name, reasoning, vision, defaultEffort } = value;
  const efforts = parseJsonArray(value.efforts, parseEffort);
  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(name) ||
    typeof reasoning !== "boolean" ||
    typeof vision !== "boolean" ||
    !efforts ||
    !isEffortOrNull(defaultEffort)
  ) {
    return null;
  }

  return { id, name, reasoning, vision, efforts, defaultEffort };
}

function parseDefaults(value: unknown): ComposerOptions["defaults"] | null {
  if (!hasExactlyKeys(value, ["approvalMode", "modelId", "reasoningEffort"])) {
    return null;
  }

  const { modelId, reasoningEffort } = value;
  const approvalMode = parseApprovalMode(value.approvalMode);
  if (!approvalMode || !isNonEmptyString(modelId) || !isEffortOrNull(reasoningEffort)) {
    return null;
  }

  return { approvalMode, modelId, reasoningEffort };
}

function parseUpload(value: unknown): ComposerOptions["upload"] | null {
  if (!hasExactlyKeys(value, ["maxBytes", "maxFiles"])) {
    return null;
  }

  const { maxBytes, maxFiles } = value;
  return isPositiveSafeInteger(maxBytes) && isPositiveSafeInteger(maxFiles)
    ? { maxBytes, maxFiles }
    : null;
}

/**
 * 恰好键集的严格解析，任何不符整体返回 null。只校验各字段自身的形状与取值域，不做跨字段一致性
 * 校验：缺省强度可以合法地落在缺省模型的 `efforts` 之外（服务端原样保存所选强度，由 omp 夹取）。
 */
export function parseComposerOptions(value: unknown): ComposerOptions | null {
  if (!hasExactlyKeys(value, ["approvalModes", "models", "defaults", "upload"])) {
    return null;
  }

  const approvalModes = parseJsonArray(value.approvalModes, parseApprovalMode);
  const models = parseJsonArray(value.models, parseModel);
  const defaults = parseDefaults(value.defaults);
  const upload = parseUpload(value.upload);
  if (
    !approvalModes ||
    approvalModes.length === 0 ||
    new Set(approvalModes).size !== approvalModes.length ||
    !models ||
    models.length === 0 ||
    !defaults ||
    !upload
  ) {
    return null;
  }

  return { approvalModes, models, defaults, upload };
}
