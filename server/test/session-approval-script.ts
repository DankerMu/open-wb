/**
 * Scripted controlled children for the approval/step pairing tests (issue 1473, design D6), moved
 * verbatim out of session-approval-pairing.test.ts by issue 1474 so its event-payload tests share
 * them: frame builders, a world whose child writes the scripted stdout (one chunk where the order
 * against the runtime's synchronous approval insert matters), and raw-row readers.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { T } from "./session-approval-helpers.js";
import {
  assistantIdFor,
  closeAfterRetainedFault,
  closeOnEof,
  createControlledRuntime,
  openRecordingSession,
  type RecordingWorld,
  type SpawnCall,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";

export const AGENT_END: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };
const ABORTED_END: OmpFrame = {
  type: "message_end",
  message: { role: "assistant", content: [], stopReason: "aborted" },
};

export function start(call: string, tool = "bash"): OmpFrame {
  return {
    type: "tool_execution_start",
    toolCallId: call,
    toolName: tool,
    args: { command: `echo ${call}` },
  };
}

export function end(call: string, tool = "bash"): OmpFrame {
  return {
    type: "tool_execution_end",
    toolCallId: call,
    toolName: tool,
    result: { content: [{ type: "text", text: `${call} ok` }], details: {} },
  };
}

export function select(id: string, tool = "bash"): OmpFrame {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title: `Allow tool: ${tool}\nCommand: echo ${id}`,
    options: ["Approve", "Deny"],
  };
}

export const TEXT: OmpFrame = {
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
  message: { role: "assistant", content: [] },
};

export function chunk(...frames: OmpFrame[]): string {
  return frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");
}

export interface Scripted {
  world: RecordingWorld;
  /** The extension_ui_response frames the child received, in order. */
  answers: OmpFrame[];
  /** Every spawn the runtime made (argv, env), in order. */
  calls: SpawnCall[];
}

export interface Script {
  /** Written after agent_start on the prompt. */
  prompt(child: FakeChild): void;
  /** On each extension_ui_response; nothing by default (the turn then ends by stop or fault). */
  answer?(child: FakeChild, frame: OmpFrame): void;
  onEvent?(world: RecordingWorld, event: ChatEvent<number>): void;
  /** A retained fault is expected: the shutdown report is tolerated. */
  faulted?: boolean;
}

const cleanups: Array<() => Promise<void>> = [];

/** For the test file's `afterEach`: closes every scripted world opened since the last call. */
export async function closeScripted(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
}

export async function openScripted(script: Script): Promise<Scripted> {
  const answers: OmpFrame[] = [];
  const controlled = createControlledRuntime((child) => {
    closeOnEof(child);
    child.onCommand("prompt", () => {
      child.emitLine({ type: "agent_start" });
      script.prompt(child);
    });
    child.onCommand("extension_ui_response", (frame) => {
      answers.push(frame);
      script.answer?.(child, frame);
    });
    child.onCommand("abort", (frame) => {
      child.emitRaw(chunk(ABORTED_END, AGENT_END));
      child.emitLine({ id: frame.id, type: "response", command: "abort", success: true });
    });
  });
  controlled.clock.nowMs = T;
  let world: RecordingWorld | undefined;
  world = await openRecordingSession(controlled.runtime, {
    onEvent(_session, _epoch, event) {
      if (world !== undefined) script.onEvent?.(world, event);
    },
  });
  const opened = world;
  cleanups.push(() => closeAfterRetainedFault(opened.fixture, script.faulted === true));
  return { world, answers, calls: controlled.calls };
}

export interface PairingRow {
  request_id: string;
  decision: string | null;
  decided_at: number | null;
  step_id: number | null;
}

export function pairingRows(db: DatabaseSync, messageId: number): PairingRow[] {
  return db
    .prepare(
      "SELECT request_id, decision, decided_at, step_id FROM chat_approvals WHERE message_id = ? ORDER BY id",
    )
    .all(messageId) as unknown as PairingRow[];
}

/** The message's steps by ordinal: id, the omp call's name and status. */
export function stepRows(db: DatabaseSync, messageId: number) {
  return db
    .prepare("SELECT id, name, status FROM chat_steps WHERE message_id = ? ORDER BY ordinal")
    .all(messageId) as Array<{ id: number; name: string; status: string }>;
}

export function stepIds(db: DatabaseSync, messageId: number): number[] {
  return stepRows(db, messageId).map((row) => row.id);
}

export async function decide(world: RecordingWorld, requestId: string, decision: "allow" | "deny") {
  const messageId = assistantIdFor(world.fixture, world.session);
  const row = world.fixture.db
    .prepare("SELECT id FROM chat_approvals WHERE message_id = ? AND request_id = ?")
    .get(messageId, requestId) as { id: number };
  return world.fixture.supervisor.decide(world.session, row.id, decision);
}

/** Ends the turn after an answer: each call's end, then agent_end. */
export function finishing(...frames: OmpFrame[]): (child: FakeChild) => void {
  return (child) => {
    child.emitRaw(chunk(...frames, AGENT_END));
  };
}
