/**
 * Issue 1473 (chat-interleaved-segments 4.2, design D6/D7) through the production assembly
 * (createApp → registerSessions → SessionSupervisor, in-memory SQLite): tool-approval「确认与步骤配对」
 * and turn-control「拷贝审批记录」. The parallel case runs the real fake-omp `approval-parallel`
 * child (both selects before both tool starts, like omp v18.0.10); every other order — a tool start
 * before its select, a step that ended first, another tool's step, an answer before the pump reads
 * the select — needs a scripted controlled child, as fake-omp emits no such sequence and its
 * scripts stay as they are (#910 `session-thinking.test.ts` precedent). Frames of one case are
 * written as one stdout chunk where the order against the runtime's synchronous approval insert
 * matters: the process layer then registers the approval row before the pump reads the frames
 * before its select (design Context「审批行早于 pump 插入」).
 *
 * Oracles are SQLite rows read with the test's own SQL, the stdin frames the child received, the
 * audit rows and the recorded onEvent stream (the scripted children live in session-approval-script.ts). The decision, `decided_at`, audit, frame and
 * `approval.resolved` values are literals from tool-approval「审批作答 REST」「审批事件」and the
 * injected clock, the same values the existing R11 (`session-approvals-parallel.test.ts`) pins:
 * pairing writes only `step_id` (design D6「不碰作答路径」).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalWorld,
  ofType,
  openApprovalWorld,
  prompted,
  REAL,
  responses,
  sessionEvents,
  settle,
  spawnedAt,
  T,
  TITLE,
  TITLE_2,
  TTL_MS,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import {
  AGENT_END,
  chunk,
  closeScripted,
  decide,
  end,
  finishing,
  openScripted,
  pairingRows,
  select,
  start,
  stepIds,
  stepRows,
  TEXT,
} from "./session-approval-script.js";
import { FIXED_NOW, withFakeClock, withSessionStore } from "./session-store-helpers.js";
import {
  assistantIdFor,
  containsMessage,
  OWNER_ID,
  type RecordingWorld,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";

afterEach(closeScripted);

const AUDIT_TITLE = "工具执行审批";
const SENTINEL = "pairing write sentinel";
/** Every write of `step_id` fails: the step insert's transaction and the select-time update. */
const REJECT_PAIRING = `CREATE TEMP TRIGGER reject_pairing BEFORE UPDATE OF step_id ON chat_approvals
  BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`;

function audits(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT actor_id, kind, title, detail FROM audit_events WHERE kind = 'session.approval' ORDER BY id",
    )
    .all()
    .map((row) => ({ ...row, detail: JSON.parse(String(row.detail)) as unknown }));
}

function approvalEvents(world: RecordingWorld) {
  return sessionEvents(world)
    .map((entry) => entry.event)
    .filter((event) => event.type.startsWith("approval."));
}

