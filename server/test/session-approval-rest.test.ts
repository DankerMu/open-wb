/**
 * Issue #468 approval answer REST (parent s1c tasks 5.2a), E1–E16 incl. E10b. The production
 * createApp → registerSessions assembly over real fake-omp `approval` children, real SQLite and
 * the injected clock; inject for status/body cases, `withListeningApp` + fetch for the real-socket
 * parser-owner boundary. Expected envelopes and rows are fixture literals from the tool-approval
 * and http-service-skeleton specs; `decide` is observed with a call-through spy, never replaced.
 */
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { PARSER_INPUTS } from "./http-guard-helpers.js";
import { withListeningApp } from "./raw-http-helpers.js";
import {
  type ApprovalRow,
  type ApprovalWorld,
  approvalAuditCount,
  approvalRow,
  assistantSteps,
  DENIED_OUTPUT,
  expectQuiet,
  extraSession,
  ofType,
  openApprovalWorld,
  pendingApproval,
  prompted,
  REAL,
  rejection,
  responses,
  sessionEvents,
  settle,
  spawnedAt,
  T,
  TITLE,
  TTL_MS,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  INTERNAL_ERROR_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  OVERSIZED_PARSER_INPUT,
  UNKNOWN_SESSION_ID,
} from "./session-rest-helpers.js";
import { waitForTurn } from "./session-supervisor-helpers.js";

const ROUTE = "/api/sessions/:id/approvals/:approvalId";
const ALLOW = JSON.stringify({ decision: "allow" });
const DENY = JSON.stringify({ decision: "deny" });
const MALFORMED = "{";
const SETTLED_ENVELOPE = {
  error: { code: "approval_settled", message: "该审批已处理" },
} as const;

type DecideSpy = MockInstance<ApprovalWorld["fixture"]["supervisor"]["decide"]>;

interface AnswerOptions {
  /** `null` sends no cookie header; default is the world owner's cookie. */
  cookie?: string | null;
  contentType?: string;
}

const worlds: ApprovalWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

async function open(scenario: "approval" | "approval-parallel" = "approval") {
  const world = await openApprovalWorld(scenario);
  worlds.push(world);
  return world;
}

function answer(
  world: ApprovalWorld,
  session: string,
  approvalId: number | string,
  payload: string,
  options: AnswerOptions = {},
): Promise<LightMyRequestResponse> {
  const cookie = options.cookie === undefined ? world.cookie : options.cookie;
  return world.fixture.app.inject({
    method: "POST",
    url: `/api/sessions/${session}/approvals/${String(approvalId)}`,
    headers: {
      "content-type": options.contentType ?? "application/json",
      ...(cookie === null ? {} : { cookie }),
    },
    payload,
  });
}

function expectEnvelope(response: LightMyRequestResponse, status: number, envelope: object): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toStrictEqual(envelope);
}

/** The wire identity two error responses must share byte for byte. */
function wire(response: LightMyRequestResponse) {
  return {
    status: response.statusCode,
    payload: response.payload,
    cacheControl: response.headers["cache-control"],
    contentType: response.headers["content-type"],
  };
}

function spyDecide(world: ApprovalWorld): DecideSpy {
  return vi.spyOn(world.fixture.supervisor, "decide");
}

/** "No side effects": no decide call, every row still pending, no frame, audit or resolved. */
function expectUntouched(world: ApprovalWorld, spy: DecideSpy, rows: ApprovalRow[]): void {
  expect(spy).not.toHaveBeenCalled();
  for (const row of rows) {
    expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
      decision: null,
      decided_at: null,
    });
  }
  expectQuiet(world);
}

function resolvedFor(world: ApprovalWorld, session = world.session) {
  return ofType(sessionEvents(world, session), "approval.resolved").map((event) => event.data);
}

function publicApproval(row: ApprovalRow, decision: "allow" | "deny") {
  return {
    id: row.id,
    tool: "bash",
    title: TITLE,
    requestedAt: T,
    expiresAt: T + TTL_MS,
    decision,
  };
}

