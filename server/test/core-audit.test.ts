import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuditEvent, type AuditPrincipal, emit, query } from "../src/core/audit/index.js";
import { HttpError } from "../src/core/errors/index.js";
import { withOpenDb } from "./core-db-helpers.js";

const MEMBER_U1 = { id: "u1", role: "成员" } as const;
const MEMBER_U2 = { id: "u2", role: "成员" } as const;
const ADMIN_U3 = { id: "u3", role: "管理员" } as const;
const OPERATOR_U1 = { id: "u1", role: "操作员" } as const;
const ADMIN_LOOKALIKE = { id: "u1", role: "管理员 " } as const;

const SAFE_OVERSIZED_ID = 9_007_199_254_740_991n;
const UNSAFE_OVERSIZED_ID = 9_007_199_254_740_992n;
const SQLITE_INT64_MAX_PLUS_ONE = "9223372036854775808";

afterEach(() => {
  vi.restoreAllMocks();
});

function expectBadRequest(run: () => unknown): void {
  try {
    run();
    expect.fail("expected canonical HttpError bad_request");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      name: "HttpError",
      code: "bad_request",
      message: "请求格式不正确",
    });
  }
}

function collectPages(
  db: DatabaseSync,
  principal: AuditPrincipal,
  limit: number,
  maxPages: number,
): AuditEvent[][] {
  const pages: AuditEvent[][] = [];
  let before: string | undefined;
  for (let pageIndex = 0; pageIndex <= maxPages; pageIndex += 1) {
    const page = query(db, principal, before === undefined ? { limit } : { limit, before });
    pages.push(page);
    const last = page.at(-1);
    if (last === undefined) {
      return pages;
    }
    const nextBefore = String(last.id);
    if (before !== undefined && !(BigInt(nextBefore) < BigInt(before))) {
      throw new Error("pagination cursor did not advance");
    }
    before = nextBefore;
  }
  throw new Error("pagination exceeded the known fixture size");
}

