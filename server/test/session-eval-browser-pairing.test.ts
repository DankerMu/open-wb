/**
 * Issue #1570 (omp-pin-18-12 task 6.2) tool-approval「浏览器审批与浏览器步骤配对」 and the supervisor
 * side of「浏览器调用的审批改写为浏览器操作」, through the production assembly (createApp →
 * registerSessions → SessionSupervisor, in-memory SQLite) with a scripted controlled child
 * (session-approval-script.ts). Two `eval` calls drive the browser in one turn: the first in
 * v18.0.10's order (select, then `tool_execution_start`), the second in v18.12.3's (start, then
 * select), each with blind prelude cards (`Allow tool: browser`) before, between and after. Expected
 * values are literals from those scenarios, tool-approval「确认与步骤配对」 and the injected clock `T`.
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
  stepRows,
} from "./session-approval-script.js";
import { assistantIdFor, waitForTurn } from "./session-supervisor-helpers.js";

afterEach(closeScripted);

const OPEN_CODE = 'await browser.open({ name: "main", url: "https://example.com/a" });';
const SHOT_CODE = 'await browser.tab("main").screenshot();';
const OPEN_TITLE = `Allow tool: eval\nLanguage: javascript\nCode:\n${OPEN_CODE}`;
const SHOT_TITLE = `Allow tool: eval\nLanguage: javascript\nCode:\n${SHOT_CODE}`;

function evalStart(call: string, code: string): OmpFrame {
  return {
    type: "tool_execution_start",
    toolCallId: call,
    toolName: "eval",
    args: { language: "js", code },
  };
}

function evalSelect(id: string, title: string): OmpFrame {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title,
    options: ["Approve", "Approve eval for this session", "Deny"],
  };
}

function prelude(id: string): OmpFrame {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title: "Allow tool: browser",
    options: ["Approve", "Deny"],
  };
}

function approvalColumns(db: DatabaseSync, messageId: number) {
  return db
    .prepare(
      "SELECT id, request_id, tool, title FROM chat_approvals WHERE message_id = ? ORDER BY id",
    )
    .all(messageId) as Array<{ id: number; request_id: string; tool: string; title: string }>;
}

function approvalAudits(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT detail FROM audit_events WHERE kind = 'session.approval' ORDER BY id")
    .all()
    .map((row) => JSON.parse(String(row.detail)) as unknown);
}

describe("tool-approval「浏览器审批与浏览器步骤配对」", () => {
  it(
    "each eval approval pairs with its eval step by name in either order; blind cards never enter the queue",
    REAL,
    async () => {
      const { world, answers } = await openScripted({
        prompt: (child) =>
          child.emitRaw(
            chunk(evalSelect("r1", OPEN_TITLE), prelude("p1"), evalStart("e1", OPEN_CODE)),
          ),
        answer(child, frame) {
          if (frame.id === "r1") {
            child.emitRaw(
              chunk(
                prelude("p2"),
                end("e1", "eval"),
                evalStart("e2", SHOT_CODE),
                prelude("p3"),
                evalSelect("r2", SHOT_TITLE),
              ),
            );
          } else if (frame.id === "r2") {
            child.emitRaw(chunk(prelude("p4")));
          } else if (frame.id === "p4") {
            finishing(end("e2", "eval"))(child);
          }
        },
      });
      await prompted(world);
      await waitForEvent(world, "step.start");
      await decide(world, "r1", "allow");
      await waitForEvent(world, "approval.request", 2);
      await decide(world, "r2", "allow");
      await waitForTurn(world.fixture, world.session, "done");

      const messageId = assistantIdFor(world.fixture, world.session);
      const approve = (id: string) => ({ type: "extension_ui_response", id, value: "Approve" });
      expect(answers).toEqual(["p1", "r1", "p2", "p3", "r2", "p4"].map(approve));
      const steps = stepRows(world.fixture.db, messageId);
      expect(steps.map((row) => [row.name, row.status])).toEqual([
        ["eval", "done"],
        ["eval", "done"],
      ]);
      // Only the two eval approvals, verbatim, each paired with its own step.
      const rows = approvalColumns(world.fixture.db, messageId);
      expect(rows.map((row) => [row.request_id, row.tool, row.title])).toEqual([
        ["r1", "eval", OPEN_TITLE],
        ["r2", "eval", SHOT_TITLE],
      ]);
      expect(pairingRows(world.fixture.db, messageId)).toEqual([
        { request_id: "r1", decision: "allow", decided_at: T, step_id: steps[0]?.id },
        { request_id: "r2", decision: "allow", decided_at: T, step_id: steps[1]?.id },
      ]);
      // Select first: the step carries the approval; start first: the request carries the step.
      expect(
        ofType(sessionEvents(world), "step.start").map((event) => [
          event.data.name,
          event.data.approvalId,
        ]),
      ).toEqual([
        ["eval", rows[0]?.id],
        ["eval", null],
      ]);
      expect(
        ofType(sessionEvents(world), "approval.request").map((event) => [
          event.data.tool,
          event.data.title,
          event.data.stepId,
        ]),
      ).toEqual([
        ["eval", OPEN_TITLE, null],
        ["eval", SHOT_TITLE, steps[1]?.id],
      ]);
      expect(approvalAudits(world.fixture.db)).toEqual([
        { sessionId: world.session, messageId, tool: "eval", decision: "allow" },
        { sessionId: world.session, messageId, tool: "eval", decision: "allow" },
      ]);
      expect(world.errors).toEqual([]);
    },
  );
});
