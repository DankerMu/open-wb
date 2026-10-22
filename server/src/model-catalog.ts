/**
 * 模型白名单与推理强度集合（model-selection「模型白名单配置」「推理强度集合」）。
 * 纯函数：只读传入的 env，不碰文件系统、数据库与进程环境；不导入 agent-config（它反过来导入本文件）。
 * 所有错误只点名出错的键，不回显取值——因此也不附带 JSON 解析器的原文（它会带上输入）。
 */

export const DEFAULT_MODEL_ID = "deepseek-v4.1-flash";

/** 六个强度档，按强度升序；`off` 不在其中，`auto` 不是合法取值。 */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** 推理强度的取值域：七个名字。 */
export type Effort = "off" | EffortLevel;

export interface CatalogModel {
  /** 发给上游的模型名，也是托管 models.yml 条目的 id。 */
  id: string;
  /** 界面显示名。 */
  name: string;
  reasoning: boolean;
  vision: boolean;
  /** 单次回复的输出上限：写进托管 models.yml 的 `maxTokens`，omp 以它作上游请求的上限。 */
  maxTokens: number;
  /** 该模型声明的强度档；`MODEL_CATALOG` 里的推理模型必带，其余情形没有这个键。 */
  efforts?: readonly Effort[];
}

export interface ModelCatalog {
  models: readonly CatalogModel[];
  defaultModelId: string;
}

const CATALOG_KEYS: readonly string[] = [
  "id",
  "name",
  "reasoning",
  "vision",
  "maxTokens",
  "efforts",
];
const MAX_CATALOG_MODELS = 32;
const MAX_ID_BYTES = 128;
const MAX_NAME_CODE_POINTS = 64;
/** 缺省输出上限（owner 2026-10-18；此前固定 8192）与上限（托管 models.yml 固定的 contextWindow）。 */
const DEFAULT_MAX_TOKENS = 32768;
const MAX_MAX_TOKENS = 128000;

export function resolveModelCatalog(env: Record<string, string | undefined>): ModelCatalog {
  // MODEL_ID 给出时与白名单条目的 id 同一条规则，有没有 MODEL_CATALOG 都先过这一关；取值不 trim。
  if (env.MODEL_ID !== undefined && !isModelId(env.MODEL_ID)) {
    throw new Error("MODEL_ID must be a string of 1 to 128 UTF-8 bytes without control characters");
  }
  const rawCatalog = env.MODEL_CATALOG;
  if (rawCatalog === undefined) {
    // 单模型配置：MODEL_ID 逐字节成为这一项的 id 与 name（首尾空格属于模型名），这一项不带 efforts。
    const id = env.MODEL_ID === undefined ? DEFAULT_MODEL_ID : env.MODEL_ID;
    const reasoning = resolveOnOff(env.MODEL_REASONING, true, "MODEL_REASONING");
    // 单模型的看图开关（#912，owner 2026-10-18：缺省 on，deepseek-v4.1-flash 能看图）。
    const vision = resolveOnOff(env.MODEL_VISION, true, "MODEL_VISION");
    return {
      models: [{ id, name: id, reasoning, vision, maxTokens: DEFAULT_MAX_TOKENS }],
      defaultModelId: id,
    };
  }
  const models = parseCatalog(rawCatalog);
  if (env.MODEL_REASONING !== undefined) {
    throw new Error("MODEL_REASONING must not be set when a model catalog is configured");
  }
  if (env.MODEL_VISION !== undefined) {
    throw new Error("MODEL_VISION must not be set when a model catalog is configured");
  }
  // MODEL_ID 未设置时第一项是缺省模型；设置了就必须是其中一项的 id。
  const chosen =
    env.MODEL_ID === undefined ? models[0] : models.find((model) => model.id === env.MODEL_ID);
  if (chosen === undefined) {
    throw new Error("MODEL_ID must name one of the configured catalog models");
  }
  return { models, defaultModelId: chosen.id };
}

/** 界面列出的强度：不支持推理为空；否则 `off` 加声明的 efforts（未声明即全部六档）。 */
export function selectableEfforts(model: CatalogModel): readonly Effort[] {
  return model.reasoning ? ["off", ...(model.efforts ?? EFFORT_LEVELS)] : [];
}

/** 缺省强度：`high` 可选就取它；否则取声明里不高于 `high` 的最高一档；再没有取声明的第一档。 */
export function defaultEffort(model: CatalogModel): Effort | null {
  if (!model.reasoning) {
    return null;
  }
  const declared = model.efforts ?? EFFORT_LEVELS;
  if (declared.includes("high")) {
    return "high";
  }
  const high = EFFORT_LEVELS.indexOf("high");
  const below = declared.filter((effort) => levelIndex(effort) < high);
  // 声明为空只可能来自手工构造的值（白名单拒绝空 efforts）：此时唯一可选的是 off。
  return below.at(-1) ?? declared[0] ?? "off";
}