describe("core/audit emit and query", () => {
  it("round-trips nested JSON, explicit ts 0, omitted defaults, and the current clock", () => {
    withOpenDb(":memory:", (db) => {
      const nested = { nested: { ids: [1, 2], ok: true }, reason: "outside" };
      const explicitId = emit(db, {
        kind: "sandbox.reject",
        actorId: "u1",
        title: "denied",
        detail: nested,
        workspaceId: "ws1",
        ts: 0,
      });
      expect(explicitId).toBe(1);

      const now = 1_700_000_123_456;
      vi.spyOn(Date, "now").mockReturnValueOnce(now);
      const defaultId = emit(db, {
        kind: "workspace.create",
        actorId: "u2",
        title: "created",
      });
      expect(defaultId).toBe(2);

      expect(query(db, ADMIN_U3, {})).toEqual([
        {
          id: 2,
          ts: now,
          actorId: "u2",
          kind: "workspace.create",
          title: "created",
          detail: {},
          workspaceId: null,
        },
        {
          id: 1,
          ts: 0,
          actorId: "u1",
          kind: "sandbox.reject",
          title: "denied",
          detail: nested,
          workspaceId: "ws1",
        },
      ]);
      expect(query(db, MEMBER_U1, {})).toEqual([
        {
          id: 1,
          ts: 0,
          actorId: "u1",
          kind: "sandbox.reject",
          title: "denied",
          detail: nested,
          workspaceId: "ws1",
        },
      ]);
    });
  });

  it("returns the newest 50 visible member rows then the remainder without overlap", () => {
    withOpenDb(":memory:", (db) => {
      const visibleIds: number[] = [];
      for (let index = 0; index < 51; index += 1) {
        visibleIds.push(
          emit(db, {
            kind: "dir.create",
            actorId: "u1",
            title: `u1-${index}`,
            ts: 1_000 - index,
          }),
        );
        emit(db, {
          kind: "dir.create",
          actorId: "u2",
          title: `u2-${index}`,
          ts: 2_000 + index,
        });
      }
      expect(visibleIds).toHaveLength(51);

      const newestFirst = [...visibleIds].reverse();
      const firstPage = query(db, MEMBER_U1, {});
      expect(firstPage.map((event) => event.id)).toEqual(newestFirst.slice(0, 50));
      expect(firstPage.every((event) => event.actorId === "u1")).toBe(true);
      expect(query(db, MEMBER_U1, { limit: 200 }).map((event) => event.id)).toEqual(newestFirst);

      const remainder = query(db, MEMBER_U1, { before: String(firstPage.at(-1)?.id) });
      expect(remainder.map((event) => event.id)).toEqual(newestFirst.slice(50));
      expect(remainder).toHaveLength(1);
      expect([...firstPage, ...remainder].map((event) => event.id)).toEqual(newestFirst);
    });
  });

  it("pages member and admin views into the independently constructed visible sets", () => {
    withOpenDb(":memory:", (db) => {
      const u1Older = emit(db, {
        kind: "sandbox.reject",
        actorId: "u1",
        title: "u1-old",
        ts: 500,
      });
      const u2Mid = emit(db, {
        kind: "workspace.create",
        actorId: "u2",
        title: "u2-mid",
        ts: 1,
      });
      const u1Newer = emit(db, {
        kind: "dir.create",
        actorId: "u1",
        title: "u1-new",
        ts: 50,
      });
      const u2Newest = emit(db, {
        kind: "dir.create",
        actorId: "u2",
        title: "u2-new",
        ts: 9,
      });

      const memberPages = collectPages(db, MEMBER_U1, 1, 2);
      expect(memberPages.map((page) => page.map((event) => event.id))).toEqual([
        [u1Newer],
        [u1Older],
        [],
      ]);
      expect(memberPages.flat().every((event) => event.actorId === "u1")).toBe(true);

      const adminPages = collectPages(db, ADMIN_U3, 2, 2);
      expect(adminPages.map((page) => page.map((event) => event.id))).toEqual([
        [u2Newest, u1Newer],
        [u2Mid, u1Older],
        [],
      ]);
      expect(query(db, MEMBER_U2, { limit: 200 }).map((event) => event.id)).toEqual([
        u2Newest,
        u2Mid,
      ]);
    });
  });

  it("applies actor filtering for every role other than exact 管理员, including later pages", () => {
    withOpenDb(":memory:", (db) => {
      emit(db, { kind: "dir.create", actorId: "u2", title: "other-1", ts: 1 });
      const ownOlder = emit(db, { kind: "dir.create", actorId: "u1", title: "own-1", ts: 2 });
      emit(db, { kind: "dir.create", actorId: "u2", title: "other-2", ts: 3 });
      const ownNewer = emit(db, { kind: "dir.create", actorId: "u1", title: "own-2", ts: 4 });

      for (const principal of [MEMBER_U1, OPERATOR_U1, ADMIN_LOOKALIKE]) {
        const first = query(db, principal, { limit: 1 });
        expect(first.map((event) => event.id)).toEqual([ownNewer]);
        const rest = query(db, principal, { limit: 1, before: String(ownNewer) });
        expect(rest.map((event) => event.id)).toEqual([ownOlder]);
        expect([...first, ...rest].every((event) => event.actorId === "u1")).toBe(true);
      }
    });
  });

  it("rejects invalid limit and before values with canonical bad_request", () => {
    withOpenDb(":memory:", (db) => {
      emit(db, { kind: "dir.create", actorId: "u1", title: "kept", ts: 0 });
      const before = query(db, ADMIN_U3, {});

      for (const limit of [
        0,
        201,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        null,
      ]) {
        expectBadRequest(() => query(db, MEMBER_U1, { limit: limit as number }));
      }
      for (const cursor of [
        "abc",
        "0",
        "-1",
        "01",
        " 1",
        "1 ",
        "1\n",
        "1\r",
        "1\r\n",
        "\n1",
        "",
        1,
        null,
      ]) {
        expectBadRequest(() => query(db, MEMBER_U1, { before: cursor as string }));
      }

      expect(query(db, MEMBER_U1, { limit: 1 })).toEqual(before);
      expect(query(db, ADMIN_U3, {})).toEqual(before);
    });
  });

  it("returns ordinary rows for a canonical cursor beyond signed 64-bit range", () => {
    withOpenDb(":memory:", (db) => {
      const id = emit(db, { kind: "dir.create", actorId: "u1", title: "visible", ts: 0 });
      expect(
        query(db, MEMBER_U1, { before: SQLITE_INT64_MAX_PLUS_ONE }).map((event) => event.id),
      ).toEqual([id]);
    });
  });

  it("propagates native numeric decoding when a valid cursor includes an out-of-range stored id", () => {
    withOpenDb(":memory:", (db) => {
      db.prepare(
        "INSERT INTO audit_events(id, ts, actor_id, kind, title, detail, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(SAFE_OVERSIZED_ID, 0, "u1", "dir.create", "safe", "{}", null);
      db.prepare(
        "INSERT INTO audit_events(id, ts, actor_id, kind, title, detail, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(UNSAFE_OVERSIZED_ID, 1, "u1", "dir.create", "unsafe", "{}", null);

      try {
        query(db, MEMBER_U1, { before: "9007199254740993" });
        expect.fail("expected native node:sqlite RangeError");
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        expect(error).toMatchObject({
          code: "ERR_OUT_OF_RANGE",
        });
        expect(error).not.toBeInstanceOf(HttpError);
      }
    });
  });

  it("leaves the stored event set unchanged when serialization or FK insert fails", () => {
    withOpenDb(":memory:", (db) => {
      const kept = emit(db, {
        kind: "dir.create",
        actorId: "u1",
        title: "kept",
        ts: 0,
        detail: { ok: true },
      });
      const before = query(db, ADMIN_U3, {});
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;

      expect(() =>
        emit(db, {
          kind: "dir.create",
          actorId: "u1",
          title: "cycle",
          detail: cyclic,
        }),
      ).toThrow(TypeError);
      expect(() =>
        emit(db, {
          kind: "dir.create",
          actorId: "missing",
          title: "orphan",
        }),
      ).toThrow(/FOREIGN KEY constraint failed/);

      expect(query(db, ADMIN_U3, {})).toEqual(before);
      expect(query(db, ADMIN_U3, {}).map((event) => event.id)).toEqual([kept]);
    });
  });
});
