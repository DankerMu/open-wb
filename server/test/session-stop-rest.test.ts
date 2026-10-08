/**
 * Issue #475 stop REST route (parent s1c tasks 5.1a), design A1–A6, R1–R4, W1–W2. The status and
 * fault matrix runs on the stub supervisor (`withSessionRest`, stop observed/controlled with a
 * spy); the turn-control scenarios run on the production createApp → registerSessions assembly over
 * real fake-omp children, real SQLite and the injected clock, with a call-through stop spy; the
 * bodyless parser-owner boundary is proved over a real socket (`withListeningApp` + fetch) with
 * tiny bodies only. Envelopes and shapes are fixture literals from the three spec deltas.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { describe, expect, it, type MockInstance, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import type { SessionSupervisorPort } from "../src/sessions/rest.js";
import type { FinishStatus, SessionStore } from "../src/sessions/store.js";
import { expectServerError } from "./auth-lifecycle-helpers.js";
import { withListeningApp } from "./raw-http-helpers.js";
import {
  type ApprovalWorld,
  extraSession,
  ofType,
  prompted,
  REAL,
  sessionEvents,
  settle,
  spawnedAt,
  waitForEvent,
} from "./session-approval-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  deferred,
  OVERSIZED_PARSER_INPUT,
  postPrompt,
  type SessionRestFixture,
  UNKNOWN_SESSION_ID,
  withSessionRest,
} from "./session-rest-helpers.js";
import {
  abortCount,
  afterPrompt,
  expectNoError,
  GRACE_MS,
  heldTurn,
  history,
  listedStatus,
  probeFrames,
  turnEnds,
} from "./session-stop-helpers.js";
import {
  delayReady,
  ended,
  frameTypes,
  handshakeBound,
  intentWorlds,
  PROBED,
} from "./session-stop-intent-helpers.js";
import { messageRows, sessionRow, sessionRows } from "./session-store-helpers.js";
import { assistantIdFor, OWNER_ID, waitFor } from "./session-supervisor-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

const ROUTE = "/api/sessions/:id/stop";
const JSON_TYPE = "application/json";
/** A held assistant's content is appended by the store's real 2s FLUSH timer: not a stop write. */
const FLUSHED_LATER = "<flushed by the store timer>";

type StopSpy = MockInstance<SessionSupervisorPort["stop"]>;

/** `contentType` undefined sends no content-type header. */
interface BodyInput {
  name: string;
  payload: string;
  contentType?: string;
}

const MALFORMED_JSON: BodyInput = { name: "malformed JSON", payload: "{", contentType: JSON_TYPE };
const EMPTY_JSON: BodyInput = { name: "empty JSON", payload: "", contentType: JSON_TYPE };
const OCTET: BodyInput = {
  name: "unsupported media",
  payload: "x",
  contentType: "application/octet-stream",
};

/** Tiny bodies only (≤2 bytes): `{}` is above the 1-byte limit; `1`/`x`/`""` parse into a body. */
const WIRE_BODIES: readonly BodyInput[] = [
  { name: "{} JSON (over the limit)", payload: "{}", contentType: JSON_TYPE },
  MALFORMED_JSON,
  EMPTY_JSON,
  OCTET,
  { name: "1 JSON", payload: "1", contentType: JSON_TYPE },
  { name: "x text/plain", payload: "x", contentType: "text/plain" },
  { name: "empty text/plain", payload: "", contentType: "text/plain" },
];

const INJECT_BODIES: readonly BodyInput[] = [
  ...WIRE_BODIES,
  { name: '{"x":1} JSON', payload: '{"x":1}', contentType: JSON_TYPE },
  { name: "1 without content-type", payload: "1" },
  OVERSIZED_PARSER_INPUT,
];

/** A3/A4 bodies: none, malformed and the 1.1 MB oversized input (inject only). */
const PRE_PARSER_BODIES: ReadonlyArray<BodyInput | undefined> = [
  undefined,
  MALFORMED_JSON,
  OVERSIZED_PARSER_INPUT,
];

const { open } = intentWorlds(true);

