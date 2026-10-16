/**
 * Issue 1471 (chat-interleaved-segments 3a) over the production assembly and a real fake-omp
 * `approval-parallel` child: chat-stream「步骤的正文偏移」at the database layer. Each step row's
 * `body_offset` equals the UTF-16 length of the `text.delta` deltas published before that
 * `step.start` (the recorded onEvent stream, i.e. ring order); the fake's deltas are fixed
 * (`fake-omp.mjs` DELTAS: "Hello ", "from ", "fake-omp"), so both offsets are also the literal 19.
 * The event field `bodyOffset` arrives with slice 5 (design D8): until then `step.start` keeps its
 * four keys.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalWorld,
  ofType,
  openApprovalWorld,
  prompted,
  REAL,
  sessionEvents,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import { waitForTurn } from "./session-supervisor-helpers.js";

const worlds: ApprovalWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

/** UTF-16 length of the text deltas published before each step.start, in ring order. */
function bodyBeforeEachStart(world: ApprovalWorld): Array<{ stepId: number; length: number }> {
  let body = "";
  const starts: Array<{ stepId: number; length: number }> = [];
  for (const { event } of sessionEvents(world)) {
    if (event.type === "text.delta") {
      body += event.data.delta;
    } else if (event.type === "step.start") {
      starts.push({ stepId: event.data.stepId, length: body.length });
    }
  }
  return starts;
}

describe("chat-stream「步骤的正文偏移」at the database layer", () => {
  it(
    "both approval-parallel steps store the length of the text published before their step.start",
    REAL,
    async () => {
      const world = await openApprovalWorld("approval-parallel");
      worlds.push(world);
      await prompted(world);
      const [r1, r2] = await waitForRows(world, 2);
      if (r1 === undefined || r2 === undefined) {
        throw new Error("expected two approval rows");
      }
      await waitForEvent(world, "step.start", 2);

      const starts = bodyBeforeEachStart(world);
      expect(starts.map((start) => start.length)).toEqual([19, 19]);
      const offsets = world.fixture.db
        .prepare("SELECT id, body_offset FROM chat_steps ORDER BY ordinal, id")
        .all() as Array<{ id: number; body_offset: unknown }>;
      expect(offsets).toEqual(
        starts.map(({ stepId, length }) => ({ id: stepId, body_offset: length })),
      );

      for (const start of ofType(sessionEvents(world), "step.start")) {
        expect(Object.keys(start.data).sort()).toEqual(["detail", "messageId", "name", "stepId"]);
      }
      await world.fixture.supervisor.decide(world.session, r2.id, "deny");
      await world.fixture.supervisor.decide(world.session, r1.id, "allow");
      await waitForTurn(world.fixture, world.session, "done");
      expect(
        world.fixture.db.prepare("SELECT body_offset FROM chat_steps ORDER BY ordinal, id").all(),
      ).toEqual([{ body_offset: 19 }, { body_offset: 19 }]);
    },
  );
});
