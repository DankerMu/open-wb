import { randomBytes as nodeRandomBytes } from "node:crypto";
import { constants, type DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  authenticate,
  DEFAULT_AUTH_RUNTIME,
  generateSessionId,
  insertSession,
  SESSION_COOKIE,
  SESSION_TTL,
  sessionExpiry,
  sessionIdFromCookies,
} from "../src/auth/index.js";
import { openDb } from "../src/core/db/index.js";
import { denyStatement, MALFORMED_SESSION_IDS } from "./auth-lifecycle-helpers.js";

const FIXED_NOW = 1_700_000_000_000;
const VALID_SESSION_ID = "5777bb89d0a34b5f8af733b23fa6dd5d0b19b13d9b1e27a8aa5e3dbd2f0b4ca7";
const OTHER_VALID_SESSION_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
}

function withDb<T>(action: (db: DatabaseSync) => T): T {
  const db = openDb(":memory:");
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function insertSessionRow(
  db: DatabaseSync,
  id: string,
  userId: string,
  expiresAt: number | bigint,
): void {
  db.prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)").run(
    id,
    userId,
    expiresAt,
  );
}

function sessionSnapshot(db: DatabaseSync): SessionRow[] {
  return db
    .prepare("SELECT id, user_id, expires_at FROM auth_sessions ORDER BY id")
    .all() as unknown as SessionRow[];
}

function accountSnapshot(db: DatabaseSync): unknown {
  return db
    .prepare("SELECT id, account, role, disabled, password_hash FROM accounts ORDER BY id")
    .all();
}

/** 直接 seam 的请求形状 = Fastify 结构兼容子集（cookies + server.db/authNow）。 */
function authRequest(db: DatabaseSync, cookieValue?: string, now = FIXED_NOW) {
  return {
    cookies: cookieValue === undefined ? undefined : { [SESSION_COOKIE]: cookieValue },
    server: { db, ...(now === undefined ? {} : { authNow: () => now }) },
  };
}