function approvalPath(origin: string, session: string, approvalId: number): string {
  return `${origin}/api/sessions/${session}/approvals/${String(approvalId)}`;
}

function postWire(
  url: string,
  cookie: string | null,
  input: { payload: string; contentType: string },
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": input.contentType, ...(cookie === null ? {} : { cookie }) },
    body: input.payload,
  });
}

async function expectWireEnvelope(response: Response, status: number, envelope: object) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.json()).toStrictEqual(envelope);
}

describe("approval answers over REST", () => {
  it(
    "E1 allow returns the six-key approval and settles, answers and publishes once",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);
      world.clock.nowMs = T + 1_000;

      const response = await answer(world, world.session, row.id, ALLOW);

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toStrictEqual(publicApproval(row, "allow"));
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: "allow",
        decided_at: T + 1_000,
      });
      expect(approvalAuditCount(world.fixture.db)).toBe(1);
      expect(responses(spawnedAt(world, 0))).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
      expect(resolvedFor(world)).toEqual([
        { messageId: row.message_id, approvalId: row.id, decision: "allow" },
      ]);
      await waitForTurn(world.fixture, world.session, "done");
      const tree = assistantSteps(world);
      expect(tree.steps.map((step) => [step.name, step.status])).toEqual([["bash", "done"]]);
      expect(tree.assistant.status).toBe("done");
      expect(world.errors).toEqual([]);
    },
  );

  it("E2 deny answers Deny; the bash step fails and the turn ends done", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);
    world.clock.nowMs = T + 1_000;

    const response = await answer(world, world.session, row.id, DENY);

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toStrictEqual(publicApproval(row, "deny"));
    expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
      decision: "deny",
      decided_at: T + 1_000,
    });
    expect(responses(spawnedAt(world, 0))).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Deny" },
    ]);
    await waitForTurn(world.fixture, world.session, "done");
    const tree = assistantSteps(world);
    expect(tree.steps.map((step) => [step.name, step.status, step.output])).toEqual([
      ["bash", "failed", DENIED_OUTPUT],
    ]);
    expect(tree.assistant.status).toBe("done");
    expect(tree.session.status).toBe("done");
  });

  it("E3 re-answering an allowed or denied approval is 409 approval_settled", REAL, async () => {
    const world = await open();
    const second = await extraSession(world);
    const allowed = await pendingApproval(world);
    const denied = await pendingApproval(world, second);
    world.clock.nowMs = T + 1_000;

    expect((await answer(world, world.session, allowed.id, ALLOW)).statusCode).toBe(200);
    expectEnvelope(await answer(world, world.session, allowed.id, DENY), 409, SETTLED_ENVELOPE);
    expect((await answer(world, second, denied.id, DENY)).statusCode).toBe(200);
    expectEnvelope(await answer(world, second, denied.id, ALLOW), 409, SETTLED_ENVELOPE);

    expect(approvalRow(world.fixture.db, allowed.id)).toMatchObject({ decision: "allow" });
    expect(approvalRow(world.fixture.db, denied.id)).toMatchObject({ decision: "deny" });
    expect(responses(spawnedAt(world, 0))).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Approve" },
    ]);
    expect(responses(spawnedAt(world, 1))).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Deny" },
    ]);
    expect(approvalAuditCount(world.fixture.db)).toBe(2);
    expect(resolvedFor(world)).toHaveLength(1);
    expect(resolvedFor(world, second)).toHaveLength(1);
  });

  it("E4 answering after the 60s timeout settled the row is 409", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);
    world.clock.advance(TTL_MS);
    await waitForTurn(world.fixture, world.session, "done");

    expectEnvelope(await answer(world, world.session, row.id, ALLOW), 409, SETTLED_ENVELOPE);

    expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
      decision: "timeout",
      decided_at: T + TTL_MS,
    });
    expect(responses(spawnedAt(world, 0))).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Approve" },
    ]);
    expect(approvalAuditCount(world.fixture.db)).toBe(1);
  });

  it("E5 two concurrent answers yield exactly one 200 and one 409", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);

    const both = await Promise.all([
      answer(world, world.session, row.id, ALLOW),
      answer(world, world.session, row.id, DENY),
    ]);

    expect(both.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = both.find((response) => response.statusCode === 200);
    const loser = both.find((response) => response.statusCode === 409);
    if (winner === undefined || loser === undefined) {
      throw new Error("expected one 200 and one 409");
    }
    expectEnvelope(loser, 409, SETTLED_ENVELOPE);
    const decision = (winner.json() as { decision: string }).decision;
    expect(approvalRow(world.fixture.db, row.id).decision).toBe(decision);
    expect(responses(spawnedAt(world, 0))).toHaveLength(1);
    expect(approvalAuditCount(world.fixture.db)).toBe(1);
    expect(resolvedFor(world)).toHaveLength(1);
  });

  it("E12 two parallel approvals are answered independently, in request order", REAL, async () => {
    const world = await open("approval-parallel");
    await prompted(world);
    const [r1, r2] = await waitForRows(world, 2);
    if (r1 === undefined || r2 === undefined) {
      throw new Error("expected two pending approvals");
    }
    expect([r1.request_id, r2.request_id]).toEqual(["r1", "r2"]);
    await waitForEvent(world, "approval.request", 2);

    const first = await answer(world, world.session, r2.id, ALLOW);
    expect(first.statusCode).toBe(200);
    expect(approvalRow(world.fixture.db, r2.id).decision).toBe("allow");
    expect(approvalRow(world.fixture.db, r1.id).decision).toBeNull();
    const second = await answer(world, world.session, r1.id, DENY);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: r1.id, decision: "deny" });

    await waitForTurn(world.fixture, world.session, "done");
    expect(responses(spawnedAt(world, 0))).toEqual([
      { type: "extension_ui_response", id: "r2", value: "Approve" },
      { type: "extension_ui_response", id: "r1", value: "Deny" },
    ]);
  });
});

