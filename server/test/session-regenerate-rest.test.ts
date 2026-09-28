/**
 * Issue #467 regenerate REST route and the prompt's pre-admission control-claim check (parent s1c
 * tasks 5.1b), design A1–A5 and P1–P5 on the stub supervisor (`withSessionRest`): `regenerate` and
 * `controlHeld` are controlled and observed with spies, `store.acceptPrompt` with a call-through
 * spy. Oracles: status, exact payload, no-store, the spies, the real store's rows and the
 * `chat_messages` AUTOINCREMENT high-water mark. Envelopes are fixture literals.
 */
import { constants } from "node:sqlite";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import type { SessionSupervisorPort } from "../src/sessions/rest.js";
import type { FinishStatus, SessionStore } from "../src/sessions/store.js";
import { expectServerError } from "./auth-lifecycle-helpers.js";
import { settle } from "./session-approval-helpers.js";
import {
  type BodyInput,
  expectEnvelope,
  INJECT_BODIES,
  MALFORMED_JSON,
  messageSeq,
  PRE_PARSER_BODIES,
  postSessionAction,
} from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  deferred,
  postPrompt,
  SESSION_BUSY_ENVELOPE,
  SESSION_NOW,
  type SessionRestFixture,
  UNKNOWN_SESSION_ID,
  withSessionRest,
} from "./session-rest-helpers.js";
import { collectRejections, type RejectionLog } from "./session-stop-helpers.js";
import { messageRows, persistenceSnapshot, sessionRow } from "./session-store-helpers.js";
import { OWNER_ID } from "./session-supervisor-helpers.js";
import { expectCapacity } from "./session-supervisor-pool-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

type RegenerateSpy = MockInstance<SessionSupervisorPort["regenerate"]>;

const PROMPT = JSON.stringify({ message: "next question" });

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

function postRegenerate(
  fixture: SessionRestFixture,
  session: string,
  cookie: string | null,
  body?: BodyInput,
): Promise<LightMyRequestResponse> {
  return postSessionAction(fixture.app, "regenerate", session, cookie, body);
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

function expectRegenerated(response: LightMyRequestResponse, assistantMessageId: number): void {
  expect({
    status: response.statusCode,
    cacheControl: response.headers["cache-control"],
    payload: response.payload,
  }).toEqual({
    status: 202,
    cacheControl: "no-store",
    payload: JSON.stringify({ assistantMessageId }),
  });
  const body = JSON.parse(response.payload) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["assistantMessageId"]);
  expect(Number.isSafeInteger(body.assistantMessageId)).toBe(true);
}

/** Stub "no side effects": no regenerate, prompt or cursor call and no row changed. */
function expectQuiet(
  fixture: SessionRestFixture,
  spy: RegenerateSpy,
  before: ReturnType<typeof persistenceSnapshot>,
): void {
  expect(spy).not.toHaveBeenCalled();
  expect(fixture.supervisor.calls).toEqual([]);
  expect(fixture.supervisor.cursorCalls).toEqual([]);
  expect(persistenceSnapshot(fixture.db)).toEqual(before);
}

