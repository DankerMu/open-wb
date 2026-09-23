import { constants, type DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import {
  BAD_REQUEST_ENVELOPE,
  bearerCookie,
  denyStatement,
  INTERNAL_ERROR_ENVELOPE,
  type InjectResponse,
  loginSessionId,
  resetDatabase,
  UNAUTHORIZED_ENVELOPE,
  withApp,
} from "./auth-lifecycle-helpers.js";

const NESTED_DETAIL = { nested: { ids: [1, 2], ok: true }, reason: "outside" };
const UNSAFE_OVERSIZED_ID = 9_007_199_254_740_992n;
const SAFE_OVERSIZED_ID = 9_007_199_254_740_991n;
const SQLITE_INT64_MAX_PLUS_ONE = "9223372036854775808";
const SAFE_MAX_EVENT = {
  id: 9_007_199_254_740_991,
  ts: 2,
  actorId: "u1",
  kind: "dir.create",
  title: "safe-max",
  detail: {},
  workspaceId: null,
} as const;

const U1_OLDER = {
  ts: 500,
  actorId: "u1",
  kind: "sandbox.reject",
  title: "u1-old",
  detail: NESTED_DETAIL,
  workspaceId: "ws1",
} as const;

const U2_MID = {
  ts: 1,
  actorId: "u2",
  kind: "workspace.create",
  title: "u2-mid",
  detail: {},
  workspaceId: null,
} as const;

const U1_NEWER = {
  ts: 50,
  actorId: "u1",
  kind: "dir.create",
  title: "u1-new",
  detail: {},
  workspaceId: null,
} as const;

const U2_NEWEST = {
  ts: 9,
  actorId: "u2",
  kind: "dir.create",
  title: "u2-new",
  detail: {},
  workspaceId: null,
} as const;

type SeededEvents = {
  u1Older: typeof U1_OLDER & { id: number };
  u2Mid: typeof U2_MID & { id: number };
  u1Newer: typeof U1_NEWER & { id: number };
  u2Newest: typeof U2_NEWEST & { id: number };
};

async function withAccountsApp<T>(
  action: (fixture: { app: FastifyInstance; db: DatabaseSync }) => Promise<T>,
): Promise<T> {
  return withApp({}, async ({ app, db }) => action({ app, db }));
}

function seedInterleavedEvents(db: DatabaseSync): SeededEvents {
  const u1Older = {
    id: emit(db, {
      kind: U1_OLDER.kind,
      actorId: U1_OLDER.actorId,
      title: U1_OLDER.title,
      detail: NESTED_DETAIL,
      workspaceId: "ws1",
      ts: U1_OLDER.ts,
    }),
    ...U1_OLDER,
  };
  const u2Mid = {
    id: emit(db, {
      kind: U2_MID.kind,
      actorId: U2_MID.actorId,
      title: U2_MID.title,
      ts: U2_MID.ts,
    }),
    ...U2_MID,
  };
  const u1Newer = {
    id: emit(db, {
      kind: U1_NEWER.kind,
      actorId: U1_NEWER.actorId,
      title: U1_NEWER.title,
      ts: U1_NEWER.ts,
    }),
    ...U1_NEWER,
  };
  const u2Newest = {
    id: emit(db, {
      kind: U2_NEWEST.kind,
      actorId: U2_NEWEST.actorId,
      title: U2_NEWEST.title,
      ts: U2_NEWEST.ts,
    }),
    ...U2_NEWEST,
  };
  return { u1Older, u2Mid, u1Newer, u2Newest };
}

async function withSeededMember(
  action: (fixture: {
    app: FastifyInstance;
    db: DatabaseSync;
    member: string;
    seeded: SeededEvents;
  }) => Promise<void>,
): Promise<void> {
  await withAccountsApp(async ({ app, db }) => {
    const seeded = seedInterleavedEvents(db);
    const member = bearerCookie(await loginSessionId(app, "zhangsan"));
    await action({ app, db, member, seeded });
  });
}

function auditRowSnapshot(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      "SELECT CAST(id AS TEXT) AS id, ts, actor_id, kind, title, detail, workspace_id FROM audit_events ORDER BY id",
    )
    .all();
}

