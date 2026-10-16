/**
 * Issue 1473 (chat-interleaved-segments 4.4 / 4.5, design D6): the call the owner denies, on the
 * real chain — official omp v18.0.10, the model proxy and the controlled upstream, in
 * `openProxiedApp` (the production sessions assembly; the world denies every published
 * `approval.request`). `跑一个命令` makes the fake upstream's first request the bash tool round.
 *
 * 实测 (4.4, three runs, all alike): the denied call has its `tool_execution_start` and a
 * `tool_execution_end{isError:true}`, so it has a step that ends `failed`, and the select reaches
 * stdout before that start. Pinned here as branch one (task 4.5): exactly one bash step, `failed`;
 * the denied approval's `step_id` is that step (the select queues it, the later start takes it,
 * tool-approval「确认与步骤配对」rule 1); decision `deny`; select before start on the wire. The
 * ring order of `approval.resolved` and `step.start` is this world's prompt auto-deny, not omp's,
 * and is not asserted. An omp upgrade that changes any of it turns this case red first.
 *
 * The case prints one `[approval-pairing] ` line (frame labels of the turn, the step and approval
 * rows), quoted as 实测.
 *
 * Run locally: `make omp-fetch`, then in `server/`
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-approval-pairing.test.ts --coverage=false
 * Without `WORKBUDDY_OMP_TEST=1` the file is skipped (also under `make test`).
 */
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { approvalRequest } from "../src/sessions/omp/ui-requests.js";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import { openProxiedApp, runAppTurn } from "./support/omp-official-proxied.js";

const CASE = { timeout: 120_000 };

function isBashSelect(frame: OmpFrame): boolean {
  return (
    frame.type === "extension_ui_request" &&
    typeof frame.id === "string" &&
    approvalRequest(frame, frame.id)?.tool === "bash"
  );
}

/** One short label per frame that is not a delta, for the printed 实测 line. */
function label(frame: OmpFrame): string[] {
  switch (frame.type) {
    case "message_update":
      return [];
    case "extension_ui_request":
      return [`select:${String(frame.method)}:${isBashSelect(frame) ? "bash" : "-"}`];
    case "tool_execution_start":
      return [`start:${String(frame.toolName)}`];
    case "tool_execution_end":
      return [`end:isError=${String(frame.isError)}`];
    default:
      return [String(frame.type)];
  }
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: the denied call's step`, () => {
  it(
    "the denied bash call has a failed step, paired with its deny; its select is first",
    CASE,
    async () => {
      const world = await openProxiedApp();
      const turn = await runAppTurn(world, "跑一个命令");
      expect(turn.events.at(-1)).toMatchObject({ type: "turn.end", data: { status: "done" } });
      expect(world.faults).toEqual([]);

      const messageId = Number(turn.events[0]?.data.messageId);
      const steps = world.db
        .prepare("SELECT id, name, status FROM chat_steps WHERE message_id = ? ORDER BY ordinal")
        .all(messageId) as Array<{ id: number; name: string; status: string }>;
      const approvals = world.db
        .prepare(
          "SELECT id, tool, decision, step_id FROM chat_approvals WHERE message_id = ? ORDER BY id",
        )
        .all(messageId);
      console.log(
        `[approval-pairing] ${JSON.stringify({ frames: turn.frames.flatMap(label), steps, approvals })}`,
      );

      const starts = turn.frames.filter((frame) => frame.type === "tool_execution_start");
      expect(starts.map((frame) => frame.toolName)).toEqual(["bash"]);
      const ends = turn.frames.filter((frame) => frame.type === "tool_execution_end");
      expect(ends.map((frame) => [frame.toolCallId, frame.isError])).toEqual([
        [starts[0]?.toolCallId, true],
      ]);
      const select = turn.frames.findIndex(isBashSelect);
      expect(select).toBeGreaterThan(-1);
      expect(select).toBeLessThan(turn.frames.indexOf(starts[0] as OmpFrame));

      const ring = turn.events.flatMap((event) =>
        event.type === "step.start"
          ? ["start"]
          : event.type === "step.end"
            ? [event.data.status]
            : [],
      );
      expect(ring).toEqual(["start", "failed"]);
      expect(steps).toEqual([{ id: steps[0]?.id, name: "bash", status: "failed" }]);
      expect(approvals).toEqual([
        { id: world.denied[0], tool: "bash", decision: "deny", step_id: steps[0]?.id },
      ]);
    },
  );
});
