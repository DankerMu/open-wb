/**
 * Issue #1566 (omp-pin-18-12 task 2.3, design D3): tool-approval「浏览器 prelude 的卡不是审批」 on the
 * supervisor side, through the production assembly (createApp → registerSessions →
 * SessionSupervisor, in-memory SQLite) with a scripted controlled child (session-approval-script.ts).
 * An approved `eval` step is running when the child sends two prelude cards (`Allow tool: browser`,
 * and the same with one `Reason:` line); after both are answered a bash step asks for approval as
 * usual. `preludeApproval` stops at OmpProcess (nothing is wired into SessionRuntime or the
 * supervisor), so the oracle here is that the cards leave no approval trace at all: the child got
 * `Approve` for them without any decision, `chat_approvals` holds only the two real approvals, both
 * paired with their own steps (no stranded unpaired approval), and there is no `approval.request`
 * event and no `session.approval` audit for them. Expected values are literals from the scenario,
 * tool-approval「确认与步骤配对」 and the injected clock `T`.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  ofType,
  prompted,
  REAL,
  sessionEvents,
  T,
  waitForEvent,
} from "./session-approval-helpers.js";
import {
  chunk,
  closeScripted,
  decide,
  end,
  finishing,
  openScripted,
  pairingRows,
  select,
  start,
  stepRows,
} from "./session-approval-script.js";
import { assistantIdFor, waitForTurn } from "./session-supervisor-helpers.js";

afterEach(closeScripted);

function prelude(id: string, title: string): OmpFrame {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title,
    options: ["Approve", "Deny"],
  };
}

function approvalAudits(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT detail FROM audit_events WHERE kind = 'session.approval' ORDER BY id")
    .all()
    .map((row) => JSON.parse(String(row.detail)) as unknown);
}

describe("tool-approval「浏览器 prelude 的卡不是审批」: the supervisor sees nothing of it", () => {
  it(
    "two prelude cards inside an approved eval step: answered Approve by the transport, no row, no event, no audit, pairing intact",
    REAL,
    async () => {
      const { world, answers } = await openScripted({
        prompt: (child) => child.emitRaw(chunk(start("c1", "eval"), select("r1", "eval"))),
        answer(child, frame) {
          if (frame.id === "r1") {
            child.emitRaw(
              chunk(
                prelude("p1", "Allow tool: browser"),
                prelude("p2", "Allow tool: browser\nReason: target not yet approved"),
              ),
            );
          } else if (frame.id === "p2") {
            child.emitRaw(chunk(start("c2"), select("r2")));
          } else if (frame.id === "r2") {
            finishing(end("c1", "eval"), end("c2"))(child);
          }
        },
      });
      await prompted(world);
      await waitForEvent(world, "approval.request");
      await decide(world, "r1", "allow");
      await waitForEvent(world, "approval.request", 2);
      await decide(world, "r2", "allow");
      await waitForTurn(world.fixture, world.session, "done");

      const messageId = assistantIdFor(world.fixture, world.session);
      expect(answers).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
        { type: "extension_ui_response", id: "p1", value: "Approve" },
        { type: "extension_ui_response", id: "p2", value: "Approve" },
        { type: "extension_ui_response", id: "r2", value: "Approve" },
      ]);
      const steps = stepRows(world.fixture.db, messageId);
      expect(steps.map((row) => [row.name, row.status])).toEqual([
        ["eval", "done"],
        ["bash", "done"],
      ]);
      // Only the two real approvals, each paired with its own step: nothing stranded unpaired.
      expect(pairingRows(world.fixture.db, messageId)).toEqual([
        { request_id: "r1", decision: "allow", decided_at: T, step_id: steps[0]?.id },
        { request_id: "r2", decision: "allow", decided_at: T, step_id: steps[1]?.id },
      ]);
      expect(
        ofType(sessionEvents(world), "approval.request").map((event) => [
          event.data.tool,
          event.data.stepId,
        ]),
      ).toEqual([
        ["eval", steps[0]?.id],
        ["bash", steps[1]?.id],
      ]);
      expect(approvalAudits(world.fixture.db)).toEqual([
        { sessionId: world.session, messageId, tool: "eval", decision: "allow" },
        { sessionId: world.session, messageId, tool: "bash", decision: "allow" },
      ]);
      expect(world.errors).toEqual([]);
    },
  );
});
