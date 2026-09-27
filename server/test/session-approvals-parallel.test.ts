/**
 * Issue #464 parallel approvals, per-approval timers and ring order (R11–R13, R19). Real fake-omp
 * `approval`/`approval-parallel` children; a test-side stdout gate holds `r2`'s select (R12) or
 * merges `tool_execution_start` with its select into one stdout write (R13, R19) so the frame-order
 * race is reproduced deterministically. SSE is the real endpoint; ids are `<epoch>:<seq>`.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import {
  type ApprovalRow,
  type ApprovalWorld,
  approvalRow,
  approvalRows,
  assistantSteps,
  DENIED_OUTPUT,
  isSelect,
  isToolStart,
  ofType,
  openApprovalWorld,
  parseSse,
  prompted,
  REAL,
  responses,
  type SseFrame,
  seqOf,
  sessionEvents,
  settle,
  spawnedAt,
  T,
  TITLE,
  TITLE_2,
  TTL_MS,
  waitForEvent,
  waitForResponses,
  waitForRows,
} from "./session-approval-helpers.js";
import { type OpenStream, openEventStream, readUntil } from "./session-sse-helpers.js";
import { waitFor, waitForTurn } from "./session-supervisor-helpers.js";

const worlds: ApprovalWorld[] = [];
const streams: OpenStream[] = [];

afterEach(async () => {
  for (const stream of streams.splice(0)) {
    stream.abort();
  }
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

async function open(
  scenario: "approval" | "approval-parallel",
  options: Parameters<typeof openApprovalWorld>[1] = {},
): Promise<ApprovalWorld> {
  const world = await openApprovalWorld(scenario, options);
  worlds.push(world);
  return world;
}

async function openSse(world: ApprovalWorld, lastEventId?: string): Promise<OpenStream> {
  const stream = await openEventStream(world.fixture, world.session, world.cookie, lastEventId);
  streams.push(stream);
  return stream;
}

async function throughTurnEnd(stream: OpenStream): Promise<SseFrame[]> {
  const text = await readUntil(stream, (bytes) =>
    parseSse(bytes).some((frame) => frame.event === "turn.end"),
  );
  return parseSse(text);
}

async function sse(world: ApprovalWorld, lastEventId: string | undefined): Promise<SseFrame[]> {
  return throughTurnEnd(await openSse(world, lastEventId));
}

function pair(rows: ApprovalRow[]): [ApprovalRow, ApprovalRow] {
  const [first, second] = rows;
  if (first === undefined || second === undefined) {
    throw new Error("expected two approval rows");
  }
  return [first, second];
}

/** Waits until the gate holds the merged `tool_execution_start` + select, then writes both at once. */
async function releaseMerged(world: ApprovalWorld): Promise<void> {
  const spawned = await waitFor(() => world.spawned[0], "gated child");
  await waitFor(
    () => (spawned.gate.held().includes('"type":"extension_ui_request"') ? true : undefined),
    "held tool start and select",
  );
  expect(isToolStart(spawned.gate.held())).toBe(true);
  spawned.gate.release();
}

