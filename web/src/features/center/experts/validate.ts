import type { ExpertCategory, ExpertInput, ExpertView } from "@/lib/api";

/**
 * 专家表单的值、客户端校验与「表单 → 请求」的映射（experts「专家校验与可见性」的客户端一侧，s1d-experts-skills
 * 任务 7.3）。规则与服务端同一份（`server/src/experts/store.ts` 的 `parseFields`）：长度一律按码点；`name` 与
 * `prompt` 计 trim 后的码点并发送 trim 后文本，`description` 不 trim、原样发送。服务端 400 的统一文案只作兜底
 *（例如第 51 个专家的上限只由服务端判）。技能名来自技能清单或专家已有的名称，名称规则不在这里重复。
 */

export type ExpertFormValues = {
  name: string;
  description: string;
  category: ExpertCategory;
  /** 标签输入框原文：以半角或全角逗号分隔。 */
  tags: string;
  prompt: string;
  /** 所选技能名，按勾选次序（编辑时已有的名称在前）。 */
  skills: readonly string[];
};

type ExpertField = "name" | "description" | "tags" | "prompt" | "skills";
export type FieldErrors = Partial<Record<ExpertField, string>>;

const FIELD_MESSAGES = {
  name: "名称需为 1–32 个字符",
  description: "描述不能超过 200 个字符",
  tagCount: "标签最多 5 个",
  tagLength: "每个标签不超过 12 个字符",
  prompt: "提示词需为 1–8000 个字符",
  skills: "最多选择 32 个技能",
} as const;

const MAX_NAME = 32;
const MAX_DESCRIPTION = 200;
const MAX_TAGS = 5;
const MAX_TAG = 12;
const MAX_PROMPT = 8000;
const MAX_SKILLS = 32;
const TAG_SEPARATOR = /[,，]/u;
/** 编辑时把已有标签写回输入框所用的分隔符。 */
const TAG_JOINER = "，";

const points = (text: string) => [...text].length;

/** 各项 trim、丢弃空项；不去重（项数上限按去重之前计）。 */
function splitTags(text: string): string[] {
  return text
    .split(TAG_SEPARATOR)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

function tagsProblem(tags: readonly string[]): string | null {
  if (tags.length > MAX_TAGS) return FIELD_MESSAGES.tagCount;
  return tags.some((tag) => points(tag) > MAX_TAG) ? FIELD_MESSAGES.tagLength : null;
}

function inRange(text: string, max: number): boolean {
  const count = points(text.trim());
  return count >= 1 && count <= max;
}

/** 打开对话框时的初值：新建全空、分类 `开发`；编辑取该专家的六个字段。 */
export function initialValues(opened: ExpertView | null): ExpertFormValues {
  return {
    name: opened?.name ?? "",
    description: opened?.description ?? "",
    category: opened?.category ?? "开发",
    tags: opened?.tags.join(TAG_JOINER) ?? "",
    prompt: opened?.prompt ?? "",
    skills: opened?.skills ?? [],
  };
}

/** 逐字段校验；每个字段至多一条原因（标签先判项数、再判每项长度）。 */
export function validateExpertForm(values: ExpertFormValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!inRange(values.name, MAX_NAME)) errors.name = FIELD_MESSAGES.name;
  if (points(values.description) > MAX_DESCRIPTION) errors.description = FIELD_MESSAGES.description;
  const tags = tagsProblem(splitTags(values.tags));
  if (tags) errors.tags = tags;
  if (!inRange(values.prompt, MAX_PROMPT)) errors.prompt = FIELD_MESSAGES.prompt;
  if (values.skills.length > MAX_SKILLS) errors.skills = FIELD_MESSAGES.skills;
  return errors;
}

/** 新建与编辑同一个 body：恒为六键；标签去重保序，技能按勾选次序。 */
export function toExpertInput(values: ExpertFormValues): ExpertInput {
  return {
    name: values.name.trim(),
    description: values.description,
    category: values.category,
    tags: [...new Set(splitTags(values.tags))],
    prompt: values.prompt.trim(),
    skills: [...values.skills],
  };
}
