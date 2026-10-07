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
  /** 该模型声明的强度档；`MODEL_CATALOG` 里的推理模型必带，其余情形没有这个键。 */
  efforts?: readonly Effort[];
}

export interface ModelCatalog {
  models: readonly CatalogModel[];
  defaultModelId: string;
}

const CATALOG_KEYS: readonly string[] = ["id", "name", "reasoning", "vision", "efforts"];
const MAX_CATALOG_MODELS = 32;
const MAX_ID_BYTES = 128;
const MAX_NAME_CODE_POINTS = 64;

export function resolveModelCatalog(env: Record<string, string | undefined>): ModelCatalog {
  const rawCatalog = env.MODEL_CATALOG;
  if (rawCatalog === undefined) {
    // 本 change 之前的单模型配置：MODEL_ID 原样保留（不校验、不 trim），这一项不带 efforts。
    const id = env.MODEL_ID === undefined ? DEFAULT_MODEL_ID : env.MODEL_ID;
    const reasoning = resolveOnOff(env.MODEL_REASONING, true, "MODEL_REASONING");
    return { models: [{ id, name: id, reasoning, vision: false }], defaultModelId: id };
  }
  const models = parseCatalog(rawCatalog);
  if (env.MODEL_REASONING !== undefined) {
    throw new Error("MODEL_REASONING must not be set when a model catalog is configured");
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
    const model = parseCatalogEntry(entry);
    if (seen.has(model.id)) {
      throw catalogError("entry ids must be unique");
    }
    seen.add(model.id);
    return model;
  });
}

function parseCatalogEntry(entry: unknown): CatalogModel {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw catalogError("entries must be objects");
  }
  if (Object.keys(entry).some((key) => !CATALOG_KEYS.includes(key))) {
    throw catalogError("entries accept only the keys id, name, reasoning, vision and efforts");
  }
  const {
    id,
    name = id,
    reasoning = false,
    vision = false,
    efforts,
  } = entry as Record<string, unknown>;
  if (typeof id !== "string" || !isLabel(id) || Buffer.byteLength(id, "utf8") > MAX_ID_BYTES) {
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
  if (reasoning !== (efforts !== undefined)) {
    throw catalogError("entries must declare efforts exactly when reasoning is true");
  }
  if (efforts === undefined) {
    return { id, name, reasoning, vision };
  }
  return { id, name, reasoning, vision, efforts: parseEfforts(efforts) };
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