describe("parallel approvals", () => {
  it(
    "R11 two pending approvals are answered separately and coexist in the ring",
    REAL,
    async () => {
      const world = await open("approval-parallel");
      await prompted(world);
      const [r1, r2] = pair(await waitForRows(world, 2));
      expect(r1).toMatchObject({
        request_id: "r1",
        title: TITLE,
        requested_at: T,
        expires_at: T + TTL_MS,
        decision: null,
        decided_at: null,
      });
      expect(r2).toMatchObject({ request_id: "r2", title: TITLE_2, message_id: r1.message_id });
      expect(r2.id).toBeGreaterThan(r1.id);
      await waitForEvent(world, "approval.request", 2);
      const stream = await openSse(world);

      await world.fixture.supervisor.decide(world.session, r2.id, "deny");
      await world.fixture.supervisor.decide(world.session, r1.id, "allow");
      await waitForTurn(world.fixture, world.session, "done");

      expect(responses(spawnedAt(world, 0))).toEqual([
        { type: "extension_ui_response", id: "r2", value: "Deny" },
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
      const steps = assistantSteps(world).steps;
      expect(steps.map((step) => step.status)).toEqual(["done", "failed"]);
      expect(steps[1]?.output).toBe(DENIED_OUTPUT);

      const frames = await throughTurnEnd(stream);
      const approvals = frames.filter((frame) => frame.event.startsWith("approval."));
      expect(approvals.map((frame) => [frame.event, frame.data.approvalId])).toEqual([
        ["approval.request", r1.id],
        ["approval.request", r2.id],
        ["approval.resolved", r2.id],
        ["approval.resolved", r1.id],
      ]);
      expect(approvals.map((frame) => frame.data.decision)).toEqual([
        undefined,
        undefined,
        "deny",
        "allow",
      ]);
      const turnEnds = frames.filter((frame) => frame.event === "turn.end");
      expect(turnEnds).toHaveLength(1);
      expect(frames[frames.length - 1]).toBe(turnEnds[0]);
    },
  );

  it("R12 each approval runs its own timer from its own requested_at", REAL, async () => {
    const world = await open("approval-parallel", { hold: isSelect("r2") });
    await prompted(world);
    const [r1] = await waitForRows(world, 1);
    const gate = spawnedAt(world, 0).gate;
    await waitFor(() => (isSelect("r2")(gate.held()) ? true : undefined), "held r2 select");
    expect(approvalRows(world.fixture.db)).toEqual([r1]);

    world.clock.nowMs = T + 5_000;
    gate.release();
    const [first, r2] = pair(await waitForRows(world, 2));
    expect(first).toEqual(r1);
    expect(r2).toMatchObject({
      request_id: "r2",
      requested_at: T + 5_000,
      expires_at: T + 65_000,
      decision: null,
    });
    await waitForEvent(world, "approval.request", 2);

    world.clock.advance(T + TTL_MS - world.clock.nowMs);
    expect(approvalRow(world.fixture.db, r2.id).decision).toBeNull();
    expect(approvalRow(world.fixture.db, first.id)).toMatchObject({
      decision: "timeout",
      decided_at: T + TTL_MS,
    });
    await waitForResponses(spawnedAt(world, 0), 1);
    await settle();
    expect(responses(spawnedAt(world, 0))).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Approve" },
    ]);

    world.clock.advance(5_000);
    expect(approvalRow(world.fixture.db, r2.id)).toMatchObject({
      decision: "timeout",
      decided_at: T + 65_000,
    });
    expect(await waitForResponses(spawnedAt(world, 0), 2)).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Approve" },
      { type: "extension_ui_response", id: "r2", value: "Approve" },
    ]);
    await waitForTurn(world.fixture, world.session, "done");
    expect(
      ofType(sessionEvents(world), "approval.resolved").map((event) => [
        event.data.approvalId,
        event.data.decision,
      ]),
    ).toEqual([
      [first.id, "timeout"],
      [r2.id, "timeout"],
    ]);
  });
});

