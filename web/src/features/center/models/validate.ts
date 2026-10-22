import {
  type CreateModelInput,
  MODEL_EFFORTS,
  type ModelView,
  type UpdateModelInput,
} from "@/lib/api";

/**
 * 模型表单的值、客户端校验与「表单 → 请求」的映射（model-registry「模型 tab」，s1d-model-registry 任务 10.2）。
 * 校验与服务端同一份规则（`server/src/model-catalog.ts` 的 `validateCatalogModel` 与 `agent-config.ts` 的地址
 * 正则），文案点名具体原因；服务端 400 的统一文案只作兜底。密钥是否为合法 header 值不在这里校验。
 */

export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export type ModelFormValues = {
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  /** 输入框原文；空串在新增时表示「不发」。 */
  maxTokens: string;
  efforts: readonly ModelEffort[];
  baseUrl: string;
  apiKey: string;
};

type ModelField = "id" | "name" | "maxTokens" | "baseUrl" | "apiKey";
export type FieldErrors = Partial<Record<ModelField, string>>;

const FIELD_MESSAGES = {
  idEmpty: "ID 不能为空",
  idControl: "ID 不能含控制字符",
  idBytes: "ID 不能超过 128 字节",
  name: "名称需为 1–64 个字符且不含控制字符",
  maxTokens: "最大 tokens 需为 1–128000 的整数",
  baseUrl: "上游地址需以 http:// 或 https:// 开头，且不含空白、# 或 @",
  keyRequired: "填了上游地址时必须填密钥",
  urlRequired: "填了密钥时必须填上游地址",
} as const;

const MAX_ID_BYTES = 128;
const MAX_NAME_CODE_POINTS = 64;
const MAX_TOKENS = 128000;
/** 与服务端 `UPSTREAM_BASE_URL` 同一正则：允许路径与查询串，不允许空白、fragment 与 userinfo。 */
const BASE_URL = /^https?:\/\/[^\s#@]+$/u;

/** U+0000–U+001F 与 U+007F。 */
function hasControl(text: string): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function idProblem(id: string): string | null {
  if (id === "") return FIELD_MESSAGES.idEmpty;
  if (hasControl(id)) return FIELD_MESSAGES.idControl;
  return new TextEncoder().encode(id).length > MAX_ID_BYTES ? FIELD_MESSAGES.idBytes : null;
}

function isName(name: string): boolean {
  return name !== "" && [...name].length <= MAX_NAME_CODE_POINTS && !hasControl(name);
}

/** 1..128000 的整数；其它（含空串与小数）为 null。 */
function maxTokensOf(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= MAX_TOKENS ? value : null;
}

/** 打开对话框时的初值：新增全空；编辑取视图（`efforts` 为 null 即一个都不勾），密钥恒为空。 */
export function initialValues(opened: ModelView | null): ModelFormValues {
  return {
    id: opened?.id ?? "",
    name: opened?.name ?? "",
    reasoning: opened?.reasoning ?? false,
    vision: opened?.vision ?? false,
    maxTokens: opened ? String(opened.maxTokens) : "",
    efforts: opened?.efforts ?? [],
    baseUrl: opened?.upstream?.baseUrl ?? "",
    apiKey: "",
  };
}

/** 地址与密钥两项：格式、带地址缺密钥（没有已存密钥时）、带密钥缺地址。 */
function upstreamErrors(values: ModelFormValues, opened: ModelView | null): FieldErrors {
  if (values.baseUrl === "") {
    return values.apiKey === "" ? {} : { baseUrl: FIELD_MESSAGES.urlRequired };
  }
  const errors: FieldErrors = {};
  if (!BASE_URL.test(values.baseUrl)) errors.baseUrl = FIELD_MESSAGES.baseUrl;
  const storedKey = opened !== null && opened.upstream !== null;
  if (values.apiKey === "" && !storedKey) errors.apiKey = FIELD_MESSAGES.keyRequired;
  return errors;
}

/**
 * 逐字段校验；`opened` 为 null 是新增（空的 `name` / `maxTokens` 不发也就不校验），否则是编辑（`id` 只读不校验）。
 * 「必须填密钥」只在没有已存密钥时成立：新增，或编辑一个 `upstream` 为 null 的模型。
 */
export function validateModelForm(values: ModelFormValues, opened: ModelView | null): FieldErrors {
  const errors: FieldErrors = upstreamErrors(values, opened);
  const editing = opened !== null;
  const id = editing ? null : idProblem(values.id);
  if (id) errors.id = id;
  if ((editing || values.name !== "") && !isName(values.name)) errors.name = FIELD_MESSAGES.name;
  if ((editing || values.maxTokens !== "") && maxTokensOf(values.maxTokens) === null) {
    errors.maxTokens = FIELD_MESSAGES.maxTokens;
  }
  return errors;
}

/** 只在推理且至少勾一个时声明；按 `minimal → max` 固定次序，与勾选先后无关。 */
function declaredEfforts(values: ModelFormValues): ModelEffort[] | undefined {
  if (!values.reasoning) return undefined;
  const efforts = MODEL_EFFORTS.filter((effort) => values.efforts.includes(effort));
  return efforts.length > 0 ? efforts : undefined;
}

/** 新增只发碰过的键：值与初值不同才发（空串、`false`、没勾强度都不发）；`upstream` 只在地址非空时发。 */
export function toCreateInput(values: ModelFormValues): CreateModelInput {
  const input: CreateModelInput = { id: values.id };
  if (values.name !== "") input.name = values.name;
  if (values.reasoning) input.reasoning = true;
  if (values.vision) input.vision = true;
  const maxTokens = maxTokensOf(values.maxTokens);
  if (maxTokens !== null) input.maxTokens = maxTokens;
  const efforts = declaredEfforts(values);
  if (efforts) input.efforts = efforts;
  if (values.baseUrl !== "") input.upstream = { baseUrl: values.baseUrl, apiKey: values.apiKey };
  return input;
}

/** 编辑整体替换：地址空 → `null`；有地址、密钥空 → `{baseUrl}`（保留已存密钥）；都有 → `{baseUrl, apiKey}`。 */
export function toUpdateInput(values: ModelFormValues): UpdateModelInput {
  const upstream =
    values.baseUrl === ""
      ? null
      : values.apiKey === ""
        ? { baseUrl: values.baseUrl }
        : { baseUrl: values.baseUrl, apiKey: values.apiKey };
  const input: UpdateModelInput = {
    name: values.name,
    reasoning: values.reasoning,
    vision: values.vision,
    maxTokens: maxTokensOf(values.maxTokens) ?? 0,
    upstream,
  };
  const efforts = declaredEfforts(values);
  if (efforts) input.efforts = efforts;
  return input;
}

/**
 * 保存后是否紧接着探活：保存后的视图有上游，且新增（带了上游），或编辑时地址与打开对话框时的视图不同、
 * 或填了密钥。只改名、清空上游都不探活。
 */
export function probesAfterSave(
  saved: ModelView,
  opened: ModelView | null,
  values: ModelFormValues,
): boolean {
  if (saved.upstream === null) return false;
  return (
    opened === null || saved.upstream.baseUrl !== opened.upstream?.baseUrl || values.apiKey !== ""
  );
}