function headersFor(cookie: string | null, body: BodyInput | undefined): Record<string, string> {
  return {
    ...(cookie === null ? {} : { cookie }),
    ...(body?.contentType === undefined ? {} : { "content-type": body.contentType }),
  };
}

function postStop(
  app: FastifyInstance,
  session: string,
  cookie: string | null,
  body?: BodyInput,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${session}/stop`,
    headers: headersFor(cookie, body),
    ...(body === undefined ? {} : { payload: body.payload }),
  });
}

/** What the wire returned, read in full while the app still listens. */
async function wireStop(origin: string, session: string, cookie: string | null, body?: BodyInput) {
  const response = await fetch(`${origin}/api/sessions/${session}/stop`, {
    method: "POST",
    headers: headersFor(cookie, body),
    ...(body === undefined ? {} : { body: body.payload }),
  });
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    setCookie: response.headers.get("set-cookie"),
    text: await response.text(),
  };
}

function onWire(status: number, text: string) {
  return { status, cacheControl: "no-store", setCookie: null, text };
}

function expectAccepted(response: LightMyRequestResponse): void {
  expect(response.statusCode).toBe(202);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.payload).toBe("{}");
}

function expectNoContent(response: LightMyRequestResponse): void {
  expect(response.statusCode).toBe(204);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.payload).toBe("");
}

function expectEnvelope(response: LightMyRequestResponse, status: number, envelope: object): void {
  expect({
    status: response.statusCode,
    cacheControl: response.headers["cache-control"],
    payload: response.payload,
  }).toEqual({ status, cacheControl: "no-store", payload: JSON.stringify(envelope) });
}

/** Session rows and message rows; only a running assistant's `content` is exempt (FLUSH timer). */
function rowsOf(db: DatabaseSync) {
  return {
    sessions: sessionRows(db),
    messages: messageRows(db).map((row) =>
      row.role === "assistant" && row.status === "running"
        ? { ...row, content: FLUSHED_LATER }
        : row,
    ),
  };
}

function runningSession(store: SessionStore): string {
  const { id } = store.create(OWNER_ID);
  store.acceptPrompt(id, OWNER_ID, "hold the turn");
  return id;
}

function endedSession(store: SessionStore, status: FinishStatus): string {
  const { id } = store.create(OWNER_ID);
  const { assistantMessageId } = store.acceptPrompt(id, OWNER_ID, "finish the turn");
  store.finishTurn(assistantMessageId, status);
  return id;
}

/** Stub world "no side effects": no stop, prompt or cursor call and no row changed. */
function expectStubQuiet(
  fixture: SessionRestFixture,
  spy: StopSpy,
  before: ReturnType<typeof rowsOf>,
): void {
  expect(spy).not.toHaveBeenCalled();
  expect(fixture.supervisor.calls).toEqual([]);
  expect(fixture.supervisor.cursorCalls).toEqual([]);
  expect(rowsOf(fixture.db)).toEqual(before);
}

/** Real world "no side effects": no stop call, no row changed, no `abort` frame on any child. */
function expectWorldQuiet(
  world: ApprovalWorld,
  spy: StopSpy,
  before: ReturnType<typeof rowsOf>,
): void {
  expect(spy).not.toHaveBeenCalled();
  expect(rowsOf(world.fixture.db)).toEqual(before);
  for (const spawned of world.spawned) {
    expect(abortCount(spawned.stdin)).toBe(0);
  }
}

function spyStop(world: ApprovalWorld): StopSpy {
  return vi.spyOn(world.fixture.supervisor, "stop");
}

function heldAbortCount(world: ApprovalWorld): number {
  return abortCount(afterPrompt(spawnedAt(world, 0).stdin));
}

function ownerStop(world: ApprovalWorld): Promise<LightMyRequestResponse> {
  return postStop(world.fixture.app, world.session, world.cookie);
}

/** Waits for the session's turn.end: exactly one, `stopped`, and no error was published. */
async function expectStoppedEnd(world: ApprovalWorld, assistant: number): Promise<void> {
  await waitForEvent(world, "turn.end");
  await settle();
  expect(turnEnds(world)).toEqual([ended(assistant, "stopped")]);
  expectNoError(world);
}

/**
 * REST prompt left in flight while the child is still acquiring (nothing written to its stdin):
 * the stop returns 202 {} first and the prompt request is still pending afterwards.
 */
async function stopWhileAcquiring(world: ApprovalWorld, message: string) {
  const prompt = postPrompt(
    world.fixture.app,
    world.session,
    world.cookie,
    JSON.stringify({ message }),
  );
  const observed = observePromise(prompt);
  const child = await waitFor(() => world.spawned[0], `${message} child`);
  expectAccepted(await ownerStop(world));
  expect(child.stdin).toEqual([]);
  await settle();
  expect(observed.outcome).toBe("pending");
  return { prompt, child };
}

describe("stop REST status matrix on the stub supervisor", () => {
  it("A1 a running session: stop is called once, then 202 with body exactly {}", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = runningSession(fixture.store);
      const spy = vi.spyOn(fixture.supervisor, "stop").mockResolvedValue(undefined);

      expectAccepted(await postStop(fixture.app, session, cookie));

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(session);
      expect(sessionRow(fixture.db, session).status).toBe("running");
      expect(fixture.supervisor.calls).toEqual([]);
      expect(fixture.supervisor.cursorCalls).toEqual([]);
    });
  });

  it("A1b the 202 waits for supervisor.stop to resolve", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = runningSession(fixture.store);
      const gate = deferred();
      const spy = vi.spyOn(fixture.supervisor, "stop").mockReturnValue(gate.promise);

      const response = postStop(fixture.app, session, cookie);
      const observed = observePromise(response);
      await settle();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(observed.outcome).toBe("pending");

      gate.resolve();
      expectAccepted(await response);
    });
  });

  it("A2 idle, done, failed and stopped sessions: 204 without body or side effects", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const sessions = [
        fixture.store.create(OWNER_ID).id,
        endedSession(fixture.store, "done"),
        endedSession(fixture.store, "failed"),
        endedSession(fixture.store, "stopped"),
      ];
      expect(sessions.map((id) => sessionRow(fixture.db, id).status)).toEqual([
        "idle",
        "done",
        "failed",
        "stopped",
      ]);
      const spy = vi.spyOn(fixture.supervisor, "stop");
      const before = rowsOf(fixture.db);

      for (const session of sessions) {
        expectNoContent(await postStop(fixture.app, session, cookie));
      }
      await settle();
      expectStubQuiet(fixture, spy, before);
    });
  });

  it("A3 no cookie: 401 before the parser, with or without a body", async () => {
    await withSessionRest(async (fixture) => {
      const session = runningSession(fixture.store);
      const spy = vi.spyOn(fixture.supervisor, "stop");
      const before = rowsOf(fixture.db);

      for (const body of PRE_PARSER_BODIES) {
        const response = await postStop(fixture.app, session, null, body);
        expectEnvelope(response, 401, UNAUTHORIZED_ENVELOPE);
      }
      await settle();
      expectStubQuiet(fixture, spy, before);
    });
  });

  it("A4 foreign and unknown sessions: one identical 404 before the parser", async () => {
    await withSessionRest(async (fixture) => {
      const owner = await cookieFor(fixture.app, "zhangsan");
      const foreign = await cookieFor(fixture.app, "zhaoliu");
      const session = runningSession(fixture.store);
      const spy = vi.spyOn(fixture.supervisor, "stop");
      const before = rowsOf(fixture.db);

      const identities = [];
      for (const [target, cookie] of [
        [session, foreign],
        [UNKNOWN_SESSION_ID, owner],
      ] as const) {
        for (const body of PRE_PARSER_BODIES) {
          const response = await postStop(fixture.app, target, cookie, body);
          expectEnvelope(response, 404, NOT_FOUND_ENVELOPE);
          identities.push({
            payload: response.payload,
            contentType: response.headers["content-type"],
          });
        }
      }
      expect(identities).toHaveLength(6);
      expect(new Set(identities.map((entry) => JSON.stringify(entry))).size).toBe(1);
      await settle();
      expectStubQuiet(fixture, spy, before);
    });
  });

  it("A5 any body is 400 on running and done sessions; no body keeps 202/204", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const running = runningSession(fixture.store);
      const done = endedSession(fixture.store, "done");
      const spy = vi.spyOn(fixture.supervisor, "stop").mockResolvedValue(undefined);
      const before = rowsOf(fixture.db);

      for (const session of [running, done]) {
        for (const body of INJECT_BODIES) {
          const response = await postStop(fixture.app, session, cookie, body);
          expect({ body: body.name, status: response.statusCode }).toEqual({
            body: body.name,
            status: 400,
          });
          expectEnvelope(response, 400, BAD_REQUEST_ENVELOPE);
        }
      }
      await settle();
      expectStubQuiet(fixture, spy, before);

      expectAccepted(await postStop(fixture.app, running, cookie));
      expect(spy).toHaveBeenCalledTimes(1);
      expectNoContent(await postStop(fixture.app, done, cookie));
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("A6 stop faults map to the envelope with no-store and no unhandled rejection", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = runningSession(fixture.store);
      const spy = vi.spyOn(fixture.supervisor, "stop");

      spy.mockImplementation(() => {
        throw new Error("runtimeState fault");
      });
      const thrown = await postStop(fixture.app, session, cookie);
      expectServerError(thrown);
      expect(thrown.payload).not.toContain("runtimeState fault");

      spy.mockRejectedValue(new Error("deny settle failed"));
      const rejected = await postStop(fixture.app, session, cookie);
      expectServerError(rejected);
      expect(rejected.payload).not.toContain("deny settle failed");

      spy.mockRejectedValue(new HttpError("agent_unavailable"));
      expectEnvelope(await postStop(fixture.app, session, cookie), 502, AGENT_UNAVAILABLE_ENVELOPE);

      expect(spy).toHaveBeenCalledTimes(3);
      await settle();
    });
  });
});

describe("stop REST on the real supervisor and fake-omp", () => {
  it(
    "R1 abort-ok: 202 {}, one abort, stopped end; later stops 204; the process continues",
    REAL,
    async () => {
      const world = await open("abort-ok");
      await heldTurn(world);
      const idle = await extraSession(world);
      const spy = spyStop(world);

      expectAccepted(await ownerStop(world));
      const assistant = assistantIdFor(world.fixture, world.session);
      await expectStoppedEnd(world, assistant);
      expect(heldAbortCount(world)).toBe(1);
      expect(await listedStatus(world)).toBe("stopped");
      const stopped = await history(world);
      expect(stopped.session.status).toBe("stopped");
      expect(stopped.messages[1]).toMatchObject({ id: assistant, status: "stopped" });
      const steps = stopped.messages.flatMap((message) => message.steps);
      expect(steps.filter((step) => step.status === "running")).toEqual([]);

      const before = rowsOf(world.fixture.db);
      expectNoContent(await ownerStop(world));
      expectNoContent(await postStop(world.fixture.app, idle, world.cookie));
      await settle();
      expect(rowsOf(world.fixture.db)).toEqual(before);
      expect(heldAbortCount(world)).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(world.session);

      expect(await probeFrames(world)).toBe(PROBED);
    },
  );

  it(
    "R2 abort-ignored: both stops 202 {} before the turn ends, one abort, one stopped end",
    REAL,
    async () => {
      const world = await open("abort-ignored");
      await heldTurn(world);
      const spy = spyStop(world);

      expectAccepted(await ownerStop(world));
      expect(await listedStatus(world)).toBe("running");
      expect(turnEnds(world)).toEqual([]);
      expectAccepted(await ownerStop(world));
      await settle();
      expect(await listedStatus(world)).toBe("running");
      expect(turnEnds(world)).toEqual([]);
      expect(heldAbortCount(world)).toBe(1);
      expect(spy).toHaveBeenCalledTimes(2);

      world.clock.advance(GRACE_MS);
      await expectStoppedEnd(world, assistantIdFor(world.fixture, world.session));
      expect(heldAbortCount(world)).toBe(1);
    },
  );

  it(
    "R3 slow-ready: stop returns 202 {} during the handshake, the prompt still returns 202",
    REAL,
    async () => {
      const world = await open("slow-ready");
      delayReady(world, 2_000);
      const spy = spyStop(world);
      const { prompt, child } = await stopWhileAcquiring(world, "slow-ready");

      const accepted = await prompt;
      expect(accepted.statusCode).toBe(202);
      const body = accepted.json<{ userMessageId: number; assistantMessageId: number }>();
      expect(Object.keys(body).sort()).toEqual(["assistantMessageId", "undo", "userMessageId"]);
      await expectStoppedEnd(world, body.assistantMessageId);
      expect(frameTypes(afterPrompt(child.stdin))).toEqual(["abort"]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await probeFrames(world)).toBe(PROBED);
    },
  );

  it(
    "R4 no-ready-hang: stop 202 lands first, then the prompt fails 502 and is compensated",
    REAL,
    async () => {
      const world = await open("no-ready-hang");
      handshakeBound(world, 1_000);
      const spy = spyStop(world);
      const { prompt, child } = await stopWhileAcquiring(world, "never-ready");

      expectEnvelope(await prompt, 502, AGENT_UNAVAILABLE_ENVELOPE);
      const after = await history(world);
      expect(after.messages).toEqual([]);
      expect(after.session.status).toBe("idle");
      await waitFor(
        () => (world.fixture.supervisor.liveProcessCount() === 0 ? true : undefined),
        "every process released",
      );
      await settle();
      expect(turnEnds(world)).toEqual([]);
      expect(ofType(sessionEvents(world), "error")).toEqual([]);
      expect(frameTypes(child.stdin)).not.toContain("abort");

      expectNoContent(await ownerStop(world));
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );
});

describe("stop REST over a real socket", () => {
  it(
    "W1 every body is an owned 400 before any stop call; no body keeps 204/202",
    REAL,
    async () => {
      const world = await open("abort-ok");
      await heldTurn(world);
      world.rt.setScenario("normal");
      const done = await extraSession(world);
      await prompted(world, done);
      const [end] = await waitForEvent(world, "turn.end", 1, done);
      expect(end?.data.status).toBe("done");
      await settle();
      const spy = spyStop(world);
      const before = rowsOf(world.fixture.db);

      await withListeningApp(world.fixture.app, async (origin) => {
        for (const session of [world.session, done]) {
          for (const body of WIRE_BODIES) {
            expect({
              body: body.name,
              ...(await wireStop(origin, session, world.cookie, body)),
            }).toEqual({ body: body.name, ...onWire(400, JSON.stringify(BAD_REQUEST_ENVELOPE)) });
          }
        }
        await settle();
        expectWorldQuiet(world, spy, before);
        expect(world.fixture.app.hasRoute({ method: "POST", url: ROUTE })).toBe(true);

        expect(await wireStop(origin, done, world.cookie)).toEqual(onWire(204, ""));
        expect(await wireStop(origin, world.session, world.cookie)).toEqual(onWire(202, "{}"));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(world.session);
        await waitFor(() => (heldAbortCount(world) === 1 ? true : undefined), "one abort frame");
      });
    },
  );

  it("W2 401 and the identical 404 come before the parser on the wire", REAL, async () => {
    const world = await open("abort-ok");
    await heldTurn(world);
    const foreign = await cookieFor(world.fixture.app, "zhaoliu");
    const spy = spyStop(world);
    const before = rowsOf(world.fixture.db);

    await withListeningApp(world.fixture.app, async (origin) => {
      const unauthorized = onWire(401, JSON.stringify(UNAUTHORIZED_ENVELOPE));
      const notFound = onWire(404, JSON.stringify(NOT_FOUND_ENVELOPE));
      const targets = [
        [world.session, null, unauthorized],
        [world.session, foreign, notFound],
        [UNKNOWN_SESSION_ID, world.cookie, notFound],
      ] as const;
      for (const [session, cookie, expected] of targets) {
        for (const body of [MALFORMED_JSON, EMPTY_JSON, OCTET]) {
          expect(await wireStop(origin, session, cookie, body)).toEqual(expected);
        }
      }
      await settle();
      expectWorldQuiet(world, spy, before);
    });
  });
});