describe("authenticate seam：cookie 形状、时钟与账号资格（未过期路径不写入）", () => {
  it("有效未来行返回 exact Principal；过期行严格大于 now（相等即过期）", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 1);
      insertSessionRow(db, OTHER_VALID_SESSION_ID, "u2", FIXED_NOW + 2_000);
      const before = sessionSnapshot(db);

      expect(authenticate(authRequest(db, VALID_SESSION_ID))).toEqual({
        id: "u1",
        account: "zhangsan",
        role: "成员",
      });
      expect(authenticate(authRequest(db, OTHER_VALID_SESSION_ID))).toEqual({
        id: "u2",
        account: "zhaoliu",
        role: "成员",
      });
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it("缺失 cookie、错误 cookie 名、非 string cookie 均 null", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 1);
      const before = sessionSnapshot(db);

      expect(
        authenticate({ cookies: undefined, server: { db, authNow: () => FIXED_NOW } }),
      ).toBeNull();
      expect(
        authenticate({
          cookies: { wrong_cookie_name: VALID_SESSION_ID },
          server: { db, authNow: () => FIXED_NOW },
        }),
      ).toBeNull();
      expect(
        authenticate({
          cookies: { [SESSION_COOKIE]: 12345 as unknown as string },
          server: { db, authNow: () => FIXED_NOW },
        }),
      ).toBeNull();
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it.each(MALFORMED_SESSION_IDS)("畸形/非法 session id（%s）返回 null", (_name, cookieValue) => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 1);
      const before = sessionSnapshot(db);

      expect(authenticate(authRequest(db, cookieValue))).toBeNull();
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it("未知 session id 返回 null", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 1);
      const unknownId = "b".repeat(64);
      const before = sessionSnapshot(db);

      expect(authenticate(authRequest(db, unknownId))).toBeNull();
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it("expires_at 严格大于 now 才有效；等于 now 即过期（进入 #10 清理）", () => {
    withDb((db) => {
      const equalId = "c".repeat(64);
      const futureId = "e".repeat(64);
      insertSessionRow(db, equalId, "u1", FIXED_NOW);
      insertSessionRow(db, futureId, "u2", FIXED_NOW + 1);

      expect(authenticate(authRequest(db, futureId))).toEqual({
        id: "u2",
        account: "zhaoliu",
        role: "成员",
      });
      expect(authenticate(authRequest(db, equalId))).toBeNull();
      // 相等即过期：matched 行被定点清理，future sibling 不动。
      expect(sessionSnapshot(db)).toEqual([
        { id: futureId, user_id: "u2", expires_at: FIXED_NOW + 1 },
      ]);
    });
  });

  it.each([
    ["负数时钟", -1],
    ["小数时钟", 1.5],
    ["NaN 时钟", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["不安全整数", Number.MAX_SAFE_INTEGER + 1],
    ["字符串时钟", "1700000000000"],
  ] as const)("非法时钟 %s：返回 null 且不抛错，DB 字节级不变", (_name, now) => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 60_000);
      const beforeSessions = sessionSnapshot(db);
      const beforeAccounts = accountSnapshot(db);

      expect(() => authenticate(authRequest(db, VALID_SESSION_ID, now as number))).not.toThrow();
      expect(authenticate(authRequest(db, VALID_SESSION_ID, now as number))).toBeNull();
      expect(sessionSnapshot(db)).toEqual(beforeSessions);
      expect(accountSnapshot(db)).toEqual(beforeAccounts);
    });
  });

  it("非法时钟在任何查询之前 fail closed：SELECT 被拒仍返回 null 且不抛错", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 60_000);
      denyStatement(db, constants.SQLITE_SELECT, null);
      try {
        expect(() => authenticate(authRequest(db, VALID_SESSION_ID, -1))).not.toThrow();
        expect(authenticate(authRequest(db, VALID_SESSION_ID, -1))).toBeNull();
      } finally {
        db.setAuthorizer(null);
      }
    });
  });

  it("原型继承的 workbuddy_session cookie 视为不存在（null），plain Fastify cookie 正常", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 60_000);
      const before = sessionSnapshot(db);

      const inherited = Object.create({ [SESSION_COOKIE]: VALID_SESSION_ID });
      expect(
        authenticate({ cookies: inherited, server: { db, authNow: () => FIXED_NOW } }),
      ).toBeNull();
      expect(sessionSnapshot(db)).toEqual(before);

      expect(
        authenticate({
          cookies: { [SESSION_COOKIE]: VALID_SESSION_ID },
          server: { db, authNow: () => FIXED_NOW },
        }),
      ).toEqual({ id: "u1", account: "zhangsan", role: "成员" });
    });
  });

  it("孤儿/被删账号会话返回 null（join 落空）", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 1);

      db.prepare("DELETE FROM accounts WHERE id = ?").run("u1");
      expect(authenticate(authRequest(db, VALID_SESSION_ID))).toBeNull();
      // 账号删除已级联删除会话；FK 关闭时插入孤儿行验证 join 落空
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        db.prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)").run(
          OTHER_VALID_SESSION_ID,
          "u1",
          FIXED_NOW + 1,
        );
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
      expect(authenticate(authRequest(db, OTHER_VALID_SESSION_ID))).toBeNull();
      expect(authenticate(authRequest(db, VALID_SESSION_ID))).toBeNull();
    });
  });

  it("停用账号的会话返回 null（disabled=0 才放行）", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u4", FIXED_NOW + 1);
      const before = sessionSnapshot(db);

      expect(authenticate(authRequest(db, VALID_SESSION_ID))).toBeNull();
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it("非过期/未知/停用路径零写入：INSERT/UPDATE 被拒仍通过，快照逐值不变", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 1);
      insertSessionRow(db, OTHER_VALID_SESSION_ID, "u2", FIXED_NOW + 1);
      insertSessionRow(db, "e".repeat(64), "u4", FIXED_NOW + 1);
      const beforeSessions = sessionSnapshot(db);
      const beforeAccounts = accountSnapshot(db);

      // 写/改/插一律 deny：任何 lazy 清理之外的 INSERT/UPDATE 都会被 authorizer 揭穿。
      db.setAuthorizer((actionCode) =>
        actionCode === constants.SQLITE_INSERT || actionCode === constants.SQLITE_UPDATE
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      try {
        authenticate(authRequest(db, VALID_SESSION_ID));
        authenticate(authRequest(db, "f".repeat(64)));
        authenticate(authRequest(db, "g".repeat(64)));
        authenticate(authRequest(db, "e".repeat(64)));
      } finally {
        db.setAuthorizer(null);
      }

      expect(sessionSnapshot(db)).toEqual(beforeSessions);
      expect(accountSnapshot(db)).toEqual(beforeAccounts);
    });
  });
});

