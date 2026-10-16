/**
 * Issue 1473 (chat-interleaved-segments design D6/D16): one per pump, so per turn and dropped with
 * it. It holds the pump's `toolCallId → step id` map and step ordinals, and the two pairing states,
 * both in the order the pump reads frames: approvals not yet paired `{requestId, tool}` and running
 * steps not yet paired `{stepId, name}`. A same-name approval and step pair when the later of the
 * two arrives, whichever that is: omp does not order a select against its `tool_execution_start`
 * on stdout (读代码推出, design Context; official v18.0.10 runs showed select first, 实测), and the
 * runtime inserts an approval row before the pump reads the frames ahead of its select (读代码推出),
 * so the database's unpaired rows are never consulted. Only `chat_approvals.step_id` is written; no
 * decision, timer, frame, audit or event depends on it.
 */
import type { OmpFrame } from "./omp/frame.js";
import type { SessionStore } from "./store.js";

type PairingStore = Pick<SessionStore, "approvalTool" | "pairApproval">;

export class PumpSteps {
  /** omp's toolCallId → the stored step id. */
  readonly toolIds = new Map<string, number>();
  readonly #messageId: number;
  #ordinal = 0;
  readonly #queue: Array<{ requestId: string; tool: string }> = [];
  readonly #running: Array<{ stepId: number; name: string }> = [];

  constructor(messageId: number) {
    this.#messageId = messageId;
  }

  nextOrdinal(): number {
    const current = this.#ordinal;
    this.#ordinal += 1;
    return current;
  }

  /** Rule 1, before the step insert: takes the first queued approval named `name` out. */
  takeApproval(name: string): string | undefined {
    const index = this.#queue.findIndex((entry) => entry.tool === name);
    return index === -1 ? undefined : this.#queue.splice(index, 1)[0]?.requestId;
  }

  /** After the committed insert: a step that paired no approval row runs unpaired. */
  started(toolCallId: string, stepId: number, name: string, approvalId: number | null): void {
    this.toolIds.set(toolCallId, stepId);
    if (approvalId === null) {
      this.#running.push({ stepId, name });
    }
  }

  /** Rule 3, after the step's end is stored: an ended step is never paired. */
  ended(stepId: number): void {
    const index = this.#running.findIndex((step) => step.stepId === stepId);
    if (index !== -1) {
      this.#running.splice(index, 1);
    }
  }

  /**
   * Rule 2, before `publishRequest` for the same frame. Only OmpProcess classifies a select (the
   * ui-requests boundary): the approval row registered for this message names the tool; a frame
   * without one is no approval, or one the runtime dropped (读代码推出). A select whose request
   * publishes now pairs the earliest-started running step of its tool (that write commits first);
   * with no such step, a zero-row write, or a request a settlement already published, it queues.
   */
  select(frame: OmpFrame, publishes: () => boolean, store: PairingStore): void {
    const id = frame.type === "extension_ui_request" ? frame.id : undefined;
    const tool = typeof id === "string" ? store.approvalTool(this.#messageId, id) : undefined;
    if (typeof id !== "string" || tool === undefined) {
      return;
    }
    const index = publishes() ? this.#running.findIndex((step) => step.name === tool) : -1;
    const step = this.#running[index];
    if (step !== undefined && store.pairApproval(this.#messageId, id, step.stepId) !== null) {
      this.#running.splice(index, 1);
      return;
    }
    this.#queue.push({ requestId: id, tool });
  }
}