/** 审批档位，按权限升序；次序只此一份（夹取、最高档校验与界面都以它为准）。 */
export const APPROVAL_MODES = ["always-ask", "write", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** 档位与最高档中较低的一个：读取时的夹取，以及新建与 fork 写入会话行时的夹取，都用它。 */
export function capApprovalMode(mode: ApprovalMode, max: ApprovalMode): ApprovalMode {
  return APPROVAL_MODES.indexOf(mode) > APPROVAL_MODES.indexOf(max) ? max : mode;
}

/**
 * 会话输入框设置的有效值（session-composer-settings「有效值解析」）：只读入参，不回写原始值。
 * 档位取原始值（null 即 write）与最高档中较低的一个；模型不在白名单取缺省模型；
 * 强度在模型不支持推理时为 null，否则原始值非 null 原样保留（omp 自行夹取），为 null 取缺省强度。
 */
export function effectiveComposer(
  raw: {
    approvalMode: ApprovalMode | null;
    modelId: string | null;
    reasoningEffort: Effort | null;
  },
  config: { approvalMaxMode: ApprovalMode; modelCatalog: ModelCatalog },
): { approvalMode: ApprovalMode; modelId: string; reasoningEffort: Effort | null } {
  const { models, defaultModelId } = config.modelCatalog;
  const capped = capApprovalMode(raw.approvalMode ?? "write", config.approvalMaxMode);
  const model =
    models.find((entry) => entry.id === raw.modelId) ??
    models.find((entry) => entry.id === defaultModelId);
  if (model === undefined) {
    // 只可能来自手工构造的白名单（resolveModelCatalog 保证缺省模型在其中）。
    return { approvalMode: capped, modelId: defaultModelId, reasoningEffort: null };
  }
  return {
    approvalMode: capped,
    modelId: model.id,
    reasoningEffort: model.reasoning ? (raw.reasoningEffort ?? defaultEffort(model)) : null,
  };
}

function levelIndex(effort: unknown): number {
  return (EFFORT_LEVELS as readonly unknown[]).indexOf(effort);
}

function catalogError(rule: string): Error {
  return new Error(`MODEL_CATALOG ${rule}`);
}

function parseCatalog(raw: string): readonly CatalogModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw catalogError("must be a JSON array of 1 to 32 model objects");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_CATALOG_MODELS) {
    throw catalogError("must be a JSON array of 1 to 32 model objects");
  }
  const seen = new Set<string>();
  return parsed.map((entry: unknown) => {
    const model = validateCatalogModel(entry, { requireEfforts: true });
    if (seen.has(model.id)) {
      throw catalogError("entry ids must be unique");
    }
    seen.add(model.id);
    return model;
  });
}

/**
 * 白名单单项的字段规则（只此一份）：环境 `MODEL_CATALOG` 传 `requireEfforts: true`，注册表写入传 `false`
 *（推理模型可不带 `efforts`）。非推理模型带 `efforts` 两种模式下都非法；错误只点名规则、不回显取值。
 */
export function validateCatalogModel(
  entry: unknown,
  options: { requireEfforts: boolean },
): CatalogModel {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw catalogError("entries must be objects");
  }
  if (Object.keys(entry).some((key) => !CATALOG_KEYS.includes(key))) {
    throw catalogError(
      "entries accept only the keys id, name, reasoning, vision, maxTokens and efforts",
    );
  }
  const {
    id,
    name = id,
    reasoning = false,
    vision = false,
    maxTokens = DEFAULT_MAX_TOKENS,
    efforts,
  } = entry as Record<string, unknown>;
  if (typeof id !== "string" || !isModelId(id)) {
    throw catalogError(
      "entry id must be a string of 1 to 128 UTF-8 bytes without control characters",
    );
  }
  if (typeof name !== "string" || !isLabel(name) || [...name].length > MAX_NAME_CODE_POINTS) {
    throw catalogError(
      "entry name must be a string of 1 to 64 code points without control characters",
    );
  }
  if (typeof reasoning !== "boolean" || typeof vision !== "boolean") {
    throw catalogError("entry reasoning and vision must be booleans");
  }
  if (
    typeof maxTokens !== "number" ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > MAX_MAX_TOKENS
  ) {
    throw catalogError("entry maxTokens must be an integer from 1 to 128000");
  }
  const declared = declaredEfforts(reasoning, efforts, options.requireEfforts);
  if (declared === undefined) {
    return { id, name, reasoning, vision, maxTokens };
  }
  return { id, name, reasoning, vision, maxTokens, efforts: declared };
}

/** 非推理模型不得带 `efforts`；推理模型在 `requireEfforts` 时必带。带了就按强度规则解析。 */
function declaredEfforts(
  reasoning: boolean,
  efforts: unknown,
  requireEfforts: boolean,
): readonly Effort[] | undefined {
  const declared = efforts !== undefined;
  if (reasoning ? requireEfforts && !declared : declared) {
    throw catalogError("entries must declare efforts exactly when reasoning is true");
  }
  return declared ? parseEfforts(efforts) : undefined;
}

/** 六个强度档的非空子集，严格按强度升序（因此也不重复）。 */
function parseEfforts(raw: unknown): readonly Effort[] {
  const ascending =
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((effort: unknown, index) => {
      const level = levelIndex(effort);
      return level >= 0 && (index === 0 || level > levelIndex(raw[index - 1]));
    });
  if (!ascending) {
    throw catalogError(
      "entry efforts must be a non-empty ascending subset of minimal, low, medium, high, xhigh, max",
    );
  }
  return raw as readonly Effort[];
}

/** 模型 id（白名单条目的 `id` 与 `MODEL_ID` 共用）：`isLabel` 且不超过 128 个 UTF-8 字节。 */
function isModelId(value: string): boolean {
  return isLabel(value) && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES;
}

/** 非空且不含 U+0000–U+001F 与 U+007F。 */
function isLabel(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** 只接受精确 on/off（不 trim、不改大小写）；错误只命名键，不回显输入值。 */
function resolveOnOff(raw: string | undefined, fallback: boolean, key: string): boolean {
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "on") {
    return true;
  }
  if (raw === "off") {
    return false;
  }
  throw new Error(`${key} must be exactly on or off`);
}
