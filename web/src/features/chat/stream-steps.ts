import type { ChatStep } from "../../lib/session-contract.js";

/** A message's step as the chat view holds it: the snapshot step without `ordinal`. */
export type ChatStepView = {
  id: ChatStep["id"];
  name: ChatStep["name"];
  detail: ChatStep["detail"];
  output: ChatStep["output"];
  changes: ChatStep["changes"];
  status: ChatStep["status"];
};

type WithSteps = { steps: ChatStepView[] };

/** Appends a running step without changes; a `stepId` already present returns the same message. */
export function startStep<M extends WithSteps>(
  message: M,
  data: { stepId: number; name: string; detail: string },
): M {
  if (message.steps.some((step) => step.id === data.stepId)) {
    return message;
  }
  return {
    ...message,
    steps: [
      ...message.steps,
      {
        id: data.stepId,
        name: data.name,
        detail: data.detail,
        output: "",
        changes: null,
        status: "running",
      },
    ],
  };
}

/** Settles an existing step; `step.end` carries no changes, so the step keeps the ones it has. */
export function endStep<M extends WithSteps>(
  message: M,
  data: { stepId: number; status: "done" | "failed"; output: string },
): M {
  // detail 固定为 step.start/快照中的 args，step.end 只带回状态与输出（#367）。
  return updateStep(message, data.stepId, (current) => ({
    id: current.id,
    name: current.name,
    detail: current.detail,
    output: data.output,
    changes: current.changes,
    status: data.status,
  }));
}

/** 只替换 `stepId` 那一步；步骤不存在时原样返回 `message`（同一引用）。 */
export function updateStep<M extends WithSteps>(
  message: M,
  stepId: number,
  update: (step: ChatStepView) => ChatStepView,
): M {
  const index = message.steps.findIndex((step) => step.id === stepId);
  const current = index < 0 ? undefined : message.steps[index];
  if (current === undefined) {
    return message;
  }
  const steps = message.steps.slice();
  steps[index] = update(current);
  return { ...message, steps };
}