describe("approval answer input validation", () => {
  it(
    "E6 every body other than exactly {decision: allow|deny} is 400 with no side effect",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);
      const spy = spyDecide(world);
      const bodies = [
        '{"decision":"maybe"}',
        "{}",
        '{"decision":"allow","x":1}',
        '{"decision":"timeout"}',
        '{"decision":"ALLOW"}',
        '{"decision":null}',
        '{"Decision":"allow"}',
        "null",
        "[]",
        '"allow"',
        MALFORMED,
      ];

      for (const body of bodies) {
        expectEnvelope(await answer(world, world.session, row.id, body), 400, BAD_REQUEST_ENVELOPE);
      }

      await settle();
      expectUntouched(world, spy, [row]);
      expect((await answer(world, world.session, row.id, ALLOW)).statusCode).toBe(200);
    },
  );

  it("E7 form and text media types are 400 with no side effect", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);
    const spy = spyDecide(world);

    for (const contentType of ["application/x-www-form-urlencoded", "text/plain"]) {
      const response = await answer(world, world.session, row.id, "decision=allow", {
        contentType,
      });
      expectEnvelope(response, 400, BAD_REQUEST_ENVELOPE);
    }

    await settle();
    expectUntouched(world, spy, [row]);
  });

  it(
    "E11 a non-canonical approvalId is the unknown-session 404 before the parser",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);
      const spy = spyDecide(world);
      const reference = wire(await answer(world, UNKNOWN_SESSION_ID, row.id, ALLOW));
      const ids = [
        "01",
        `0${String(row.id)}`,
        "abc",
        "0",
        "-1",
        "+1",
        "1e3",
        "1.0",
        `${String(row.id)}x`,
        "9007199254740993",
      ];

      for (const id of ids) {
        for (const body of [ALLOW, MALFORMED]) {
          const response = await answer(world, world.session, id, body);
          expect({ id, body, ...wire(response) }).toStrictEqual({ id, body, ...reference });
        }
      }

      expect(reference.status).toBe(404);
      expect(JSON.parse(reference.payload)).toStrictEqual(NOT_FOUND_ENVELOPE);
      expect(reference.cacheControl).toBe("no-store");
      await settle();
      expectUntouched(world, spy, [row]);
      expect((await answer(world, world.session, `${String(row.id)}`, ALLOW)).statusCode).toBe(200);
    },
  );
});