async function getAudit(
  app: FastifyInstance,
  cookie: string | undefined,
  search = "",
): Promise<InjectResponse> {
  return app.inject({
    method: "GET",
    url: `/api/audit${search}`,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

function expectEvents(response: InjectResponse, events: unknown[]): void {
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toEqual({ events });
}

function expectCanonicalError(
  response: InjectResponse,
  status: 400 | 401 | 500,
  envelope:
    | typeof BAD_REQUEST_ENVELOPE
    | typeof UNAUTHORIZED_ENVELOPE
    | typeof INTERNAL_ERROR_ENVELOPE,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual(envelope);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["set-cookie"]).toBeUndefined();
  if (status !== 500) {
    return;
  }
  expect(response.payload).not.toContain("audit_events");
  expect(response.payload).not.toContain("SQLITE");
  expect(response.payload).not.toContain("ERR_OUT_OF_RANGE");
  expect(response.payload).not.toContain("FST_ERR");
  expect(response.payload).not.toContain("RangeError");
}

describe("GET /api/audit", () => {
  it("pages member and admin views with exact event shape, id DESC, and no-store", async () => {
    await withAccountsApp(async ({ app, db }) => {
      const seeded = seedInterleavedEvents(db);
      const member = bearerCookie(await loginSessionId(app, "zhangsan"));
      const admin = bearerCookie(await loginSessionId(app, "lisi"));

      expectEvents(await getAudit(app, member, "?limit=1"), [seeded.u1Newer]);
      expectEvents(await getAudit(app, member, `?limit=1&before=${seeded.u1Newer.id}`), [
        seeded.u1Older,
      ]);
      expectEvents(await getAudit(app, member, `?limit=1&before=${seeded.u1Older.id}`), []);

      expectEvents(await getAudit(app, admin, "?limit=2"), [seeded.u2Newest, seeded.u1Newer]);
      expectEvents(await getAudit(app, admin, `?limit=2&before=${seeded.u1Newer.id}`), [
        seeded.u2Mid,
        seeded.u1Older,
      ]);
      expectEvents(await getAudit(app, admin, `?limit=2&before=${seeded.u1Older.id}`), []);
    });
  });

  it.each([
    {
      name: "ignores query actor/role and unknown keys; only the guard principal reaches query",
      search: "?limit=1&actorId=u2&role=%E7%AE%A1%E7%90%86%E5%91%98&foo=bar",
      visible: (seeded: SeededEvents) => [seeded.u1Newer],
    },
    {
      name: "accepts a noncanonical numeric limit spelling that Number() maps into core bounds",
      search: "?limit=1e0",
      visible: (seeded: SeededEvents) => [seeded.u1Newer],
    },
    {
      name: "returns ordinary rows for a canonical cursor beyond signed 64-bit range",
      search: `?before=${SQLITE_INT64_MAX_PLUS_ONE}`,
      visible: (seeded: SeededEvents) => [seeded.u1Newer, seeded.u1Older],
    },
  ])("$name", async ({ search, visible }) => {
    await withSeededMember(async ({ app, member, seeded }) => {
      expectEvents(await getAudit(app, member, search), visible(seeded));
    });
  });

  it.each([
    ["limit=0", "?limit=0"],
    ["limit=201", "?limit=201"],
    ["limit=1.5", "?limit=1.5"],
    ["before=abc", "?before=abc"],
    ["before=0", "?before=0"],
    ["before=-1", "?before=-1"],
    ["empty limit", "?limit="],
    ["empty before", "?before="],
    ["repeated limit", "?limit=1&limit=2"],
    ["repeated before", "?before=1&before=2"],
  ] as const)("%s returns canonical 400 without changing audit rows", async (_name, search) => {
    await withSeededMember(async ({ app, db, member }) => {
      const before = auditRowSnapshot(db);
      expectCanonicalError(await getAudit(app, member, search), 400, BAD_REQUEST_ENVELOPE);
      expect(auditRowSnapshot(db)).toEqual(before);
    });
  });

  it("returns 401 no-store for invalid query without login before query processing", async () => {
    await withAccountsApp(async ({ app, db }) => {
      seedInterleavedEvents(db);
      const before = auditRowSnapshot(db);
      expectCanonicalError(await getAudit(app, undefined, "?limit=0"), 401, UNAUTHORIZED_ENVELOPE);
      expectCanonicalError(
        await getAudit(app, undefined, "?before=abc"),
        401,
        UNAUTHORIZED_ENVELOPE,
      );
      expect(auditRowSnapshot(db)).toEqual(before);
    });
  });

  it("maps native decoding of a 2^53 stored row to generic 500 while the excluding cursor stays 200", async () => {
    await withAccountsApp(async ({ app, db }) => {
      const visible = {
        id: emit(db, {
          kind: "dir.create",
          actorId: "u1",
          title: "safe-ordinary",
          ts: 0,
        }),
        ts: 0,
        actorId: "u1",
        kind: "dir.create",
        title: "safe-ordinary",
        detail: {},
        workspaceId: null,
      };
      db.prepare(
        "INSERT INTO audit_events(id, ts, actor_id, kind, title, detail, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(SAFE_OVERSIZED_ID, 2, "u1", "dir.create", "safe-max", "{}", null);
      db.prepare(
        "INSERT INTO audit_events(id, ts, actor_id, kind, title, detail, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(UNSAFE_OVERSIZED_ID, 3, "u1", "dir.create", "unsafe", "{}", null);
      const before = auditRowSnapshot(db);
      const member = bearerCookie(await loginSessionId(app, "zhangsan"));

      expectCanonicalError(
        await getAudit(app, member, "?before=9007199254740993"),
        500,
        INTERNAL_ERROR_ENVELOPE,
      );
      expectEvents(await getAudit(app, member, "?before=9007199254740992"), [
        SAFE_MAX_EVENT,
        visible,
      ]);
      expect(auditRowSnapshot(db)).toEqual(before);
    });
  });

  it("maps an actual audit SELECT denial to generic 500, keeps auth readable, and leaves rows unchanged", async () => {
    await withSeededMember(async ({ app, db, member, seeded }) => {
      const before = auditRowSnapshot(db);
      denyStatement(db, constants.SQLITE_READ, "audit_events");
      try {
        const me = await app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie: member },
        });
        expect(me.statusCode).toBe(200);
        expect(me.json()).toEqual({ id: "u1", account: "zhangsan", role: "成员" });
        expectCanonicalError(await getAudit(app, member), 500, INTERNAL_ERROR_ENVELOPE);
      } finally {
        resetDatabase(db);
      }
      expect(auditRowSnapshot(db)).toEqual(before);
      expectEvents(await getAudit(app, member, "?limit=1"), [seeded.u1Newer]);
    });
  });
});