describe("regenerate REST status matrix on the stub supervisor", () => {
  it("A1 done/failed/stopped: 202 with exactly {assistantMessageId}, extra keys dropped", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const sessions = (["done", "failed", "stopped"] as const).map((status) =>
        endedSession(fixture.store, status),
      );
      const spy = vi
        .spyOn(fixture.supervisor, "regenerate")
        .mockResolvedValue({ assistantMessageId: 41 });

      for (const [index, session] of sessions.entries()) {
        expectRegenerated(await postRegenerate(fixture, session, cookie), 41);
        expect(spy).toHaveBeenCalledTimes(index + 1);
        expect(spy).toHaveBeenLastCalledWith(session, "u1");
      }

      const withExtra = { assistantMessageId: 7, extra: 1 };
      spy.mockResolvedValue(withExtra);
      const [done] = sessions;
      if (done === undefined) {
        throw new Error("missing done session");
      }
      expectRegenerated(await postRegenerate(fixture, done, cookie), 7);
      expect(spy).toHaveBeenCalledTimes(4);
      expect(spy).toHaveBeenLastCalledWith(done, "u1");
      expect(fixture.supervisor.cursorCalls).toEqual([]);
      expect(fixture.supervisor.calls).toEqual([]);
    });
  });

  it("A1b the 202 waits for supervisor.regenerate to resolve", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = endedSession(fixture.store, "done");
      const gate = deferred<{ assistantMessageId: number }>();
      const spy = vi.spyOn(fixture.supervisor, "regenerate").mockReturnValue(gate.promise);

      const response = postRegenerate(fixture, session, cookie);
      const observed = observePromise(response);
      await settle();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(observed.outcome).toBe("pending");

      gate.resolve({ assistantMessageId: 41 });
      expectRegenerated(await response, 41);
    });
  });

  it("A2 regenerate faults map to their envelopes, rows unchanged, no raw echo", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = endedSession(fixture.store, "done");
      const spy = vi.spyOn(fixture.supervisor, "regenerate");
      const before = persistenceSnapshot(fixture.db);
      const typed = [
        ["session_busy", 409, SESSION_BUSY_ENVELOPE],
        ["bad_request", 400, BAD_REQUEST_ENVELOPE],
        ["agent_unavailable", 502, AGENT_UNAVAILABLE_ENVELOPE],
        ["not_found", 404, NOT_FOUND_ENVELOPE],
      ] as const;

      for (const [code, status, envelope] of typed) {
        spy.mockRejectedValueOnce(new HttpError(code));
        expectEnvelope(await postRegenerate(fixture, session, cookie), status, envelope);
      }
      spy.mockRejectedValueOnce(new HttpError("agent_capacity"));
      expectCapacity(await postRegenerate(fixture, session, cookie));

      spy.mockRejectedValueOnce(new Error("regenerate-raw-secret"));
      const rejected = await postRegenerate(fixture, session, cookie);
      expectServerError(rejected);
      expect(rejected.payload).not.toContain("regenerate-raw-secret");

      spy.mockImplementationOnce(() => {
        throw new Error("regenerate-sync-secret");
      });
      const thrown = await postRegenerate(fixture, session, cookie);
      expectServerError(thrown);
      expect(thrown.payload).not.toContain("regenerate-sync-secret");

      expect(spy).toHaveBeenCalledTimes(7);
      expect(persistenceSnapshot(fixture.db)).toEqual(before);
    });
  });

  it("A3 no cookie: 401 before the parser, with or without a body", async () => {
    await withSessionRest(async (fixture) => {
      const session = endedSession(fixture.store, "done");
      const spy = vi.spyOn(fixture.supervisor, "regenerate");
      const before = persistenceSnapshot(fixture.db);

      for (const body of PRE_PARSER_BODIES) {
        expectEnvelope(
          await postRegenerate(fixture, session, null, body),
          401,
          UNAUTHORIZED_ENVELOPE,
        );
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
      const spy = vi.spyOn(fixture.supervisor, "regenerate");
      const before = persistenceSnapshot(fixture.db);

      const identities = [];
      for (const [target, cookie] of [
        [session, foreign],
        [UNKNOWN_SESSION_ID, owner],
      ] as const) {
        for (const body of PRE_PARSER_BODIES) {
          const response = await postRegenerate(fixture, target, cookie, body);
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

  it("A5 any body is 400 on running and done sessions; no body reaches regenerate", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const running = runningSession(fixture.store);
      const done = endedSession(fixture.store, "done");
      const spy = vi.spyOn(fixture.supervisor, "regenerate");
      const before = persistenceSnapshot(fixture.db);

      for (const session of [running, done]) {
        for (const body of INJECT_BODIES) {
          const response = await postRegenerate(fixture, session, cookie, body);
          expect({ body: body.name, status: response.statusCode }).toEqual({
            body: body.name,
            status: 400,
          });
          expectEnvelope(response, 400, BAD_REQUEST_ENVELOPE);
        }
      }
      await settle();
      expectQuiet(fixture, spy, before);

      spy.mockResolvedValue({ assistantMessageId: 41 });
      expectRegenerated(await postRegenerate(fixture, done, cookie), 41);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(done, "u1");
    });
  });
});

describe("prompt control-claim check before admission on the stub supervisor", () => {
  it("P1 a held claim is 409 with no admission, no row and no sequence advance", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = endedSession(fixture.store, "done");
      const held = vi.spyOn(fixture.supervisor, "controlHeld").mockReturnValue(true);
      const accept = vi.spyOn(fixture.store, "acceptPrompt");
      const before = persistenceSnapshot(fixture.db);
      const seq = messageSeq(fixture.db);

      const rejected = await postPrompt(fixture.app, session, cookie, PROMPT);

      expectEnvelope(rejected, 409, SESSION_BUSY_ENVELOPE);
      expect(accept).not.toHaveBeenCalled();
      expect(fixture.supervisor.calls).toEqual([]);
      expect(persistenceSnapshot(fixture.db)).toEqual(before);
      expect(messageSeq(fixture.db)).toBe(seq);
      expect(held).toHaveBeenCalledWith(session);

      held.mockReturnValue(false);
      const admitted = await postPrompt(fixture.app, session, cookie, PROMPT);
      expect(admitted.statusCode).toBe(202);
      expect(accept).toHaveBeenCalledTimes(1);
      expect(fixture.supervisor.calls).toEqual([{ sessionId: session, text: "next question" }]);
    });
  });

  it("P2 a running session with a held claim is 409 before acceptPrompt", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = runningSession(fixture.store);
      vi.spyOn(fixture.supervisor, "controlHeld").mockReturnValue(true);
      const accept = vi.spyOn(fixture.store, "acceptPrompt");
      const before = persistenceSnapshot(fixture.db);

      expectEnvelope(
        await postPrompt(fixture.app, session, cookie, PROMPT),
        409,
        SESSION_BUSY_ENVELOPE,
      );
      expect(accept).not.toHaveBeenCalled();
      expect(fixture.supervisor.calls).toEqual([]);
      expect(persistenceSnapshot(fixture.db)).toEqual(before);
    });
  });

  it("P5 the claim check and acceptPrompt share one synchronous segment", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = endedSession(fixture.store, "done");
      const accept = vi.spyOn(fixture.store, "acceptPrompt");
      const seen: number[] = [];
      const held = vi.spyOn(fixture.supervisor, "controlHeld").mockImplementation(() => {
        queueMicrotask(() => seen.push(accept.mock.calls.length));
        return false;
      });

      const response = await postPrompt(fixture.app, session, cookie, PROMPT);

      expect(response.statusCode).toBe(202);
      expect(seen).toEqual([1]);
      expect(held).toHaveBeenCalledTimes(1);
      expect(held).toHaveBeenCalledWith(session);
    });
  });

  it("P3 (guard) 401 → 404 → 400 still precede the claim check", async () => {
    await withSessionRest(async (fixture) => {
      const owner = await cookieFor(fixture.app, "zhangsan");
      const foreign = await cookieFor(fixture.app, "zhaoliu");
      const session = endedSession(fixture.store, "done");
      const held = vi.spyOn(fixture.supervisor, "controlHeld").mockReturnValue(true);
      const before = persistenceSnapshot(fixture.db);

      const invalid = await postPrompt(fixture.app, session, owner, MALFORMED_JSON.payload);
      expectEnvelope(invalid, 400, BAD_REQUEST_ENVELOPE);
      const shape = await postPrompt(fixture.app, session, owner, JSON.stringify({ message: 1 }));
      expectEnvelope(shape, 400, BAD_REQUEST_ENVELOPE);
      expectEnvelope(
        await postPrompt(fixture.app, session, foreign, PROMPT),
        404,
        NOT_FOUND_ENVELOPE,
      );
      const anonymous = await fixture.app.inject({
        method: "POST",
        url: `/api/sessions/${session}/prompt`,
        headers: { "content-type": "application/json" },
        payload: PROMPT,
      });
      expectEnvelope(anonymous, 401, UNAUTHORIZED_ENVELOPE);

      expect(held).not.toHaveBeenCalled();
      expect(fixture.supervisor.calls).toEqual([]);
      expect(persistenceSnapshot(fixture.db)).toEqual(before);
    });
  });
});

