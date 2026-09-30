/**
 * Issue #469 fork REST route on the stub supervisor (`withSessionRest`), parent s1c tasks 5.2b,
 * design A1–A6: `fork` is controlled and observed with a spy (unmocked it calls through to the
 * stub's "unexpected fork call" rejection, i.e. a generic 500). Oracles: status, exact payload,
 * no-store, the spy, the stub's prompt/cursor call logs and the real store's rows. Envelopes are
 * the shared fixture literals.
 */
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import type { SessionSupervisorPort } from "../src/sessions/rest.js";
import type { FinishStatus, SessionStore } from "../src/sessions/store.js";
import { expectServerError } from "./auth-lifecycle-helpers.js";
import { settle } from "./session-approval-helpers.js";
import {
  type BodyInput,
  EMPTY_JSON,
  expectEnvelope,
  MALFORMED_JSON,
  OCTET,
  postSessionAction,
} from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import { NULL_SESSION_META, SESSION_VIEW_KEYS } from "./session-meta-fixtures.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  deferred,
  OVERSIZED_PARSER_INPUT,
  SESSION_BUSY_ENVELOPE,
  type SessionRestFixture,
  UNKNOWN_SESSION_ID,
  withSessionRest,
} from "./session-rest-helpers.js";
import { collectRejections, type RejectionLog } from "./session-stop-helpers.js";
import { persistenceSnapshot } from "./session-store-helpers.js";
import { OWNER_ID } from "./session-supervisor-helpers.js";
import { expectCapacity } from "./session-supervisor-pool-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

type ForkSpy = MockInstance<SessionSupervisorPort["fork"]>;
type Forked = Awaited<ReturnType<SessionSupervisorPort["fork"]>>;

const JSON_TYPE = "application/json";
const MESSAGE_ID = 7;
const FORKED_ID = "0123456789abcdef0123456789abcdef";

function jsonBody(name: string, payload: string): BodyInput {
  return { name, payload, contentType: JSON_TYPE };
}

const VALID = jsonBody("valid", JSON.stringify({ messageId: MESSAGE_ID }));

/** `{"messageId":1}` padded with whitespace past the route's 1 KiB bodyLimit: still valid JSON. */
const PADDED = jsonBody("valid JSON padded past 1 KiB", `{"messageId":1}${" ".repeat(1_100)}`);

/** Every body that is not exactly `{messageId:<positive safe integer>}` as application/json. */
const SHAPE_BODIES: readonly BodyInput[] = [
  jsonBody("{}", "{}"),
  jsonBody("string id", '{"messageId":"1"}'),
  jsonBody("array id", '{"messageId":[1]}'),
  jsonBody("null id", '{"messageId":null}'),
  jsonBody("boolean id", '{"messageId":true}'),
  jsonBody("fraction id", '{"messageId":1.5}'),
  jsonBody("zero id", '{"messageId":0}'),
  jsonBody("negative id", '{"messageId":-1}'),
  jsonBody("2^53 id", '{"messageId":9007199254740992}'),
  jsonBody("1e400 id", '{"messageId":1e400}'),
  jsonBody("extra key", '{"messageId":1,"x":1}'),
  jsonBody("wrong case key", '{"MessageId":1}'),
  jsonBody("array body", "[1]"),
  jsonBody("null body", "null"),
  jsonBody("number body", "1"),
  jsonBody("string body", '"x"'),
  jsonBody("__proto__ body", '{"__proto__":{"messageId":1}}'),
  { name: "text/plain JSON", payload: '{"messageId":1}', contentType: "text/plain" },
  {
    name: "form urlencoded",
    payload: "messageId=1",
    contentType: "application/x-www-form-urlencoded",
  },
  OCTET,
  MALFORMED_JSON,
  EMPTY_JSON,
  { name: "1 without content-type", payload: "1" },
  OVERSIZED_PARSER_INPUT,
  PADDED,
];

/** 401/404-before-parser bodies: a valid one, malformed and the 1.1 MB oversized input. */
const PRE_PARSER_BODIES: readonly BodyInput[] = [VALID, MALFORMED_JSON, OVERSIZED_PARSER_INPUT];

