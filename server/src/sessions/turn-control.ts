/**
 * Turn dispatch helpers: event persistence and post-failure stream draining.
 */
import type { ChatEvent } from "./events.js";
import type { SessionStore } from "./store.js";

export function persistEvent(
  store: SessionStore,
  assistantMessageId: number,
  event: ChatEvent<string>,
  toolIds: Map<string, number>,
  nextOrdinal: () => number,
): ChatEvent<number> | undefined {
  switch (event.type) {
    case "turn.start":
    case "error":
      return event;
    case "text.delta":
      store.appendDelta(assistantMessageId, event.data.delta);
      return event;
    case "step.start": {
      const stepId = store.startStep(assistantMessageId, {
        ordinal: nextOrdinal(),
        name: event.data.name,
        detail: event.data.detail,
      });
      toolIds.set(event.data.stepId, stepId);
      return {
        type: "step.start",
        data: {
          messageId: event.data.messageId,
          stepId,
          name: event.data.name,
          detail: event.data.detail,
        },
      };
    }
    case "step.end": {
      const stepId = toolIds.get(event.data.stepId);
      if (stepId === undefined) {
        return undefined;
      }
      store.finishStep(stepId, event.data.status, event.data.output);
      return {
        type: "step.end",
        data: {
          messageId: event.data.messageId,
          stepId,
          status: event.data.status,
          output: event.data.output,
        },
      };
    }
    case "turn.end":
      store.finishTurn(assistantMessageId, event.data.status);
      return event;
  }
}

export async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _frame of stream) {
      /* discard buffered frames after pre-progress failure */
    }
  } catch {
    /* iterator already failed */
  }
}