describe("REST prompt admission and compensation increments (guards)", () => {
  it("P4 a stopped session prompts again with 202", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = endedSession(fixture.store, "stopped");

      const response = await postPrompt(fixture.app, session, cookie, PROMPT);

      expect(response.statusCode).toBe(202);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(sessionRow(fixture.db, session).status).toBe("running");
      expect(fixture.supervisor.calls).toEqual([{ sessionId: session, text: "next question" }]);
    });
  });

  it("P4 agent_capacity from idle/done/failed/stopped is 503 and restores the prior state", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      fixture.supervisor.onPrompt(async () => {
        throw new HttpError("agent_capacity");
      });
      const sessions = [
        fixture.store.create(OWNER_ID).id,
        ...(["done", "failed", "stopped"] as const).map((status) =>
          endedSession(fixture.store, status),
        ),
      ];

      vi.setSystemTime(SESSION_NOW + 8);
      for (const session of sessions) {
        const before = persistenceSnapshot(fixture.db);
        const prior = sessionRow(fixture.db, session);

        expectCapacity(await postPrompt(fixture.app, session, cookie, PROMPT));

        expect(persistenceSnapshot(fixture.db)).toEqual(before);
        expect(sessionRow(fixture.db, session)).toEqual(prior);
      }
      expect(fixture.supervisor.calls).toHaveLength(4);
    });
  });

  it("P4 a failed compensation after agent_capacity is generic 500, not 503", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const session = fixture.store.create(OWNER_ID).id;
      fixture.supervisor.onPrompt(async () => {
        fixture.db.setAuthorizer((actionCode, arg1) =>
          actionCode === constants.SQLITE_DELETE && arg1 === "chat_messages"
            ? constants.SQLITE_DENY
            : constants.SQLITE_OK,
        );
        throw new HttpError("agent_capacity");
      });

      try {
        const response = await postPrompt(fixture.app, session, cookie, PROMPT);
        expectServerError(response);
        expect(response.payload).not.toContain("agent_capacity");
        expect(messageRows(fixture.db).filter((row) => row.session_id === session)).toEqual([
          expect.objectContaining({ role: "user", content: "next question", status: "done" }),
          expect.objectContaining({ role: "assistant", content: "", status: "running" }),
        ]);
      } finally {
        fixture.db.setAuthorizer(null);
      }
    });
  });
});