let rejections: RejectionLog | undefined;
beforeEach(() => {
  rejections = collectRejections();
});
afterEach(async () => {
  try {
    await settle();
    expect(rejections?.reasons).toEqual([]);
  } finally {
    rejections?.dispose();
  }
});

function postFork(
  fixture: SessionRestFixture,
  session: string,
  cookie: string | null,
  body?: BodyInput,
): Promise<LightMyRequestResponse> {
  return postSessionAction(fixture.app, "fork", session, cookie, body);
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

function forkedSession(status: Forked["session"]["status"]): Forked["session"] {
  return {
    id: FORKED_ID,
    title: "forked title",
    status,
    createdAt: 11,
    updatedAt: 12,
    ...NULL_SESSION_META,
  };
}

/** A 201 whose payload is exactly `{session:<five keys>, draft}`, with no-store. */
function expectForked(
  response: LightMyRequestResponse,
  session: Forked["session"],
  draft: string,
): void {
  const expected = {
    session: {
      id: session.id,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...NULL_SESSION_META,
    },
    draft,
  };
  expect({
    status: response.statusCode,
    cacheControl: response.headers["cache-control"],
    payload: response.payload,
  }).toEqual({ status: 201, cacheControl: "no-store", payload: JSON.stringify(expected) });
  const body = JSON.parse(response.payload) as { session: object; draft: unknown };
  expect(Object.keys(body)).toEqual(["session", "draft"]);
  expect(Object.keys(body.session)).toEqual(SESSION_VIEW_KEYS);
  expect(typeof body.draft).toBe("string");
}

/** Stub "no side effects": no fork, prompt or cursor call and no row changed. */
function expectQuiet(
  fixture: SessionRestFixture,
  spy: ForkSpy,
  before: ReturnType<typeof persistenceSnapshot>,
): void {
  expect(spy).not.toHaveBeenCalled();
  expect(fixture.supervisor.calls).toEqual([]);
  expect(fixture.supervisor.cursorCalls).toEqual([]);
  expect(persistenceSnapshot(fixture.db)).toEqual(before);
}

describe("fork REST status matrix on the stub supervisor", () => {
  it("A1 idle/done/failed/stopped: 201 with exactly {session, draft}, extra keys dropped", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = endedSession(fixture.store, "done");
      const spy = vi.spyOn(fixture.supervisor, "fork");

      const statuses = ["idle", "done", "failed", "stopped"] as const;
      for (const [index, status] of statuses.entries()) {
        const forked = forkedSession(status);
        const draft = `draft ${status}`;
        const leaky = {
          session: { ...forked, parent_session_id: session, omp_session_file: "/f", extra: 1 },
          draft,
          extra: 1,
        };
        spy.mockResolvedValueOnce(index === 0 ? leaky : { session: forked, draft });

        const response = await postFork(fixture, session, cookie, VALID);

        expectForked(response, forked, draft);
        expect(response.payload).not.toMatch(/parent_session_id|omp_session_file|extra/u);
        expect(spy).toHaveBeenCalledTimes(index + 1);
        expect(spy).toHaveBeenLastCalledWith(session, "u1", MESSAGE_ID);
      }
      expect(fixture.supervisor.cursorCalls).toEqual([]);
      expect(fixture.supervisor.calls).toEqual([]);
    });
  });

  it("A1b the 201 waits for supervisor.fork to resolve", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = endedSession(fixture.store, "done");
      const gate = deferred<Forked>();
      const spy = vi.spyOn(fixture.supervisor, "fork").mockReturnValue(gate.promise);

      const response = postFork(fixture, session, cookie, VALID);
      const observed = observePromise(response);
      await settle();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(observed.outcome).toBe("pending");

      const forked = forkedSession("done");
      gate.resolve({ session: forked, draft: "later" });
      expectForked(await response, forked, "later");
    });
  });

  it("A2 fork faults map to their envelopes, rows unchanged, no raw echo", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = endedSession(fixture.store, "done");
      const spy = vi.spyOn(fixture.supervisor, "fork");
      const before = persistenceSnapshot(fixture.db);
      const typed = [
        ["session_busy", 409, SESSION_BUSY_ENVELOPE],
        ["bad_request", 400, BAD_REQUEST_ENVELOPE],
        ["agent_unavailable", 502, AGENT_UNAVAILABLE_ENVELOPE],
        ["not_found", 404, NOT_FOUND_ENVELOPE],
      ] as const;

      for (const [code, status, envelope] of typed) {
        spy.mockRejectedValueOnce(new HttpError(code));
        expectEnvelope(await postFork(fixture, session, cookie, VALID), status, envelope);
      }
      spy.mockRejectedValueOnce(new HttpError("agent_capacity"));
      expectCapacity(await postFork(fixture, session, cookie, VALID));

      spy.mockRejectedValueOnce(new Error("fork-raw-secret"));
      const rejected = await postFork(fixture, session, cookie, VALID);
      expectServerError(rejected);
      expect(rejected.payload).not.toContain("fork-raw-secret");

      spy.mockImplementationOnce(() => {
        throw new Error("fork-sync-secret");
      });
      const thrown = await postFork(fixture, session, cookie, VALID);
      expectServerError(thrown);
      expect(thrown.payload).not.toContain("fork-sync-secret");

      expect(spy).toHaveBeenCalledTimes(7);
      expect(persistenceSnapshot(fixture.db)).toEqual(before);
    });
  });

  it("A3 no cookie: 401 before the parser and before any supervisor call", async () => {
    await withSessionRest(async (fixture) => {
      const session = endedSession(fixture.store, "done");
      const spy = vi.spyOn(fixture.supervisor, "fork");
      const before = persistenceSnapshot(fixture.db);

      for (const body of PRE_PARSER_BODIES) {
        expectEnvelope(await postFork(fixture, session, null, body), 401, UNAUTHORIZED_ENVELOPE);
      }
      await settle();
      expectQuiet(fixture, spy, before);
    });
  });

  it("A4 foreign and unknown sessions: one identical 404 before the parser", async () => {
    await withSessionRest(async (fixture) => {
      const owner = await cookieFor(fixture.app, "zhangsan");
      const foreign = await cookieFor(fixture.app, "zhaoliu");
      const session = endedSession(fixture.store, "done");
      const spy = vi.spyOn(fixture.supervisor, "fork");
      const before = persistenceSnapshot(fixture.db);

      const identities = [];
      for (const [target, cookie] of [
        [session, foreign],
        [UNKNOWN_SESSION_ID, owner],
      ] as const) {
        for (const body of PRE_PARSER_BODIES) {
          const response = await postFork(fixture, target, cookie, body);
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
      expectQuiet(fixture, spy, before);
    });
  });

  it("A5 every body other than {messageId:<positive safe integer>} is 400 before fork", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = endedSession(fixture.store, "done");
      const spy = vi.spyOn(fixture.supervisor, "fork");
      const before = persistenceSnapshot(fixture.db);

      for (const body of [...SHAPE_BODIES, undefined]) {
        const response = await postFork(fixture, session, cookie, body);
        const name = body?.name ?? "no body";
        expect({ body: name, status: response.statusCode }).toEqual({ body: name, status: 400 });
        expectEnvelope(response, 400, BAD_REQUEST_ENVELOPE);
      }
      await settle();
      expectQuiet(fixture, spy, before);

      const forked = forkedSession("done");
      spy.mockResolvedValue({ session: forked, draft: "d" });
      expectForked(await postFork(fixture, session, cookie, VALID), forked, "d");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(session, "u1", MESSAGE_ID);
    });
  });

  it("A6 a running session with an invalid body is 400, not 409", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = runningSession(fixture.store);
      const spy = vi.spyOn(fixture.supervisor, "fork");
      const before = persistenceSnapshot(fixture.db);

      for (const body of [MALFORMED_JSON, jsonBody("string id", '{"messageId":"1"}')]) {
        expectEnvelope(await postFork(fixture, session, cookie, body), 400, BAD_REQUEST_ENVELOPE);
      }
      await settle();
      expectQuiet(fixture, spy, before);
    });
  });
});