describe("approval answer ownership", () => {
  it(
    "E8 without a cookie every body is 401 with no set-cookie and no side effect",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);
      const spy = spyDecide(world);
      const inputs = [
        { payload: ALLOW, contentType: "application/json" },
        { payload: MALFORMED, contentType: "application/json" },
        OVERSIZED_PARSER_INPUT,
      ];

      for (const input of inputs) {
        const response = await answer(world, world.session, row.id, input.payload, {
          cookie: null,
          contentType: input.contentType,
        });
        expectEnvelope(response, 401, UNAUTHORIZED_ENVELOPE);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }

      await settle();
      expectUntouched(world, spy, [row]);
    },
  );

  it(
    "E9 a foreign or unknown session is one 404 for every body, before the parser",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);
      const foreign = await cookieFor(world.fixture.app, "zhaoliu");
      const spy = spyDecide(world);
      const targets = [
        { session: world.session, cookie: foreign },
        { session: UNKNOWN_SESSION_ID, cookie: world.cookie },
      ];
      const inputs = [
        { payload: ALLOW, contentType: "application/json" },
        { payload: MALFORMED, contentType: "application/json" },
        OVERSIZED_PARSER_INPUT,
      ];

      for (const target of targets) {
        for (const input of inputs) {
          const response = await answer(world, target.session, row.id, input.payload, {
            cookie: target.cookie,
            contentType: input.contentType,
          });
          expectEnvelope(response, 404, NOT_FOUND_ENVELOPE);
        }
      }

      await settle();
      expectUntouched(world, spy, [row]);
    },
  );

  it(
    "E10 unknown and other-session approvalIds are the unknown-session 404 via decide",
    REAL,
    async () => {
      const world = await open();
      const other = await extraSession(world);
      const row = await pendingApproval(world);
      const foreignRow = await pendingApproval(world, other);
      const reference = wire(await answer(world, UNKNOWN_SESSION_ID, row.id, ALLOW));
      const spy = spyDecide(world);

      const unknown = await answer(world, world.session, row.id + 1_000, ALLOW);
      const crossed = await answer(world, world.session, foreignRow.id, ALLOW);

      expect(reference.status).toBe(404);
      expect(JSON.parse(reference.payload)).toStrictEqual(NOT_FOUND_ENVELOPE);
      expect(wire(unknown)).toStrictEqual(reference);
      expect(wire(crossed)).toStrictEqual(reference);
      expect(spy).toHaveBeenCalledTimes(2);
      for (const result of spy.mock.results) {
        expect(await rejection(result.value as Promise<unknown>)).toMatchObject({
          code: "not_found",
        });
      }
      await settle();
      for (const pending of [row, foreignRow]) {
        expect(approvalRow(world.fixture.db, pending.id)).toMatchObject({ decision: null });
      }
      expectQuiet(world);
    },
  );

  it("E10b malformed bodies are one 400 whether or not the approvalId exists", REAL, async () => {
    const world = await open();
    const other = await extraSession(world);
    const row = await pendingApproval(world);
    const foreignRow = await pendingApproval(world, other);
    const spy = spyDecide(world);
    const seen: Array<ReturnType<typeof wire>> = [];

    for (const id of [row.id, row.id + 1_000, foreignRow.id]) {
      for (const body of [MALFORMED, '{"decision":"maybe"}']) {
        seen.push(wire(await answer(world, world.session, id, body)));
      }
    }

    expect(seen).toHaveLength(6);
    const [first] = seen;
    expect(first?.status).toBe(400);
    expect(JSON.parse(first?.payload ?? "")).toStrictEqual(BAD_REQUEST_ENVELOPE);
    expect(first?.cacheControl).toBe("no-store");
    for (const entry of seen) {
      expect(entry).toStrictEqual(first);
    }
    await settle();
    expectUntouched(world, spy, [row, foreignRow]);
  });
});

