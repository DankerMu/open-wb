import { constants } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import {
  BAD_REQUEST_ENVELOPE,
  expectServerError,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
import { PARSER_INPUTS } from "./http-guard-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  deferred,
  EXACT_MULTIBYTE,
  MESSAGE_LIMIT,
  OVERSIZED_PARSER_INPUT,
  postPrompt,
  SESSION_BUSY_ENVELOPE,
  SESSION_NOW,
  UNKNOWN_SESSION_ID,
  withSessionRest,
} from "./session-rest-helpers.js";
import { HEX32, messageRows, persistenceSnapshot, sessionRow } from "./session-store-helpers.js";
import { expectWorkspaceResponse } from "./workspaces-http-helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("session REST", () => {
  it("creates an idle session and returns it from the owner list and empty history", async () => {
    await withSessionRest(async ({ app }) => {
      const cookie = await cookieFor(app, "zhangsan");
      const empty = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { cookie },
      });
      expectWorkspaceResponse(empty, 200, { sessions: [] });

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const body = created.json() as {
        id: string;
        title: string | null;
        status: string;
        createdAt: number;
        updatedAt: number;
      };
      expect(body.id).toMatch(HEX32);
      expect(body).toEqual({
        id: body.id,
        title: null,
        status: "idle",
        createdAt: SESSION_NOW,
        updatedAt: SESSION_NOW,
      });

      const listed = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { cookie },
      });
      expectWorkspaceResponse(listed, 200, { sessions: [body] });

      const history = await app.inject({
        method: "GET",
        url: `/api/sessions/${body.id}/messages`,
        headers: { cookie },
      });
      expectWorkspaceResponse(history, 200, { session: body, messages: [] });
    });
  });

  it("lists only the owner's sessions in updatedAt order with a stable id tie-break", async () => {
    await withSessionRest(async ({ app, store }) => {
      const oldest = store.create("u1");
      vi.setSystemTime(SESSION_NOW + 10);
      const firstTie = store.create("u1");
      const secondTie = store.create("u1");
      const foreign = store.create("u2");
      const tied = [firstTie, secondTie].toSorted((left, right) => left.id.localeCompare(right.id));
      vi.setSystemTime(SESSION_NOW + 20);
      store.acceptPrompt(oldest.id, "u1", "bump older");

      const listed = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { cookie: await cookieFor(app, "zhangsan") },
      });
      expectWorkspaceResponse(listed, 200, {
        sessions: [
          {
            id: oldest.id,
            title: "bump older",
            status: "running",
            createdAt: SESSION_NOW,
            updatedAt: SESSION_NOW + 20,
          },
          {
            id: tied[0]?.id,
            title: null,
            status: "idle",
            createdAt: SESSION_NOW + 10,
            updatedAt: SESSION_NOW + 10,
          },
          {
            id: tied[1]?.id,
            title: null,
            status: "idle",
            createdAt: SESSION_NOW + 10,
            updatedAt: SESSION_NOW + 10,
          },
        ],
      });
      expect(listed.payload).not.toContain(foreign.id);
    });
  });

  it("returns public history in chronological and ordinal order without internal fields", async () => {
    await withSessionRest(async ({ app, store }) => {
      const session = store.create("u1");
      store.setSessionFile(session.id, "resume/hidden.jsonl");
      expect(store.bumpStreamEpoch(session.id)).toBe(1);

      vi.setSystemTime(SESSION_NOW + 5);
      const first = store.acceptPrompt(session.id, "u1", "saved title");
      expect(store.appendDelta(first.assistantMessageId, "first answer")).toBe(true);
      expect(store.finishTurn(first.assistantMessageId, "done")).toBe(true);

      vi.setSystemTime(SESSION_NOW + 20);
      const second = store.acceptPrompt(session.id, "u1", "second turn");
      vi.setSystemTime(SESSION_NOW + 21);
      const laterStep = store.startStep(second.assistantMessageId, {
        ordinal: 2,
        name: "later work",
        detail: "queued second",
      });
      vi.setSystemTime(SESSION_NOW + 22);
      const firstStep = store.startStep(second.assistantMessageId, {
        ordinal: 0,
        name: "first work",
        detail: "queued first",
      });
      expect(store.finishStep(laterStep, "failed", "stopped")).toBe(true);
      vi.setSystemTime(SESSION_NOW + 23);
      expect(store.finishTurn(second.assistantMessageId, "done")).toBe(true);

      const history = await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/messages`,
        headers: { cookie: await cookieFor(app, "zhangsan") },
      });
      expectWorkspaceResponse(history, 200, {
        session: {
          id: session.id,
          title: "saved title",
          status: "done",
          createdAt: SESSION_NOW,
          updatedAt: SESSION_NOW + 23,
        },
        messages: [
          {
            id: first.userMessageId,
            role: "user",
            content: "saved title",
            status: "done",
            createdAt: SESSION_NOW + 5,
            steps: [],
          },
          {
            id: first.assistantMessageId,
            role: "assistant",
            content: "first answer",
            status: "done",
            createdAt: SESSION_NOW + 5,
            steps: [],
          },
          {
            id: second.userMessageId,
            role: "user",
            content: "second turn",
            status: "done",
            createdAt: SESSION_NOW + 20,
            steps: [],
          },
          {
            id: second.assistantMessageId,
            role: "assistant",
            content: "",
            status: "done",
            createdAt: SESSION_NOW + 20,
            steps: [
              {
                id: firstStep,
                ordinal: 0,
                name: "first work",
                detail: "queued first",
                status: "done",
              },
              {
                id: laterStep,
                ordinal: 2,
                name: "later work",
                detail: "stopped",
                status: "failed",
              },
            ],
          },
        ],
      });
      expect(history.payload).not.toMatch(
        /startedAt|endedAt|owner_id|ownerId|omp_session_file|stream_epoch|streamEpoch|resume\/hidden/u,
      );
    });
  });

  it("hides foreign and unknown sessions behind identical 404 before prompt parsing", async () => {
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const owned = store.create("u1");
      const before = persistenceSnapshot(db);
      const ownerCookie = await cookieFor(app, "zhangsan");
      const foreignCookie = await cookieFor(app, "zhaoliu");
      const probes = [
        (id: string, cookie: string) => ({
          method: "GET" as const,
          url: `/api/sessions/${id}/messages`,
          headers: { cookie },
        }),
        (id: string, cookie: string) => ({
          method: "POST" as const,
          url: `/api/sessions/${id}/prompt`,
          headers: { "content-type": "application/json", cookie },
          payload: JSON.stringify({ message: "should not admit" }),
        }),
        (id: string, cookie: string) => ({
          method: "POST" as const,
          url: `/api/sessions/${id}/prompt`,
          headers: { "content-type": "application/json", cookie },
          payload: JSON.stringify({ message: "ok", extra: true }),
        }),
        (id: string, cookie: string) => ({
          method: "POST" as const,
          url: `/api/sessions/${id}/prompt`,
          headers: { "content-type": "application/json", cookie },
          payload: "{",
        }),
        (id: string, cookie: string) => ({
          method: "POST" as const,
          url: `/api/sessions/${id}/prompt`,
          headers: { "content-type": OVERSIZED_PARSER_INPUT.contentType, cookie },
          payload: OVERSIZED_PARSER_INPUT.payload,
        }),
      ];

      for (const [id, cookie] of [
        [owned.id, foreignCookie],
        [UNKNOWN_SESSION_ID, ownerCookie],
      ] as const) {
        for (const requestFor of probes) {
          const response = await app.inject(requestFor(id, cookie));
          expectWorkspaceResponse(response, 404, NOT_FOUND_ENVELOPE);
        }
      }

      const foreignList = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { cookie: foreignCookie },
      });
      expectWorkspaceResponse(foreignList, 200, { sessions: [] });
      expect(foreignList.payload).not.toContain(owned.id);
      expect(supervisor.calls).toEqual([]);
      expect(persistenceSnapshot(db)).toEqual(before);
    });
  });

  it("rejects unauthenticated session requests before parsing or mutation", async () => {
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const owned = store.create("u1");
      const before = persistenceSnapshot(db);
      const requests = [
        { method: "GET" as const, url: "/api/sessions" },
        {
          method: "POST" as const,
          url: "/api/sessions",
          headers: { "content-type": "application/json" },
          payload: "{",
        },
        { method: "GET" as const, url: `/api/sessions/${owned.id}/messages` },
        {
          method: "POST" as const,
          url: `/api/sessions/${owned.id}/prompt`,
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ message: "nope" }),
        },
        {
          method: "POST" as const,
          url: `/api/sessions/${owned.id}/prompt`,
          headers: { "content-type": "application/json" },
          payload: "{",
        },
        {
          method: "POST" as const,
          url: `/api/sessions/${owned.id}/prompt`,
          headers: { "content-type": OVERSIZED_PARSER_INPUT.contentType },
          payload: OVERSIZED_PARSER_INPUT.payload,
        },
        {
          method: "POST" as const,
          url: "/api/sessions",
          headers: { "content-type": OVERSIZED_PARSER_INPUT.contentType },
          payload: OVERSIZED_PARSER_INPUT.payload,
        },
      ];

      for (const request of requests) {
        const response = await app.inject(request);
        expectWorkspaceResponse(response, 401, UNAUTHORIZED_ENVELOPE);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }

      expect(supervisor.calls).toEqual([]);
      expect(persistenceSnapshot(db)).toEqual(before);
    });
  });

  it("rejects invalid prompt shape, media, and parser envelopes without admission", async () => {
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const session = store.create("u1");
      const cookie = await cookieFor(app, "zhangsan");
      const before = persistenceSnapshot(db);
      const invalid = [
        {
          name: "empty after trim",
          payload: JSON.stringify({ message: "  \n\t" }),
          contentType: "application/json",
        },
        {
          name: "wrong type",
          payload: JSON.stringify({ message: 1 }),
          contentType: "application/json",
        },
        {
          name: "null message",
          payload: JSON.stringify({ message: null }),
          contentType: "application/json",
        },
        { name: "array body", payload: JSON.stringify(["hello"]), contentType: "application/json" },
        { name: "null body", payload: "null", contentType: "application/json" },
        {
          name: "extra key",
          payload: JSON.stringify({ message: "ok", extra: true }),
          contentType: "application/json",
        },
        { name: "missing message", payload: JSON.stringify({}), contentType: "application/json" },
        {
          name: "oversize decoded",
          payload: JSON.stringify({ message: `${EXACT_MULTIBYTE}x` }),
          contentType: "application/json",
        },
        ...PARSER_INPUTS,
      ];

      for (const input of invalid) {
        const response = await postPrompt(
          app,
          session.id,
          cookie,
          input.payload,
          input.contentType,
        );
        expect(response.statusCode, input.name).toBe(400);
        expectWorkspaceResponse(response, 400, BAD_REQUEST_ENVELOPE);
      }

      expect(supervisor.calls).toEqual([]);
      expect(persistenceSnapshot(db)).toEqual(before);
    });
  });

  it("accepts trimmed UTF-8 messages at the 32768-byte boundary including escaped JSON", async () => {
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const cookie = await cookieFor(app, "zhangsan");
      const paddedExact = ` \n\t${EXACT_MULTIBYTE}\t\n `;
      const exactSession = store.create("u1");
      const exact = await postPrompt(
        app,
        exactSession.id,
        cookie,
        JSON.stringify({ message: paddedExact }),
        "application/json; charset=utf-8",
      );
      expect(exact.statusCode).toBe(202);
      expect(exact.headers["cache-control"]).toBe("no-store");
      expect(supervisor.calls).toEqual([{ sessionId: exactSession.id, text: EXACT_MULTIBYTE }]);
      expect(
        messageRows(db).find((row) => row.session_id === exactSession.id && row.role === "user"),
      ).toMatchObject({
        content: EXACT_MULTIBYTE,
        status: "done",
      });

      const decoded = "a".repeat(MESSAGE_LIMIT);
      const escapedPayload = `{"message":"${"\\u0061".repeat(MESSAGE_LIMIT)}"}`;
      const escapedSession = store.create("u1");
      supervisor.calls.length = 0;
      const escaped = await postPrompt(app, escapedSession.id, cookie, escapedPayload);
      expect(escaped.statusCode).toBe(202);
      expect(escaped.json()).toEqual({
        userMessageId: expect.any(Number),
        assistantMessageId: expect.any(Number),
      });
      expect(supervisor.calls).toEqual([{ sessionId: escapedSession.id, text: decoded }]);
      expect(
        messageRows(db).find((row) => row.session_id === escapedSession.id && row.role === "user"),
      ).toMatchObject({
        content: decoded,
        status: "done",
      });

      const overSession = store.create("u1");
      const beforeOver = persistenceSnapshot(db);
      supervisor.calls.length = 0;
      const over = await postPrompt(
        app,
        overSession.id,
        cookie,
        JSON.stringify({ message: ` ${EXACT_MULTIBYTE}x ` }),
      );
      expectWorkspaceResponse(over, 400, BAD_REQUEST_ENVELOPE);
      expect(supervisor.calls).toEqual([]);
      expect(persistenceSnapshot(db)).toEqual(beforeOver);
    });
  });

  it("admits a prompt, holds the supervisor, and rejects a concurrent owner prompt as busy", async () => {
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const session = store.create("u1");
      const cookie = await cookieFor(app, "zhangsan");
      const entered = deferred();
      const release = deferred();
      supervisor.onPrompt(async () => {
        entered.resolve();
        await release.promise;
      });

      const first = postPrompt(app, session.id, cookie, JSON.stringify({ message: "  keep me  " }));
      try {
        const outcome = await Promise.race([
          entered.promise.then(() => "entered" as const),
          first.then((response) => ({ settled: response })),
        ]);
        expect(outcome).toBe("entered");

        const admitted = messageRows(db).filter((row) => row.session_id === session.id);
        expect(admitted).toEqual([
          expect.objectContaining({
            role: "user",
            content: "keep me",
            status: "done",
            created_at: SESSION_NOW,
          }),
          expect.objectContaining({
            role: "assistant",
            content: "",
            status: "running",
            created_at: SESSION_NOW,
          }),
        ]);
        expect(sessionRow(db, session.id)).toMatchObject({
          title: "keep me",
          status: "running",
          updated_at: SESSION_NOW,
        });
        const snapshot = persistenceSnapshot(db);

        const concurrent = await postPrompt(
          app,
          session.id,
          cookie,
          JSON.stringify({ message: "second" }),
        );
        expectWorkspaceResponse(concurrent, 409, SESSION_BUSY_ENVELOPE);
        expect(persistenceSnapshot(db)).toEqual(snapshot);
        expect(supervisor.calls).toEqual([{ sessionId: session.id, text: "keep me" }]);

        release.resolve();
        const accepted = await first;
        expect(accepted.statusCode).toBe(202);
        expect(accepted.headers["cache-control"]).toBe("no-store");
        expect(accepted.json()).toEqual({
          userMessageId: admitted[0]?.id,
          assistantMessageId: admitted[1]?.id,
        });
        expect(sessionRow(db, session.id).status).toBe("running");
      } finally {
        release.resolve();
        await first.catch(() => undefined);
      }
    });
  });

  it("compensates typed supervisor rejection from idle, done, and failed sessions", async () => {
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const cookie = await cookieFor(app, "zhangsan");
      const cases = [
        {
          prior: "idle" as const,
          error: new HttpError("agent_unavailable"),
          status: 502,
          envelope: AGENT_UNAVAILABLE_ENVELOPE,
        },
        {
          prior: "done" as const,
          error: new HttpError("session_busy"),
          status: 409,
          envelope: SESSION_BUSY_ENVELOPE,
        },
        {
          prior: "failed" as const,
          error: new HttpError("agent_unavailable"),
          status: 502,
          envelope: AGENT_UNAVAILABLE_ENVELOPE,
        },
      ];

      for (const testCase of cases) {
        const session = store.create("u1");
        let retained: { userMessageId: number; assistantMessageId: number } | undefined;
        if (testCase.prior !== "idle") {
          vi.setSystemTime(SESSION_NOW + 1);
          retained = store.acceptPrompt(session.id, "u1", "saved title");
          expect(store.appendDelta(retained.assistantMessageId, `${testCase.prior} body`)).toBe(
            true,
          );
          expect(store.finishTurn(retained.assistantMessageId, testCase.prior)).toBe(true);
        }
        store.setSessionFile(session.id, "resume/keep.jsonl");
        expect(store.bumpStreamEpoch(session.id)).toBe(1);
        vi.setSystemTime(SESSION_NOW + 8);
        const before = persistenceSnapshot(db);
        supervisor.calls.length = 0;
        supervisor.onPrompt(async () => {
          throw testCase.error;
        });

        const rejected = await postPrompt(
          app,
          session.id,
          cookie,
          JSON.stringify({ message: "retry me" }),
        );
        expectWorkspaceResponse(rejected, testCase.status, testCase.envelope);
        expect(supervisor.calls).toEqual([{ sessionId: session.id, text: "retry me" }]);
        expect(persistenceSnapshot(db)).toEqual(before);
        expect(sessionRow(db, session.id)).toMatchObject({
          title: testCase.prior === "idle" ? null : "saved title",
          status: testCase.prior,
          omp_session_file: "resume/keep.jsonl",
        });

        supervisor.onPrompt(async () => {});
        vi.setSystemTime(SESSION_NOW + 9);
        const recovered = await postPrompt(
          app,
          session.id,
          cookie,
          JSON.stringify({ message: "after restore" }),
        );
        expect(recovered.statusCode).toBe(202);
        const recoveredBody = recovered.json() as {
          userMessageId: number;
          assistantMessageId: number;
        };
        expect(recoveredBody.userMessageId).not.toBe(retained?.userMessageId);
        expect(recoveredBody.assistantMessageId).not.toBe(retained?.assistantMessageId);
        expect(store.finishTurn(recoveredBody.assistantMessageId, "done")).toBe(true);
      }
    });
  });

  it("compensates unknown and forged supervisor failures as generic 5xx", async () => {
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const cookie = await cookieFor(app, "zhangsan");
      const failures = [
        new Error("raw-supervisor-secret"),
        Object.assign(new Error("forged-unavailable-secret"), {
          code: "agent_unavailable",
          statusCode: 502,
        }),
        Object.assign(new Error("forged-busy-secret"), { code: "session_busy", statusCode: 409 }),
      ];

      for (const failure of failures) {
        const session = store.create("u1");
        vi.setSystemTime(SESSION_NOW + 3);
        const prior = store.acceptPrompt(session.id, "u1", "keep history");
        expect(store.finishTurn(prior.assistantMessageId, "done")).toBe(true);
        const before = persistenceSnapshot(db);
        supervisor.calls.length = 0;
        supervisor.onPrompt(async () => {
          throw failure;
        });

        const response = await postPrompt(
          app,
          session.id,
          cookie,
          JSON.stringify({ message: "next" }),
        );
        expectServerError(response);
        expect(response.payload).not.toContain("raw-supervisor-secret");
        expect(response.payload).not.toContain("forged-unavailable-secret");
        expect(response.payload).not.toContain("forged-busy-secret");
        expect(response.payload).not.toContain("agent_unavailable");
        expect(response.payload).not.toContain("session_busy");
        expect(supervisor.calls).toEqual([{ sessionId: session.id, text: "next" }]);
        expect(persistenceSnapshot(db)).toEqual(before);
      }
    });
  });

  it("returns generic 5xx when prompt compensation storage fails", async () => {
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const session = store.create("u1");
      const cookie = await cookieFor(app, "zhangsan");
      const beforeAdmission = persistenceSnapshot(db);
      supervisor.onPrompt(async () => {
        db.setAuthorizer((actionCode, arg1) =>
          actionCode === constants.SQLITE_DELETE && arg1 === "chat_messages"
            ? constants.SQLITE_DENY
            : constants.SQLITE_OK,
        );
        throw new HttpError("agent_unavailable");
      });

      try {
        const response = await postPrompt(
          app,
          session.id,
          cookie,
          JSON.stringify({ message: "stranded" }),
        );
        expectServerError(response);
        expect(response.json()).not.toEqual(AGENT_UNAVAILABLE_ENVELOPE);
        expect(response.payload).not.toContain("agent_unavailable");
        expect(response.payload).not.toContain("chat_messages");
        expect(supervisor.calls).toEqual([{ sessionId: session.id, text: "stranded" }]);
        expect(persistenceSnapshot(db)).not.toEqual(beforeAdmission);
        expect(sessionRow(db, session.id)).toMatchObject({ status: "running", title: "stranded" });
        expect(messageRows(db).filter((row) => row.session_id === session.id)).toEqual([
          expect.objectContaining({ role: "user", content: "stranded", status: "done" }),
          expect.objectContaining({ role: "assistant", content: "", status: "running" }),
        ]);
      } finally {
        db.setAuthorizer(null);
      }
    });
  });

  it("does not dispatch or roll back another turn when admission is busy", async () => {
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const session = store.create("u1");
      const accepted = store.acceptPrompt(session.id, "u1", "active turn");
      const before = persistenceSnapshot(db);
      supervisor.onPrompt(async () => {
        throw new Error("should not dispatch");
      });

      const response = await postPrompt(
        app,
        session.id,
        await cookieFor(app, "zhangsan"),
        JSON.stringify({ message: "queued" }),
      );
      expectWorkspaceResponse(response, 409, SESSION_BUSY_ENVELOPE);
      expect(supervisor.calls).toEqual([]);
      expect(persistenceSnapshot(db)).toEqual(before);
      expect(messageRows(db).map((row) => row.id)).toEqual([
        accepted.userMessageId,
        accepted.assistantMessageId,
      ]);
    });
  });

  it("accepts a new prompt on done and failed sessions while retaining history", async () => {
    await withSessionRest(async ({ app, store }) => {
      const cookie = await cookieFor(app, "zhangsan");
      for (const terminal of ["done", "failed"] as const) {
        vi.setSystemTime(SESSION_NOW);
        const session = store.create("u1");
        vi.setSystemTime(SESSION_NOW + 4);
        const first = store.acceptPrompt(session.id, "u1", "saved title");
        expect(store.appendDelta(first.assistantMessageId, `${terminal} answer`)).toBe(true);
        expect(store.finishTurn(first.assistantMessageId, terminal)).toBe(true);

        vi.setSystemTime(SESSION_NOW + 12);
        const next = await postPrompt(
          app,
          session.id,
          cookie,
          JSON.stringify({ message: "follow up" }),
        );
        expect(next.statusCode).toBe(202);
        const body = next.json() as { userMessageId: number; assistantMessageId: number };
        expect(body.userMessageId).not.toBe(first.userMessageId);
        expect(body.assistantMessageId).not.toBe(first.assistantMessageId);

        const history = await app.inject({
          method: "GET",
          url: `/api/sessions/${session.id}/messages`,
          headers: { cookie },
        });
        expect(history.statusCode).toBe(200);
        expect(history.headers["cache-control"]).toBe("no-store");
        expect(history.json()).toEqual({
          session: {
            id: session.id,
            title: "saved title",
            status: "running",
            createdAt: SESSION_NOW,
            updatedAt: SESSION_NOW + 12,
          },
          messages: [
            {
              id: first.userMessageId,
              role: "user",
              content: "saved title",
              status: "done",
              createdAt: SESSION_NOW + 4,
              steps: [],
            },
            {
              id: first.assistantMessageId,
              role: "assistant",
              content: `${terminal} answer`,
              status: terminal,
              createdAt: SESSION_NOW + 4,
              steps: [],
            },
            {
              id: body.userMessageId,
              role: "user",
              content: "follow up",
              status: "done",
              createdAt: SESSION_NOW + 12,
              steps: [],
            },
            {
              id: body.assistantMessageId,
              role: "assistant",
              content: "",
              status: "running",
              createdAt: SESSION_NOW + 12,
              steps: [],
            },
          ],
        });
      }
    });
  });
});