/**
 * Issue #10：`authenticate` 的 exact expired-row 惰性清理与共享 owned DELETE 事务纪律。
 * 清理只按 `id + expires_at<=now` 定点发生；HTTP 面（me/logout/cookie）在
 * auth-lifecycle.test.ts 验收。
 */
describe("authenticate 过期 exact row 惰性清理", () => {
  const INT64_MAX = 9_223_372_036_854_775_807n;
  const BEYOND_SAFE = BigInt(Number.MAX_SAFE_INTEGER) + 2n;

  /** CAST 快照：int64 满量程行也逐值可比，不经 JS number 投影。 */
  function castSnapshot(db: DatabaseSync) {
    return db
      .prepare(
        "SELECT id, user_id, CAST(expires_at AS TEXT) AS expires_at FROM auth_sessions ORDER BY id",
      )
      .all();
  }

  function castRow(id: string, userId: string, expiresAt: number | bigint) {
    return { id, user_id: userId, expires_at: String(expiresAt) };
  }

  it.each([
    ["恰等过期（== now）", FIXED_NOW],
    ["已过期（< now）", FIXED_NOW - 60_000],
  ])("%s 的 exact 行被定点删除并返回 null；siblings 与 accounts 逐值不变", (_name, expiresAt) => {
    withDb((db) => {
      const matched = "a".repeat(64);
      const siblingFuture = "b".repeat(64);
      const siblingExpired = "c".repeat(64);
      insertSessionRow(db, matched, "u1", expiresAt);
      insertSessionRow(db, siblingFuture, "u2", FIXED_NOW + 1);
      insertSessionRow(db, siblingExpired, "u3", FIXED_NOW - 1);
      const beforeAccounts = accountSnapshot(db);

      expect(authenticate(authRequest(db, matched))).toBeNull();
      expect(castSnapshot(db)).toEqual([
        castRow(siblingFuture, "u2", FIXED_NOW + 1),
        castRow(siblingExpired, "u3", FIXED_NOW - 1),
      ]);
      expect(accountSnapshot(db)).toEqual(beforeAccounts);
      expect(db.isTransaction).toBe(false);
    });
  });

  function totalChanges(db: DatabaseSync): number {
    return (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
  }

  it("清理覆盖账号状态：expired 的 enabled/disabled/orphan exact 行都被删除", () => {
    withDb((db) => {
      const expiredOrphan = "d".repeat(64);
      insertSessionRow(db, "a".repeat(64), "u1", FIXED_NOW - 1);
      insertSessionRow(db, "b".repeat(64), "u4", FIXED_NOW);
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        insertSessionRow(db, expiredOrphan, "ghost", FIXED_NOW - 9);
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }

      for (const id of ["a".repeat(64), "b".repeat(64), expiredOrphan]) {
        expect(authenticate(authRequest(db, id))).toBeNull();
      }
      expect(castSnapshot(db)).toEqual([]);
    });
  });

  it("重复调用不再写入（恰一行被删）；未知/畸形 cookie 从不触发 DELETE", () => {
    withDb((db) => {
      const matched = "a".repeat(64);
      const survivor = "b".repeat(64);
      insertSessionRow(db, matched, "u1", FIXED_NOW - 1);
      insertSessionRow(db, survivor, "u2", FIXED_NOW - 2);
      const changesBefore = totalChanges(db);

      expect(authenticate(authRequest(db, matched))).toBeNull();
      expect(authenticate(authRequest(db, matched))).toBeNull();
      expect(authenticate(authRequest(db, "f".repeat(64)))).toBeNull();
      expect(authenticate(authRequest(db, "g".repeat(64)))).toBeNull();
      expect(castSnapshot(db)).toEqual([castRow(survivor, "u2", FIXED_NOW - 2)]);
      expect(totalChanges(db) - changesBefore).toBe(1);
    });
  });

  /**
   * 真实 DB 竞态接缝：authorizer 在 DELETE 语句绑参时被 SQLite 调用（即"分类之后、
   * 删除之前"），此时另一个写者把该行续期 → `id + expires_at<=now` 条件谓词不再成立，
   * DELETE 以 0 行收据提交为 no-op。去掉条件谓词的实现会照删不误（快照变空）而暴露。
   */
  function renewOnDeleteBinding(db: DatabaseSync, id: string, expiresAt: number): void {
    db.setAuthorizer((actionCode, arg1) => {
      if (actionCode === constants.SQLITE_DELETE && arg1 === "auth_sessions") {
        db.prepare("UPDATE auth_sessions SET expires_at = ? WHERE id = ?").run(expiresAt, id);
      }
      return constants.SQLITE_OK;
    });
  }

  it("conditional DELETE 竞争丢失（receipt 0）：续期竞态仍返回 null 并保留该行，不 5xx/不假装删除", () => {
    withDb((db) => {
      const matched = "a".repeat(64);
      const sibling = "b".repeat(64);
      insertSessionRow(db, matched, "u1", FIXED_NOW - 1);
      insertSessionRow(db, sibling, "u2", FIXED_NOW + 5);
      const changesBefore = totalChanges(db);
      try {
        renewOnDeleteBinding(db, matched, FIXED_NOW + 3_600_000);
        expect(authenticate(authRequest(db, matched))).toBeNull();
      } finally {
        db.setAuthorizer(null);
      }
      expect(castSnapshot(db)).toEqual([
        castRow(matched, "u1", FIXED_NOW + 3_600_000),
        castRow(sibling, "u2", FIXED_NOW + 5),
      ]);
      // 只有竞态续期的 1 次写入被提交：条件 DELETE 以 0 行收据提交为 no-op
      expect(totalChanges(db) - changesBefore).toBe(1);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("DELETE 行被触发器跳过（RAISE(IGNORE)）时同样按 0 行收据提交为 no-op", () => {
    withDb((db) => {
      const matched = "a".repeat(64);
      insertSessionRow(db, matched, "u1", FIXED_NOW - 1);
      db.exec(
        `CREATE TRIGGER renewal_race BEFORE DELETE ON auth_sessions
         BEGIN UPDATE auth_sessions SET expires_at = ${FIXED_NOW + 3_600_000} WHERE id = '${matched}'; SELECT RAISE(IGNORE); END`,
      );
      try {
        expect(authenticate(authRequest(db, matched))).toBeNull();
      } finally {
        db.exec("DROP TRIGGER renewal_race");
      }
      expect(castSnapshot(db)).toEqual([castRow(matched, "u1", FIXED_NOW + 3_600_000)]);
      expect(db.isTransaction).toBe(false);
    });
  });

  it.each([
    ["SQLite int64 上界", INT64_MAX],
    ["安全整数上界之外", BEYOND_SAFE],
  ] as const)("future expiry %s 在 SQLite 内分类，不投影为 JS number 也不抛错", (_name, expiry) => {
    withDb((db) => {
      const id = "a".repeat(64);
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        insertSessionRow(db, id, "u1", expiry);
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }

      expect(() => authenticate(authRequest(db, id))).not.toThrow();
      expect(authenticate(authRequest(db, id))).toEqual({
        id: "u1",
        account: "zhangsan",
        role: "成员",
      });
      expect(castSnapshot(db)).toEqual([castRow(id, "u1", expiry)]);
    });
  });

  it("future 的 int64 上界行即使账号停用/orphan 也不删行", () => {
    withDb((db) => {
      const disabled = "a".repeat(64);
      const orphan = "b".repeat(64);
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        insertSessionRow(db, disabled, "u4", INT64_MAX);
        insertSessionRow(db, orphan, "ghost", BEYOND_SAFE);
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
      const before = castSnapshot(db);

      expect(authenticate(authRequest(db, disabled))).toBeNull();
      expect(authenticate(authRequest(db, orphan))).toBeNull();
      expect(castSnapshot(db)).toEqual(before);
    });
  });

  it("now 逼近安全上界时仍由 SQLite 判定：非法 now 不查询，合法相等 now 删除", () => {
    withDb((db) => {
      const id = "a".repeat(64);
      insertSessionRow(db, id, "u1", Number.MAX_SAFE_INTEGER);
      // now = MAX_SAFE_INTEGER 本身非法（不安全整数）→ fail closed，不查询不删除
      expect(authenticate(authRequest(db, id, Number.MAX_SAFE_INTEGER + 1))).toBeNull();
      expect(castSnapshot(db)).toEqual([castRow(id, "u1", Number.MAX_SAFE_INTEGER)]);
      // now = MAX_SAFE_INTEGER 合法且与 expires_at 相等 → 过期 → 删除
      expect(authenticate(authRequest(db, id, Number.MAX_SAFE_INTEGER))).toBeNull();
      expect(castSnapshot(db)).toEqual([]);
    });
  });

  it.each([
    ["BEGIN 被拒", constants.SQLITE_TRANSACTION, "BEGIN"],
    ["DELETE 被拒", constants.SQLITE_DELETE, "auth_sessions"],
    ["COMMIT 被拒", constants.SQLITE_TRANSACTION, "COMMIT"],
  ] as const)(
    "清理事务失败（%s）：原始错误上抛（不静默 null）、行不变、事务不残留",
    (_name, actionCode, arg1) => {
      withDb((db) => {
        const matched = "a".repeat(64);
        insertSessionRow(db, matched, "u1", FIXED_NOW - 1);
        const before = castSnapshot(db);

        denyStatement(db, actionCode, arg1);
        try {
          expect(() => authenticate(authRequest(db, matched))).toThrow(/not authorized/u);
        } finally {
          db.setAuthorizer(null);
        }
        expect(db.isTransaction).toBe(false);
        expect(castSnapshot(db)).toEqual(before);
      });
    },
  );

  it("清理 ROLLBACK 也失败：AggregateError 保留 original+rollback/cause，事务仍活跃供调用方恢复", () => {
    withDb((db) => {
      const matched = "a".repeat(64);
      insertSessionRow(db, matched, "u1", FIXED_NOW - 1);
      db.exec(
        `CREATE TRIGGER delete_guard BEFORE DELETE ON auth_sessions
         BEGIN SELECT RAISE(ABORT, 'probe delete blocked'); END`,
      );
      denyStatement(db, constants.SQLITE_TRANSACTION, "ROLLBACK");

      let caught: unknown;
      try {
        authenticate(authRequest(db, matched));
      } catch (error) {
        caught = error;
      } finally {
        db.setAuthorizer(null);
        expect(db.isTransaction).toBe(true);
        db.exec("ROLLBACK");
        db.exec("DROP TRIGGER delete_guard");
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.message).toBe("session delete rollback failed");
      expect(aggregate.errors.map((error) => (error as Error).message)).toEqual([
        "probe delete blocked",
        "not authorized",
      ]);
      expect(aggregate.cause).toBe(aggregate.errors[0]);
    });
  });

  it("caller 拥有事务时清理 BEGIN 失败：错误上抛且 caller 事务/效果活跃不变", () => {
    withDb((db) => {
      const matched = "a".repeat(64);
      insertSessionRow(db, matched, "u1", FIXED_NOW - 1);
      const callerId = "b".repeat(64);

      db.exec("BEGIN");
      try {
        insertSessionRow(db, callerId, "u2", FIXED_NOW + 3);
        expect(() => authenticate(authRequest(db, matched))).toThrow(
          /cannot start a transaction within a transaction/u,
        );
        expect(db.isTransaction).toBe(true);
        expect(castSnapshot(db)).toEqual([
          castRow(matched, "u1", FIXED_NOW - 1),
          castRow(callerId, "u2", FIXED_NOW + 3),
        ]);
      } finally {
        db.exec("ROLLBACK");
      }
      expect(castSnapshot(db)).toEqual([castRow(matched, "u1", FIXED_NOW - 1)]);
      expect(db.isTransaction).toBe(false);
    });
  });
});

describe("authenticate 与 createApp 共享同一时钟源（装饰）", () => {
  it("写入时使用的 authRuntime.now 可在 request.server.authNow 上被 authenticate 消费", async () => {
    const db = openDb(":memory:");
    const app: FastifyInstance = createApp({
      db,
      authRuntime: { now: () => FIXED_NOW, randomBytes: (size) => Buffer.alloc(size, 0x5a) },
    });
    app.get("/api/test/whoami", (request) => authenticate(request));

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: JSON.stringify({ account: "zhangsan", password: "demo" }),
        headers: { "content-type": "application/json" },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.headers["set-cookie"];
      if (typeof cookie !== "string") {
        throw new Error(`login response has no session cookie: ${String(cookie)}`);
      }
      const cookieHeader = cookie.split(";")[0];
      if (cookieHeader === undefined) {
        throw new Error("login response has no session cookie");
      }

      const whoami = await app.inject({
        method: "GET",
        url: "/api/test/whoami",
        headers: { cookie: cookieHeader },
      });
      expect(whoami.statusCode).toBe(200);
      expect(whoami.json()).toEqual({ id: "u1", account: "zhangsan", role: "成员" });
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("session generator / expiry / cookie parse", () => {
  it("DEFAULT_AUTH_RUNTIME 被冻结且函数身份恰为 Date.now 与 import 的 node:crypto randomBytes", () => {
    expect(Object.isFrozen(DEFAULT_AUTH_RUNTIME)).toBe(true);
    expect(DEFAULT_AUTH_RUNTIME.now).toBe(Date.now);
    expect(DEFAULT_AUTH_RUNTIME.randomBytes).toBe(nodeRandomBytes);
    expect(() => {
      (DEFAULT_AUTH_RUNTIME as { now: () => number }).now = () => 0;
    }).toThrow(TypeError);
    expect(DEFAULT_AUTH_RUNTIME.now).toBe(Date.now);
  });

  it("生产默认源锚 = crypto.randomBytes(32)，输出 exact 64 lowercase hex", () => {
    const id = generateSessionId((size) => {
      expect(size).toBe(32);
      return nodeRandomBytes(size);
    });

    expect(id).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("注入源只调用一次且 size=32，输出 exact 64 lowercase hex（0x5a 源）", () => {
    let calls = 0;
    const id = generateSessionId((size) => {
      calls += 1;
      expect(size).toBe(32);
      return Buffer.alloc(32, 0x5a);
    });

    expect(calls).toBe(1);
    expect(id).toBe("5a".repeat(32));
    expect(id).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("31/33 字节或非 Buffer 输出在写前抛错", () => {
    expect(() => generateSessionId(() => Buffer.alloc(31, 1))).toThrow(
      "session id generator must receive exactly 32 random bytes",
    );
    expect(() => generateSessionId(() => Buffer.alloc(33, 1))).toThrow(
      "session id generator must receive exactly 32 random bytes",
    );
    expect(() => generateSessionId(() => "not-a-buffer" as unknown as Buffer)).toThrow(
      "session id generator must receive exactly 32 random bytes",
    );
  });

  it("session 过期 = now + 604800000，必须是非负安全整数", () => {
    expect(sessionExpiry(0)).toBe(604_800_000);
    expect(sessionExpiry(1_700_000_000_000)).toBe(1_700_604_800_000);
    expect(SESSION_TTL).toBe(604_800_000);

    expect(() => sessionExpiry(-1)).toThrow("nonnegative safe integer");
    expect(() => sessionExpiry(1.5)).toThrow("nonnegative safe integer");
    expect(() => sessionExpiry(Number.NaN)).toThrow("nonnegative safe integer");
    expect(() => sessionExpiry(Number.MAX_SAFE_INTEGER)).toThrow("overflow");
  });

  it("sessionIdFromCookies 只接受 own exact 名 + 64 lowercase hex；原型继承视为不存在", () => {
    const cookies = { [SESSION_COOKIE]: VALID_SESSION_ID };
    expect(sessionIdFromCookies(cookies)).toBe(VALID_SESSION_ID);
    expect(sessionIdFromCookies({ [SESSION_COOKIE]: "A".repeat(64) })).toBeUndefined();
    expect(sessionIdFromCookies({ [SESSION_COOKIE]: "short" })).toBeUndefined();
    expect(sessionIdFromCookies({ wrong: VALID_SESSION_ID })).toBeUndefined();
    expect(sessionIdFromCookies(undefined)).toBeUndefined();
    expect(sessionIdFromCookies({})).toBeUndefined();

    const inherited = Object.create({ [SESSION_COOKIE]: VALID_SESSION_ID });
    expect(Object.hasOwn(inherited, SESSION_COOKIE)).toBe(false);
    expect(sessionIdFromCookies(inherited)).toBeUndefined();
    expect(sessionIdFromCookies(Object.create(null))).toBeUndefined();
  });

  it("insertSession 单事务写一行；第二次插入相同 id 抛错并保持完整快照", () => {
    withDb((db) => {
      insertSession(db, { id: VALID_SESSION_ID, userId: "u1", expiresAt: FIXED_NOW + 1 });
      expect(sessionSnapshot(db)).toEqual([
        { id: VALID_SESSION_ID, user_id: "u1", expires_at: FIXED_NOW + 1 },
      ]);
      const before = sessionSnapshot(db);

      expect(() =>
        insertSession(db, { id: VALID_SESSION_ID, userId: "u2", expiresAt: FIXED_NOW + 2 }),
      ).toThrow(/UNIQUE constraint failed/);
      expect(sessionSnapshot(db)).toEqual(before);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("insertSession 未知 user_id（FK）抛错并回滚，快照不变", () => {
    withDb((db) => {
      expect(() =>
        insertSession(db, { id: VALID_SESSION_ID, userId: "missing", expiresAt: FIXED_NOW + 1 }),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(sessionSnapshot(db)).toEqual([]);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("COMMIT 失败（deferred FK 冲突）回滚并保留完整既有快照", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 1);
      const before = sessionSnapshot(db);

      // 真实 SQLite 接缝：defer 使 FK 检查推迟到 COMMIT，从而得到可达的 COMMIT 失败
      db.exec("PRAGMA defer_foreign_keys = ON");
      expect(() =>
        insertSession(db, {
          id: OTHER_VALID_SESSION_ID,
          userId: "missing",
          expiresAt: FIXED_NOW + 1,
        }),
      ).toThrow(/FOREIGN KEY constraint failed/);
      db.exec("PRAGMA defer_foreign_keys = OFF");

      expect(sessionSnapshot(db)).toEqual(before);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("ROLLBACK 本身失败（authorizer deny）：抛 AggregateError 含 original+rollback，cause=original，事务仍活跃", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 1);

      db.setAuthorizer((actionCode, arg1) => {
        if (actionCode === constants.SQLITE_TRANSACTION && arg1 === "ROLLBACK") {
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      });

      try {
        let caught: unknown;
        try {
          insertSession(db, { id: VALID_SESSION_ID, userId: "u2", expiresAt: FIXED_NOW + 2 });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(AggregateError);
        const aggregate = caught as AggregateError;
        expect(aggregate.errors).toHaveLength(2);
        expect(aggregate.errors[0]).toBeInstanceOf(Error);
        expect((aggregate.errors[0] as Error).message).toMatch(/UNIQUE constraint failed/);
        expect(aggregate.errors[1]).toBeInstanceOf(Error);
        expect((aggregate.errors[1] as Error).message).toMatch(/not authorized/);
        expect(aggregate.cause).toBe(aggregate.errors[0]);
        expect(aggregate.message).toBe("session insert rollback failed");
        expect(db.isTransaction).toBe(true);
        expect(sessionSnapshot(db).length).toBeGreaterThan(0);
      } finally {
        db.setAuthorizer(null);
        db.exec("ROLLBACK");
        expect(db.isTransaction).toBe(false);
      }
    });
  });

  it("caller 已拥有事务时 insertSession BEGIN 失败：caller 事务/效果保持活跃不变", () => {
    withDb((db) => {
      insertSessionRow(db, VALID_SESSION_ID, "u1", FIXED_NOW + 1);
      const before = sessionSnapshot(db);

      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)").run(
          OTHER_VALID_SESSION_ID,
          "u3",
          FIXED_NOW + 3,
        );

        expect(() =>
          insertSession(db, { id: "f".repeat(64), userId: "u1", expiresAt: FIXED_NOW + 4 }),
        ).toThrow(/cannot start a transaction within a transaction/u);

        expect(db.isTransaction).toBe(true);
        // sessionSnapshot 按 id 排序：OTHER_VALID_SESSION_ID(0123...) 先于 VALID_SESSION_ID(5777...)
        expect(sessionSnapshot(db)).toEqual([
          { id: OTHER_VALID_SESSION_ID, user_id: "u3", expires_at: FIXED_NOW + 3 },
          ...before,
        ]);
      } finally {
        db.exec("ROLLBACK");
      }
      expect(sessionSnapshot(db)).toEqual(before);
      expect(db.isTransaction).toBe(false);
    });
  });
});