async function ownerStop(world: RecordingWorld): Promise<void> {
  const response = await world.fixture.app.inject({
    method: "POST",
    url: `/api/sessions/${world.session}/stop`,
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(202);
}

const worlds: ApprovalWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

describe("tool-approval「确认与步骤配对」: same name, first in first out", () => {
  it(
    "同名工具按先进先出配对: r1 → the first bash step, r2 → the second; every answer value unchanged",
    REAL,
    async () => {
      const world = await openApprovalWorld("approval-parallel");
      worlds.push(world);
      await prompted(world);
      const [r1, r2] = await waitForRows(world, 2);
      await waitForEvent(world, "approval.request", 2);
      await waitForEvent(world, "step.start", 2);
      const messageId = assistantIdFor(world.fixture, world.session);
      const [first, second] = stepIds(world.fixture.db, messageId);
      // Paired when the starts were persisted, before any answer; nothing else on the rows moved.
      expect(pairingRows(world.fixture.db, messageId)).toEqual([
        { request_id: "r1", decision: null, decided_at: null, step_id: first },
        { request_id: "r2", decision: null, decided_at: null, step_id: second },
      ]);

      await world.fixture.supervisor.decide(world.session, Number(r2?.id), "deny");
      await world.fixture.supervisor.decide(world.session, Number(r1?.id), "allow");
      await waitForTurn(world.fixture, world.session, "done");

      expect(pairingRows(world.fixture.db, messageId)).toEqual([
        { request_id: "r1", decision: "allow", decided_at: T, step_id: first },
        { request_id: "r2", decision: "deny", decided_at: T, step_id: second },
      ]);
      expect(stepRows(world.fixture.db, messageId).map((row) => row.status)).toEqual([
        "done",
        "failed",
      ]);
      const detail = (decision: string) => ({
        sessionId: world.session,
        messageId,
        tool: "bash",
        decision,
      });
      expect(audits(world.fixture.db)).toEqual([
        {
          actor_id: OWNER_ID,
          kind: "session.approval",
          title: AUDIT_TITLE,
          detail: detail("deny"),
        },
        {
          actor_id: OWNER_ID,
          kind: "session.approval",
          title: AUDIT_TITLE,
          detail: detail("allow"),
        },
      ]);
      expect(responses(spawnedAt(world, 0))).toEqual([
        { type: "extension_ui_response", id: "r2", value: "Deny" },
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
      const request = (approvalId: number | undefined, title: string) => ({
        type: "approval.request",
        data: { messageId, approvalId, tool: "bash", title, expiresAt: T + TTL_MS, stepId: null },
      });
      const resolved = (approvalId: number | undefined, decision: string) => ({
        type: "approval.resolved",
        data: { messageId, approvalId, decision },
      });
      expect(approvalEvents(world)).toEqual([
        request(r1?.id, TITLE),
        request(r2?.id, TITLE_2),
        resolved(r2?.id, "deny"),
        resolved(r1?.id, "allow"),
      ]);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("tool-approval「确认与步骤配对」: the later arrival pairs, in pump order", () => {
  it(
    "步骤先于审批 select 到达: the start leaves the inserted row unpaired; the select pairs it before its request",
    REAL,
    async () => {
      const seen: Array<[string, Array<number | null>]> = [];
      const { world, answers } = await openScripted({
        prompt: (child) => child.emitRaw(chunk(start("c1"), select("r1"))),
        answer: finishing(end("c1")),
        onEvent(opened, event) {
          if (event.type === "step.start" || event.type === "approval.request") {
            const rows = pairingRows(opened.fixture.db, event.data.messageId);
            seen.push([event.type, rows.map((row) => row.step_id)]);
          }
        },
      });
      await prompted(world);
      await waitForEvent(world, "approval.request");
      await decide(world, "r1", "allow");
      await waitForTurn(world.fixture, world.session, "done");

      const messageId = assistantIdFor(world.fixture, world.session);
      const [step] = stepIds(world.fixture.db, messageId);
      // The row was in the database at step.start, but the pump had not read its select yet.
      expect(seen).toEqual([
        ["step.start", [null]],
        ["approval.request", [step]],
      ]);
      expect(pairingRows(world.fixture.db, messageId)).toEqual([
        { request_id: "r1", decision: "allow", decided_at: T, step_id: step },
      ]);
      expect(audits(world.fixture.db).map((row) => row.detail)).toEqual([
        { sessionId: world.session, messageId, tool: "bash", decision: "allow" },
      ]);
      expect(answers).toEqual([{ type: "extension_ui_response", id: "r1", value: "Approve" }]);
      expect(ofType(sessionEvents(world), "approval.request")).toHaveLength(1);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "已结束的步骤不再配对: a select after a step ended goes to the next bash step",
    REAL,
    async () => {
      const { world } = await openScripted({
        prompt: (child) => child.emitRaw(chunk(start("c1"), end("c1"), select("r1"), start("c2"))),
        answer: finishing(end("c2")),
      });
      await prompted(world);
      await waitForEvent(world, "approval.request");
      await decide(world, "r1", "allow");
      await waitForTurn(world.fixture, world.session, "done");

      const messageId = assistantIdFor(world.fixture, world.session);
      const [, later] = stepIds(world.fixture.db, messageId);
      expect(pairingRows(world.fixture.db, messageId).map((row) => row.step_id)).toEqual([later]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "a step paired at its start takes no second approval: select r1, start c1, select r2, start c2",
    REAL,
    async () => {
      let answered = 0;
      const { world } = await openScripted({
        prompt: (child) =>
          child.emitRaw(chunk(select("r1"), start("c1"), select("r2"), start("c2"))),
        answer: (child) => {
          answered += 1;
          if (answered === 2) child.emitRaw(chunk(end("c1"), end("c2"), AGENT_END));
        },
      });
      await prompted(world);
      await waitForEvent(world, "step.start", 2);
      await waitForEvent(world, "approval.request", 2);
      await decide(world, "r1", "allow");
      await decide(world, "r2", "allow");
      await waitForTurn(world.fixture, world.session, "done");

      const messageId = assistantIdFor(world.fixture, world.session);
      const [c1, c2] = stepIds(world.fixture.db, messageId);
      expect(pairingRows(world.fixture.db, messageId).map((row) => row.step_id)).toEqual([c1, c2]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "工具名不同不配对: a queued bash approval skips the read step and goes to the bash one",
    REAL,
    async () => {
      const { world } = await openScripted({
        prompt: (child) => child.emitRaw(chunk(select("r1"), start("c1", "read"), start("c2"))),
        answer: finishing(end("c1", "read"), end("c2")),
      });
      await prompted(world);
      await waitForEvent(world, "step.start", 2);
      await decide(world, "r1", "allow");
      await waitForTurn(world.fixture, world.session, "done");

      const messageId = assistantIdFor(world.fixture, world.session);
      const steps = stepRows(world.fixture.db, messageId);
      expect(steps.map((row) => row.name)).toEqual(["read", "bash"]);
      expect(pairingRows(world.fixture.db, messageId).map((row) => row.step_id)).toEqual([
        steps[1]?.id,
      ]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "工具名不同不配对: a bash select beside a running read step queues for a later bash step",
    REAL,
    async () => {
      const atRequest: Array<number | null> = [];
      const { world } = await openScripted({
        prompt: (child) => child.emitRaw(chunk(start("c1", "read"), select("r1"))),
        answer: finishing(end("c1", "read"), start("c2"), end("c2")),
        onEvent(opened, event) {
          if (event.type === "approval.request") {
            atRequest.push(
              ...pairingRows(opened.fixture.db, event.data.messageId).map((r) => r.step_id),
            );
          }
        },
      });
      await prompted(world);
      await waitForEvent(world, "approval.request");
      await decide(world, "r1", "allow");
      await waitForTurn(world.fixture, world.session, "done");

      const messageId = assistantIdFor(world.fixture, world.session);
      const steps = stepRows(world.fixture.db, messageId);
      expect(steps.map((row) => row.name)).toEqual(["read", "bash"]);
      expect(atRequest).toEqual([null]);
      expect(pairingRows(world.fixture.db, messageId).map((row) => row.step_id)).toEqual([
        steps[1]?.id,
      ]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "作答先于 pump 读到 select: the select only queues, its row stays unpaired until the next bash step",
    REAL,
    async () => {
      let requestsAtDecide: number | undefined;
      let decided: Promise<unknown> | undefined;
      let atSecondStart: Array<number | null> | undefined;
      const { world, answers } = await openScripted({
        // One chunk: the runtime inserts r1's row before the pump reads c1's start.
        prompt: (child) => child.emitRaw(chunk(start("c1"), TEXT, select("r1"))),
        answer: finishing(end("c1"), start("c2"), end("c2")),
        onEvent(opened, event) {
          if (event.type === "text.delta" && decided === undefined) {
            // The answer path publishes the request before the pump reaches the select.
            requestsAtDecide = ofType(sessionEvents(opened), "approval.request").length;
            decided = decide(opened, "r1", "allow");
            decided.catch(() => undefined);
          }
          if (event.type === "step.start" && atSecondStart === undefined && decided !== undefined) {
            atSecondStart = pairingRows(opened.fixture.db, event.data.messageId).map(
              (row) => row.step_id,
            );
          }
        },
      });
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");
      await expect(decided).resolves.toMatchObject({ decision: "allow" });
      expect(requestsAtDecide).toBe(0);

      const messageId = assistantIdFor(world.fixture, world.session);
      const [first, second] = stepIds(world.fixture.db, messageId);
      expect(first).toBeDefined();
      // Not paired at the select (step c1 was running): only the later bash start took it.
      expect(atSecondStart).toEqual([second]);
      expect(pairingRows(world.fixture.db, messageId)).toEqual([
        { request_id: "r1", decision: "allow", decided_at: T, step_id: second },
      ]);
      expect(ofType(sessionEvents(world), "approval.request")).toHaveLength(1);
      expect(answers).toEqual([{ type: "extension_ui_response", id: "r1", value: "Approve" }]);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("tool-approval「确认与步骤配对」: stops and failed pairing writes", () => {
  it(
    "没有步骤的审批保持未配对: a stop before the tool start denies an unpaired row",
    REAL,
    async () => {
      const { world } = await openScripted({
        prompt: (child) => child.emitRaw(chunk(select("r1"))),
      });
      await prompted(world);
      await waitForEvent(world, "approval.request");
      await ownerStop(world);
      await waitForEvent(world, "turn.end");

      const messageId = assistantIdFor(world.fixture, world.session);
      expect(stepRows(world.fixture.db, messageId)).toEqual([]);
      expect(pairingRows(world.fixture.db, messageId)).toEqual([
        { request_id: "r1", decision: "deny", decided_at: T, step_id: null },
      ]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "没有步骤的审批保持未配对: a stop after pairing denies the row, which keeps its step",
    REAL,
    async () => {
      const { world } = await openScripted({
        prompt: (child) => child.emitRaw(chunk(select("r1"), start("c1"))),
      });
      await prompted(world);
      await waitForEvent(world, "step.start");
      await ownerStop(world);
      await waitForEvent(world, "turn.end");

      const messageId = assistantIdFor(world.fixture, world.session);
      const steps = stepRows(world.fixture.db, messageId);
      expect(steps.map((row) => row.status)).toEqual(["stopped"]);
      expect(pairingRows(world.fixture.db, messageId)).toEqual([
        { request_id: "r1", decision: "deny", decided_at: T, step_id: steps[0]?.id },
      ]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "配对写失败: a failed step-start pairing rolls the step insert back; no step.start",
    REAL,
    async () => {
      const { world } = await openScripted({
        prompt: (child) => child.emitRaw(chunk(select("r1"), start("c1"))),
        faulted: true,
      });
      world.fixture.db.exec(REJECT_PAIRING);
      await prompted(world);
      await waitFor(
        () => (world.errors.some((error) => containsMessage(error, SENTINEL)) ? true : undefined),
        "the retained pairing fault",
      );
      await settle();

      const messageId = assistantIdFor(world.fixture, world.session);
      expect(stepRows(world.fixture.db, messageId)).toEqual([]);
      // The infra-fault retire settles the still-pending approval `deny` on the injected clock.
      expect(pairingRows(world.fixture.db, messageId)).toEqual([
        { request_id: "r1", decision: "deny", decided_at: T, step_id: null },
      ]);
      const types = sessionEvents(world).map((entry) => entry.event.type);
      expect(types).toContain("approval.request");
      expect(types).not.toContain("step.start");
    },
  );

  it("配对写失败: a failed select-time pairing publishes no approval.request", REAL, async () => {
    const { world } = await openScripted({
      prompt: (child) => child.emitRaw(chunk(start("c1"), select("r1"))),
      faulted: true,
    });
    world.fixture.db.exec(REJECT_PAIRING);
    await prompted(world);
    await waitFor(
      () => (world.errors.some((error) => containsMessage(error, SENTINEL)) ? true : undefined),
      "the retained pairing fault",
    );
    await settle();

    const messageId = assistantIdFor(world.fixture, world.session);
    expect(stepRows(world.fixture.db, messageId).map((row) => row.name)).toEqual(["bash"]);
    expect(pairingRows(world.fixture.db, messageId)).toEqual([
      { request_id: "r1", decision: "deny", decided_at: T, step_id: null },
    ]);
    const types = sessionEvents(world).map((entry) => entry.event.type);
    expect(types).toContain("step.start");
    expect(types).not.toContain("approval.request");
  });
});

describe("turn-control「拷贝审批记录」: fork remaps step_id by the step's ordinal", () => {
  it("deny on ordinal 1 → the copy's ordinal-1 step; timeout unpaired → null; source unchanged", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const source = store.create(OWNER_ID).id;
        const a1 = store.acceptPrompt(source, OWNER_ID, "a1").assistantMessageId;
        for (const ordinal of [0, 1]) {
          store.startStep(a1, { ordinal, name: "bash", detail: "{}" });
        }
        expect(store.finishTurn(a1, "done")).toBe(true);
        const [, onOrdinal1] = stepIds(db, a1);
        const insert = db.prepare(
          "INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at, decision, decided_at, step_id) VALUES (?, ?, 'bash', ?, ?, ?, ?, ?, ?)",
        );
        insert.run(
          a1,
          "r1",
          "Allow tool: bash\nCommand: a",
          10,
          60_010,
          "deny",
          20,
          Number(onOrdinal1),
        );
        insert.run(a1, "r2", "Allow tool: bash\nCommand: b", 30, 60_030, "timeout", 60_030, null);
        const tail = store.acceptPrompt(source, OWNER_ID, "fork here");
        expect(store.finishTurn(tail.assistantMessageId, "done")).toBe(true);
        const sourceRows = db.prepare("SELECT * FROM chat_approvals ORDER BY id").all();

        const forked = "f".repeat(32);
        store.commitFork({
          sourceId: source,
          sessionId: forked,
          ownerId: OWNER_ID,
          messageId: tail.userMessageId,
          expectedAssistantId: tail.assistantMessageId,
          sessionFile: "/fork.jsonl",
        });
        const copy = store
          .getMessages(forked, OWNER_ID)
          ?.messages.find((message) => message.role === "assistant");
        const copyId = Number(copy?.id);
        const copiedSteps = stepIds(db, copyId);
        const copied = db
          .prepare(
            "SELECT request_id, tool, title, requested_at, expires_at, decision, decided_at, step_id FROM chat_approvals WHERE message_id = ? ORDER BY id",
          )
          .all(copyId);
        expect(copied).toEqual([
          {
            request_id: "r1",
            tool: "bash",
            title: "Allow tool: bash\nCommand: a",
            requested_at: 10,
            expires_at: 60_010,
            decision: "deny",
            decided_at: 20,
            step_id: copiedSteps[1],
          },
          {
            request_id: "r2",
            tool: "bash",
            title: "Allow tool: bash\nCommand: b",
            requested_at: 30,
            expires_at: 60_030,
            decision: "timeout",
            decided_at: 60_030,
            step_id: null,
          },
        ]);
        expect(stepIds(db, a1)).not.toContain(copiedSteps[1]);
        expect(
          db
            .prepare("SELECT * FROM chat_approvals WHERE message_id IN (?, ?) ORDER BY id")
            .all(a1, tail.assistantMessageId),
        ).toEqual(sourceRows);
      });
    });
  });
});