describe("approval ring order", () => {
  it(
    "R13 request follows step.start, resolved is adjacent, and Last-Event-ID replays",
    REAL,
    async () => {
      const world = await open("approval", { hold: isToolStart });
      await prompted(world);
      await releaseMerged(world);
      const [row] = await waitForRows(world, 1);
      await waitForEvent(world, "approval.request");
      if (row === undefined) {
        throw new Error("missing approval row");
      }

      const stream = await openSse(world);
      await world.fixture.supervisor.decide(world.session, row.id, "allow");
      const frames = await throughTurnEnd(stream);

      expect(frames[0]?.event).toBe("turn.start");
      const stepStart = frames.findIndex(
        (frame) => frame.event === "step.start" && frame.data.name === "bash",
      );
      const request = frames.findIndex((frame) => frame.event === "approval.request");
      const resolved = frames.findIndex((frame) => frame.event === "approval.resolved");
      const stepEnd = frames.findIndex(
        (frame) =>
          frame.event === "step.end" && frame.data.stepId === frames[stepStart]?.data.stepId,
      );
      expect(stepStart).toBeGreaterThan(0);
      expect(request).toBeGreaterThan(stepStart);
      expect(resolved).toBeGreaterThan(request);
      expect(stepEnd).toBeGreaterThan(resolved);
      expect(frames[stepEnd]?.data.status).toBe("done");
      expect(frames.filter((frame) => frame.event.startsWith("approval."))).toHaveLength(2);
      expect(frames.filter((frame) => frame.event === "turn.end")).toEqual([
        frames[frames.length - 1],
      ]);
      expect(frames[frames.length - 1]?.data.status).toBe("done");
      expect(frames[request]?.data).toEqual({
        messageId: row.message_id,
        approvalId: row.id,
        tool: "bash",
        title: TITLE,
        expiresAt: T + TTL_MS,
      });
      expect(frames[resolved]?.data).toEqual({
        messageId: row.message_id,
        approvalId: row.id,
        decision: "allow",
      });
      const seqs = frames.map((frame) => seqOf(frame));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(new Set(frames.map((frame) => frame.id.split(":")[0])).size).toBe(1);
      expect(seqOf(frames[request]) + 1).toBe(seqOf(frames[resolved]));

      const afterRequest = await sse(world, frames[request]?.id);
      expect(afterRequest[0]?.event).toBe("approval.resolved");
      expect(afterRequest.map((frame) => frame.id)).toEqual(
        frames.slice(request + 1).map((frame) => frame.id),
      );
      const beforeRequest = await sse(world, frames[request - 1]?.id);
      expect(beforeRequest.map((frame) => [frame.id, frame.event])).toEqual(
        frames.slice(request).map((frame) => [frame.id, frame.event]),
      );
      expect(beforeRequest.slice(0, 2).map((frame) => frame.event)).toEqual([
        "approval.request",
        "approval.resolved",
      ]);
    },
  );

  it(
    "R19 a settlement before the pump reaches the select backfills exactly one request",
    REAL,
    async () => {
      let world: ApprovalWorld | undefined;
      let decided: Promise<unknown> | undefined;
      const onEvent = (sessionId: string, _epoch: number, event: ChatEvent<number>): void => {
        if (world === undefined || decided !== undefined) {
          return;
        }
        if (event.type === "step.start" && event.data.name === "bash") {
          const [row] = approvalRows(world.fixture.db, sessionId);
          decided = world.fixture.supervisor.decide(sessionId, row?.id ?? -1, "allow");
          decided.catch(() => undefined);
        }
      };
      world = await open("approval", { hold: isToolStart, onEvent });
      await prompted(world);
      await releaseMerged(world);
      await waitForTurn(world.fixture, world.session, "done");
      await expect(decided).resolves.toMatchObject({ decision: "allow" });

      const order = sessionEvents(world)
        .map((entry) => entry.event)
        .filter(
          (event) =>
            event.type.startsWith("approval.") ||
            (event.type === "step.start" && event.data.name === "bash"),
        )
        .map((event) => event.type);
      expect(order).toEqual(["step.start", "approval.request", "approval.resolved"]);
      expect(responses(spawnedAt(world, 0))).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "R19 a settlement inside the pump's own request publication never republishes the request",
    REAL,
    async () => {
      let world: ApprovalWorld | undefined;
      let decided: Promise<unknown> | undefined;
      const onEvent = (sessionId: string, _epoch: number, event: ChatEvent<number>): void => {
        if (world !== undefined && decided === undefined && event.type === "approval.request") {
          decided = world.fixture.supervisor.decide(sessionId, event.data.approvalId, "allow");
          decided.catch(() => undefined);
        }
      };
      world = await open("approval", { onEvent });
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");
      await expect(decided).resolves.toMatchObject({ decision: "allow" });

      const approvals = ofType(sessionEvents(world), "approval.request").length;
      expect(approvals).toBe(1);
      expect(
        sessionEvents(world)
          .map((entry) => entry.event.type)
          .filter((type) => type.startsWith("approval.")),
      ).toEqual(["approval.request", "approval.resolved"]);
      expect(responses(spawnedAt(world, 0))).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
      expect(world.errors).toEqual([]);
    },
  );
});
