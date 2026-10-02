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

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