describe("approval answer failures", () => {
  it(
    "E13 a failed settlement transaction is a generic 500 and stays answerable",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);
      world.fixture.db.exec(`CREATE TRIGGER block_approval_audit BEFORE INSERT ON audit_events
      WHEN NEW.kind = 'session.approval' BEGIN SELECT RAISE(ABORT, 'approval audit blocked'); END`);

      expectEnvelope(
        await answer(world, world.session, row.id, ALLOW),
        500,
        INTERNAL_ERROR_ENVELOPE,
      );

      await settle();
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: null,
        decided_at: null,
      });
      expectQuiet(world);

      world.fixture.db.exec("DROP TRIGGER block_approval_audit");
      const retried = await answer(world, world.session, row.id, ALLOW);
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toMatchObject({ id: row.id, decision: "allow" });
      await waitForTurn(world.fixture, world.session, "done");
      expect(responses(spawnedAt(world, 0))).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "E14 answering after supervisor shutdown is 502 agent_unavailable and writes nothing",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);
      await world.fixture.supervisor.shutdown();
      const rowBefore = approvalRow(world.fixture.db, row.id);
      const auditBefore = approvalAuditCount(world.fixture.db);
      const framesBefore = responses(spawnedAt(world, 0));

      const response = await answer(world, world.session, row.id, ALLOW);

      expectEnvelope(response, 502, AGENT_UNAVAILABLE_ENVELOPE);
      await settle();
      expect(approvalRow(world.fixture.db, row.id)).toStrictEqual(rowBefore);
      expect(approvalAuditCount(world.fixture.db)).toBe(auditBefore);
      expect(responses(spawnedAt(world, 0))).toEqual(framesBefore);
    },
  );
});

describe("approval answer over a real socket", () => {
  it("E15 the four parser inputs are an owned 400 before decide", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);
    const spy = spyDecide(world);

    await withListeningApp(world.fixture.app, async (origin) => {
      const url = approvalPath(origin, world.session, row.id);
      for (const input of PARSER_INPUTS) {
        await expectWireEnvelope(
          await postWire(url, world.cookie, input),
          400,
          BAD_REQUEST_ENVELOPE,
        );
      }
      await settle();
      expectUntouched(world, spy, [row]);
      expect(world.fixture.app.hasRoute({ method: "POST", url: ROUTE })).toBe(true);
    });
  });

  it("E16 401 and session 404 come before the parser on the wire", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);
    const foreign = await cookieFor(world.fixture.app, "zhaoliu");
    const spy = spyDecide(world);
    const bodied = PARSER_INPUTS.filter((input) => input !== OVERSIZED_PARSER_INPUT);
    expect(bodied).toHaveLength(3);

    await withListeningApp(world.fixture.app, async (origin) => {
      const cases = [
        { session: world.session, cookie: null, status: 401, envelope: UNAUTHORIZED_ENVELOPE },
        { session: world.session, cookie: foreign, status: 404, envelope: NOT_FOUND_ENVELOPE },
        {
          session: UNKNOWN_SESSION_ID,
          cookie: world.cookie,
          status: 404,
          envelope: NOT_FOUND_ENVELOPE,
        },
      ];
      for (const entry of cases) {
        for (const input of bodied) {
          const response = await postWire(
            approvalPath(origin, entry.session, row.id),
            entry.cookie,
            input,
          );
          await expectWireEnvelope(response, entry.status, entry.envelope);
        }
      }
      await settle();
      expectUntouched(world, spy, [row]);
    });
  });
});
