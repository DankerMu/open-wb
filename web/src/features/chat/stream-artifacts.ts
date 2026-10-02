import { hasExactlyKeys } from "../../lib/api-json.js";
import { type ChatStep, parseFileChanges } from "../../lib/session-contract.js";
import { type ChatStepView, updateStep } from "./stream-steps.js";

type FileChanges = NonNullable<ChatStep["changes"]>;

export type ChatFilesEvent = {
  type: "files.changed";
  data: { messageId: number; stepId: number; files: FileChanges };
};

/**
 * Strict key set `{messageId, stepId, files}`: two safe-integer ids and `files` under the rule of
 * a snapshot step's non-null `changes` (1..50 valid elements), else `undefined`.
 */
export function decodeFilesChanged(value: unknown): ChatFilesEvent | undefined {
  if (
    !hasExactlyKeys(value, ["messageId", "stepId", "files"]) ||
    !isSafeInteger(value.messageId) ||
    !isSafeInteger(value.stepId)
  ) {
    return undefined;
  }
  const files = parseFileChanges(value.files);
  return files === null
    ? undefined
    : { type: "files.changed", data: { messageId: value.messageId, stepId: value.stepId, files } };
}

/** Replaces the changes of step `stepId` (the later event wins); an unknown step is a no-op. */
export function setStepChanges<M extends { steps: ChatStepView[] }>(
  message: M,
  data: { stepId: number; files: FileChanges },
): M {
  return updateStep(message, data.stepId, (step) => ({ ...step, changes: data.files }));
}

/** 已结束步骤的变更按路径汇总：位置取首次出现，值取数组中最靠后的步骤（步骤数组即 ordinal 次序）。 */
export function summarizeChanges(steps: readonly ChatStepView[]): FileChanges[number][] {
  const byPath = new Map<string, FileChanges[number]>();
  for (const step of steps) {
    if (step.status === "running") continue;
    for (const change of step.changes ?? []) byPath.set(change.path, change);
  }
  return [...byPath.values()];
}

type Artifact = { kind: "html" | "image" | "code"; label: string; name: string };

/** 扩展名（小写）→ 产物卡类别与标签：预览 API 可预览的全部类型。 */
const ARTIFACT_KINDS = new Map<string, Pick<Artifact, "kind" | "label">>([
  ["html", { kind: "html", label: "HTML" }],
  ["png", { kind: "image", label: "PNG" }],
  ["jpg", { kind: "image", label: "JPG" }],
  ["jpeg", { kind: "image", label: "JPG" }],
  ["md", { kind: "code", label: "MD" }],
  ["txt", { kind: "code", label: "TXT" }],
  ["log", { kind: "code", label: "LOG" }],
  ["csv", { kind: "code", label: "CSV" }],
  ["json", { kind: "code", label: "JSON" }],
  ["js", { kind: "code", label: "JS" }],
  ["ts", { kind: "code", label: "TS" }],
  ["tsx", { kind: "code", label: "TSX" }],
]);

/**
 * 变更路径派生的产物：`name` 是末段文件名，扩展名取 `name` 最后一个 `.` 之后、不分大小写查表。
 * 没有 `.`、`.` 在末尾或扩展名不在表里时为 null（不派生产物卡）。
 */
export function artifactKind(path: string): Artifact | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const entry = dot === -1 ? undefined : ARTIFACT_KINDS.get(name.slice(dot + 1).toLowerCase());
  return entry === undefined ? null : { ...entry, name };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
