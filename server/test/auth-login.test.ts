import { scrypt as realScrypt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AuthRuntime, PasswordSource } from "../src/auth/index.js";
import { openDb } from "../src/core/db/index.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_SESSION_ID = "5a".repeat(32);
const FIXED_COOKIE =
  "workbuddy_session=5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a; Path=/; HttpOnly; SameSite=Lax";
const FIXED_COOKIE_SECURE =
  "workbuddy_session=5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a; Path=/; HttpOnly; Secure; SameSite=Lax";
const CREDENTIAL_FAILURE_ENVELOPE = {
  error: { code: "invalid_credentials", message: "账号或密码不正确" },
};
const DISABLED_ENVELOPE = {
  error: { code: "account_disabled", message: "该账号已停用，请联系管理员" },
};
const BAD_REQUEST_ENVELOPE = {
  error: { code: "bad_request", message: "请求格式不正确" },
};
const INTERNAL_ERROR_ENVELOPE = { error: { message: "服务器内部错误" } };
const VALID_SESSION_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function fixedAuthRuntime(): AuthRuntime {
  return {
    now: () => FIXED_NOW,
    randomBytes: (size: number) => {
      expect(size).toBe(32);
      return Buffer.alloc(32, 0x5a);
    },
  };
}

/** 每个请求返回不同字节的确定性源：证明重复登录生成独立、非相邻的 ID。 */
function makeCounterSource(seed: number): (size: number) => Buffer {
  let counter = 0;
  return (size: number) => {
    const bytes = Buffer.alloc(size);
    bytes.fill((seed + counter) & 0xff);
    counter += 1;
    return bytes;
  };
}

async function withLoginApp<T>(
  options: {
    secureCookies?: boolean;
    authRuntime?: AuthRuntime;
    passwordSource?: PasswordSource;
  },
  action: (app: FastifyInstance, db: DatabaseSync) => Promise<T>,
): Promise<T> {
  const db = openDb(":memory:");
  let app: FastifyInstance | undefined;
  try {
    app = createApp({
      db,
      ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }),
      authRuntime: options.authRuntime ?? fixedAuthRuntime(),
      ...(options.passwordSource === undefined ? {} : { passwordSource: options.passwordSource }),
    });
    return await action(app, db);
  } finally {
    try {
      await app?.close();
    } finally {
      db.close();
    }
  }
}

function realScryptDerive(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    realScrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

interface DerivationInvocation {
  password: string;
  salt: Buffer;
  keyLength: number;
  options: { N: number; r: number; p: number };
}

function makeCountingSource(invocations: DerivationInvocation[]): PasswordSource {
  return async (password, salt, keyLength, options) => {
    invocations.push({ password, salt, keyLength, options });
    return realScryptDerive(password, salt, keyLength, options);
  };
}

function expectIdsNotAdjacent(ids: readonly string[]): void {
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const delta = BigInt(`0x${ids[left] ?? "0"}`) - BigInt(`0x${ids[right] ?? "0"}`);
      expect(delta < 0n ? -delta : delta).toBeGreaterThan(1n);
    }
  }
}

async function expectBadRequest(
  app: FastifyInstance,
  db: DatabaseSync,
  payload: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<void> {
  const response = await postLogin(app, payload, headers);
  expect(response.statusCode).toBe(400);
  expect(response.payload).toBe(JSON.stringify(BAD_REQUEST_ENVELOPE));
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(sessionCount(db)).toBe(0);
}

async function expectServerError(
  app: FastifyInstance,
  payload: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<void> {
  const response = await postLogin(app, payload, headers);
  expect(response.statusCode).toBeGreaterThanOrEqual(500);
  expect(response.statusCode).toBeLessThan(600);
  expect(response.payload).toBe(JSON.stringify(INTERNAL_ERROR_ENVELOPE));
  expect(response.headers["set-cookie"]).toBeUndefined();
}

function loginPayload(account: string, password: string): string {
  return JSON.stringify({ account, password });
}

async function postLogin(
  app: FastifyInstance,
  payload: string | undefined,
  headers: Record<string, string> = { "content-type": "application/json" },
) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    ...(payload === undefined ? {} : { payload }),
    headers,
  });
}

async function expectFailure(
  app: FastifyInstance,
  payload: string | undefined,
  envelope: { error: { code: string; message: string } },
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<void> {
  const response = await postLogin(app, payload, headers);
  const expectedStatus =
    envelope.error.code === "account_disabled"
      ? 403
      : envelope.error.code === "bad_request"
        ? 400
        : 401;
  expect(response.statusCode).toBe(expectedStatus);
  expect(response.payload).toBe(JSON.stringify(envelope));
  expect(response.json()).toEqual(envelope);
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(response.payload).not.toContain("demo");
}

function sessions(db: DatabaseSync): Array<{ id: string; user_id: string; expires_at: number }> {
  return db
    .prepare("SELECT id, user_id, expires_at FROM auth_sessions ORDER BY id")
    .all() as unknown as Array<{ id: string; user_id: string; expires_at: number }>;
}

function sessionCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get() as { count: number })
    .count;
}

function seedExistingSession(
  db: DatabaseSync,
): { id: string; user_id: string; expires_at: number }[] {
  const row = { id: VALID_SESSION_ID, user_id: "u2", expires_at: FIXED_NOW + 604_800_000 };
  db.prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)").run(
    row.id,
    row.user_id,
    row.expires_at,
  );
  return [row];
}

async function expectFaultPreservesSessions(
  app: FastifyInstance,
  db: DatabaseSync,
  payload: string,
): Promise<void> {
  const before = seedExistingSession(db);
  await expectServerError(app, payload);
  expect(sessions(db)).toEqual(before);
}

function expectOneDummyDerivation(
  invocations: readonly DerivationInvocation[],
  password: string,
): void {
  expect(invocations).toHaveLength(1);
  expect(invocations[0]?.password).toBe(password);
  expect(invocations[0]?.salt.toString("hex")).toBe("00000000000000000000000000000000");
  expect(invocations[0]?.keyLength).toBe(32);
  expect(invocations[0]?.options).toEqual({ N: 16384, r: 8, p: 1 });
}

function responseCookie(response: { headers: Record<string, unknown> }): string {
  const cookie = response.headers["set-cookie"];
  if (typeof cookie !== "string") {
    throw new Error(`expected a single Set-Cookie header, got ${String(cookie)}`);
  }
  return cookie;
}

function cookieSessionId(cookie: string): string {
  const id = cookie.split(";")[0]?.split("=")[1];
  if (id === undefined) {
    throw new Error(`cookie has no value: ${cookie}`);
  }
  return id;
}

describe("POST /api/auth/login via createApp", () => {
  it.each([
    ["zhangsan", "demo", "u1", "zhangsan", "成员"],
    ["zhaoliu", "demo", "u2", "zhaoliu", "成员"],
    ["lisi", "demo", "u3", "lisi", "管理员"],
  ] as const)(
    "正确凭证 %s 登录成功并建立唯一会话行与精确 cookie",
    async (account, password, userId, canonicalAccount, role) => {
      await withLoginApp({}, async (app, db) => {
        const response = await postLogin(app, loginPayload(account, password));

        expect(response.statusCode).toBe(200);
        expect(response.payload).toBe(
          JSON.stringify({ id: userId, account: canonicalAccount, role }),
        );
        expect(response.json()).toEqual({ id: userId, account: canonicalAccount, role });
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["set-cookie"]).toBe(FIXED_COOKIE);
        expect(sessions(db)).toEqual([
          { id: FIXED_SESSION_ID, user_id: userId, expires_at: FIXED_NOW + 604_800_000 },
        ]);
        expect(response.payload).not.toContain(password);
        expect(response.payload).not.toContain(FIXED_SESSION_ID);
      });
    },
  );

  it('规范化 "  ZhangSan " 匹配 zhangsan 并写 canonical 会话行', async () => {
    await withLoginApp({}, async (app, db) => {
      const response = await postLogin(app, loginPayload("  ZhangSan ", "demo"));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: "u1", account: "zhangsan", role: "成员" });
      expect(response.headers["set-cookie"]).toBe(FIXED_COOKIE);
      expect(sessions(db)).toEqual([
        { id: FIXED_SESSION_ID, user_id: "u1", expires_at: FIXED_NOW + 604_800_000 },
      ]);
    });
  });

  it("unknown、whitespace-only 与 wrong password 返回同一 401 且无 cookie/会话", async () => {
    await withLoginApp({}, async (app, db) => {
      for (const payload of [
        loginPayload("nobody", "demo"),
        loginPayload("   ", "demo"),
        loginPayload("zhangsan", "wrong-password"),
      ]) {
        await expectFailure(app, payload, CREDENTIAL_FAILURE_ENVELOPE);
      }
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("wangwu 正确密码返回 403 停用，错误密码返回 401 且不建会话", async () => {
    await withLoginApp({}, async (app, db) => {
      await expectFailure(app, loginPayload("wangwu", "demo"), DISABLED_ENVELOPE);
      await expectFailure(
        app,
        loginPayload("wangwu", "wrong-password"),
        CREDENTIAL_FAILURE_ENVELOPE,
      );
      expect(sessionCount(db)).toBe(0);
    });
  });

  it.each([
    ["额外字段", loginPayload("zhangsan", "demo").replace('"account"', '"extra":1,"account"')],
    ["account 为数字", JSON.stringify({ account: 5, password: "demo" })],
    ["password 为布尔", JSON.stringify({ account: "zhangsan", password: true })],
    ["缺失 account", JSON.stringify({ password: "demo" })],
    ["缺失 password", JSON.stringify({ account: "zhangsan" })],
    ["null body", "null"],
    ["数组 body", '["account","password"]'],
    ["字符串 body", '"just-a-string"'],
  ] as const)("请求形状 %s 精确 400 且不写会话", async (_name, payload) => {
    await withLoginApp({}, async (app, db) => {
      await expectFailure(app, payload, BAD_REQUEST_ENVELOPE);
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("完全没有 body 且无 content-type 精确 400 且不写会话", async () => {
    await withLoginApp({}, async (app, db) => {
      await expectFailure(app, undefined, BAD_REQUEST_ENVELOPE, {});
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("account 超过 256 code units 与 password 超过 1024 code units 均为 400，KDF 0 次、无 Set-Cookie、无新增会话", async () => {
    const invocations: DerivationInvocation[] = [];
    await withLoginApp({ passwordSource: makeCountingSource(invocations) }, async (app, db) => {
      const longAccount = `a${"x".repeat(256)}`;
      const longPassword = `a${"x".repeat(1024)}`;
      await expectFailure(app, loginPayload(longAccount, "demo"), BAD_REQUEST_ENVELOPE);
      await expectFailure(app, loginPayload("zhangsan", longPassword), BAD_REQUEST_ENVELOPE);
      expect(invocations).toHaveLength(0);
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("raw account 恰 256 与 raw password 恰 1024：shape-valid 各恰好一次 KDF，确定性 401，无 Set-Cookie、auth_sessions 不变", async () => {
    const exactAccount = "a".repeat(256);
    const exactPassword = "p".repeat(1024);
    const invocations: DerivationInvocation[] = [];

    await withLoginApp({ passwordSource: makeCountingSource(invocations) }, async (app, db) => {
      const beforeSessions = seedExistingSession(db);

      const accountAtMax = await postLogin(app, loginPayload(exactAccount, "demo"));
      expect(accountAtMax.statusCode).toBe(401);
      expect(accountAtMax.payload).toBe(JSON.stringify(CREDENTIAL_FAILURE_ENVELOPE));
      expect(accountAtMax.headers["set-cookie"]).toBeUndefined();
      expectOneDummyDerivation(invocations, "demo");

      invocations.length = 0;
      const passwordAtMax = await postLogin(app, loginPayload("no-such-account", exactPassword));
      expect(passwordAtMax.statusCode).toBe(401);
      expect(passwordAtMax.payload).toBe(JSON.stringify(CREDENTIAL_FAILURE_ENVELOPE));
      expect(passwordAtMax.headers["set-cookie"]).toBeUndefined();
      expectOneDummyDerivation(invocations, exactPassword);

      expect(sessions(db)).toEqual(beforeSessions);
    });
  });

  it("malformed JSON 稳定映射 400 bad_request，不带 parser 细节", async () => {
    await withLoginApp({}, async (app, db) => {
      const response = await postLogin(app, '{"account": ', {
        "content-type": "application/json",
      });
      expect(response.statusCode).toBe(400);
      expect(response.payload).toBe(JSON.stringify(BAD_REQUEST_ENVELOPE));
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.payload).not.toContain("FST_ERR");
      expect(response.payload).not.toContain("Body is not valid JSON");
      expect(response.payload).not.toContain("demo");
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("unsupported media 类型稳定映射 400 bad_request", async () => {
    await withLoginApp({}, async (app, db) => {
      await expectBadRequest(app, db, "not-json", { "content-type": "application/octet-stream" });
    });
  });

  it("text/plain 被 Fastify 解析为 string 后由手写 validator 拒绝为 400", async () => {
    await withLoginApp({}, async (app, db) => {
      await expectBadRequest(app, db, "account=zhangsan&password=demo", {
        "content-type": "text/plain",
      });
    });
  });

  it("body 超过 16 KiB 将 Fastify 原始 413 归一为 exact 400", async () => {
    await withLoginApp({}, async (app, db) => {
      await expectBadRequest(app, db, `{"account":"${"x".repeat(17_000)}","password":"demo"}`);
    });
  });

  it("响应 cookie 属性精确且默认无 Secure，secureCookies=true 增加 Secure", async () => {
    await withLoginApp({}, async (app) => {
      const response = await postLogin(app, loginPayload("zhangsan", "demo"));
      const cookie = responseCookie(response);
      expect(cookie).toBe(FIXED_COOKIE);
      expect(cookie).not.toContain("Domain");
      expect(cookie).not.toContain("Expires");
      expect(cookie).not.toContain("Max-Age");
    });

    await withLoginApp({ secureCookies: true }, async (app) => {
      const response = await postLogin(app, loginPayload("zhangsan", "demo"));
      expect(responseCookie(response)).toBe(FIXED_COOKIE_SECURE);
    });

    await withLoginApp({ secureCookies: false }, async (app) => {
      const response = await postLogin(app, loginPayload("zhangsan", "demo"));
      expect(responseCookie(response)).toBe(FIXED_COOKIE);
      expect(responseCookie(response)).not.toContain("Secure");
    });
  });

  it("重复登录建立独立会话行，ID 均 64 lowercase hex、唯一且不相邻", async () => {
    await withLoginApp(
      { authRuntime: { now: () => FIXED_NOW, randomBytes: makeCounterSource(0x11) } },
      async (app, db) => {
        const responses = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          responses.push(await postLogin(app, loginPayload("zhangsan", "demo")));
        }
        for (const response of responses) {
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ id: "u1", account: "zhangsan", role: "成员" });
        }
        const rows = sessions(db);
        expect(rows).toHaveLength(3);
        const ids = rows.map((row) => row.id);
        expect(new Set(ids).size).toBe(3);
        expect(ids.every((id) => /^[0-9a-f]{64}$/u.test(id))).toBe(true);
        expectIdsNotAdjacent(ids);
        for (const response of responses) {
          const cookieId = cookieSessionId(responseCookie(response));
          expect(rows.some((row) => row.id === cookieId)).toBe(true);
          expect(response.payload).not.toContain(cookieId);
        }
      },
    );
  });

  it("多个 production 默认源登录：会话 ID 均 64 lowercase hex、互不相同且非相邻数值", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db });
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await postLogin(app, loginPayload("zhangsan", "demo"));
        expect(response.statusCode).toBe(200);
        const cookie = responseCookie(response);
        expect(cookie).toMatch(/^workbuddy_session=[0-9a-f]{64};/u);
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Lax");
        expect(cookie).toContain("Path=/");
        expect(cookie).not.toContain("Secure");
      }
      const ids = sessions(db).map((row) => row.id);
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
      expect(ids.every((id) => /^[0-9a-f]{64}$/u.test(id))).toBe(true);
      expectIdsNotAdjacent(ids);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("并发 async 登录尝试不交叉绑定 Principal/cookie/session", async () => {
    await withLoginApp(
      { authRuntime: { now: () => FIXED_NOW, randomBytes: makeCounterSource(0x21) } },
      async (app, db) => {
        const responses = await Promise.all([
          postLogin(app, loginPayload("zhangsan", "demo")),
          postLogin(app, loginPayload("zhaoliu", "demo")),
        ]);

        for (const response of responses) {
          expect(response.statusCode).toBe(200);
          expect(response.headers["cache-control"]).toBe("no-store");
        }
        const rows = sessions(db);
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.id)).size).toBe(2);
        expect(rows.map((row) => row.user_id).sort()).toEqual(["u1", "u2"]);

        // 每个响应的 Principal.id 必须绑定该响应自己的 cookie session ID 对应的行：
        // 若两个 cookie 被交换而 aggregate rows 仍含 u1/u2，此断言失败。
        for (const response of responses) {
          const principal = response.json() as { id: string; account: string; role: string };
          const cookieId = cookieSessionId(responseCookie(response));
          const row = db
            .prepare("SELECT id, user_id FROM auth_sessions WHERE id = ?")
            .get(cookieId) as { id: string; user_id: string } | undefined;
          expect(row).toBeDefined();
          expect(row?.user_id).toBe(principal.id);
        }
      },
    );
  });

  it("session ID 碰撞/约束失败回滚、无 cookie、generic 5xx 且既有行不变", async () => {
    await withLoginApp({}, async (app, db) => {
      db.prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)").run(
        FIXED_SESSION_ID,
        "u2",
        FIXED_NOW + 604_800_000,
      );
      const before = sessions(db);

      await expectServerError(app, loginPayload("zhangsan", "demo"));
      expect(sessions(db)).toEqual(before);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("畸形存储 encoding 是 generic 5xx，无 cookie/会话且不泄漏 encoding", async () => {
    await withLoginApp({}, async (app, db) => {
      db.exec("PRAGMA ignore_check_constraints = ON");
      try {
        db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(
          "not-a-scrypt-hash",
          "u1",
        );
      } finally {
        db.exec("PRAGMA ignore_check_constraints = OFF");
      }

      await expectServerError(app, loginPayload("zhangsan", "demo"));
      expect(db.prepare("SELECT COUNT(*) AS c FROM auth_sessions").get()).toEqual({ c: 0 });
    });
  });

  it.each([
    ["负数时钟", (): number => -1],
    ["非整数时钟", (): number => 1.5],
    ["非有限时钟", (): number => Number.NaN],
    ["溢出时钟", (): number => Number.MAX_SAFE_INTEGER],
  ] as const)(
    "%s 是 generic 5xx，写会话与 cookie 前失败，auth_sessions 不变",
    async (_name, now) => {
      await withLoginApp(
        { authRuntime: { now, randomBytes: (size) => Buffer.alloc(size, 1) } },
        async (app, db) => {
          await expectFaultPreservesSessions(app, db, loginPayload("zhangsan", "demo"));
        },
      );
    },
  );

  it.each([
    ["31 字节随机", (size: number) => Buffer.alloc(size - 1, 1)],
    ["33 字节随机", (size: number) => Buffer.alloc(size + 1, 1)],
    ["非 Buffer 输出", () => "not-a-buffer" as unknown as Buffer],
  ] as const)(
    "CSPRNG %s 是 generic 5xx，写会话与 cookie 前失败，auth_sessions 不变",
    async (_name, randomBytes) => {
      await withLoginApp(
        { authRuntime: { now: () => FIXED_NOW, randomBytes } },
        async (app, db) => {
          await expectFaultPreservesSessions(app, db, loginPayload("zhangsan", "demo"));
        },
      );
    },
  );

  it("existing sessions 在失败路径上保持字节级不变", async () => {
    await withLoginApp(
      { authRuntime: { now: () => FIXED_NOW, randomBytes: (size) => Buffer.alloc(size, 1) } },
      async (app, db) => {
        const beforeInsert = sessions(db);
        const beforeAccounts = db.prepare("SELECT * FROM accounts ORDER BY id").all();

        await expectFailure(app, loginPayload("zhangsan", "wrong"), CREDENTIAL_FAILURE_ENVELOPE);
        await expectFailure(app, loginPayload("nobody", "demo"), CREDENTIAL_FAILURE_ENVELOPE);
        expect(sessions(db)).toEqual(beforeInsert);
        expect(db.prepare("SELECT * FROM accounts ORDER BY id").all()).toEqual(beforeAccounts);
      },
    );
  });

  it("app.close() 后 caller 的 DB 仍可查询并自行关闭", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db });
    try {
      const response = await postLogin(app, loginPayload("zhangsan", "demo"));
      expect(response.statusCode).toBe(200);
      await app.close();
      expect(sessionCount(db)).toBe(1);
      db.close();
      expect(() => db.prepare("SELECT 1 FROM auth_sessions").get()).toThrow();
    } finally {
      try {
        await app.close();
      } finally {
        try {
          db.close();
        } catch {
          // Db 已在测试内关闭；重复 close 抛错可接受。
        }
      }
    }
  });

  it("登录 hand-validator 先于 KDF：形状/边界失败时 KDF 调用次数为 0", async () => {
    const invocations: DerivationInvocation[] = [];

    await withLoginApp({ passwordSource: makeCountingSource(invocations) }, async (app, db) => {
      const badShapes = [
        loginPayload("zhangsan", "demo").replace('"account"', '"extra":1,"account"'),
        JSON.stringify({ account: 5, password: "demo" }),
        JSON.stringify({ password: "demo" }),
        "null",
        '["account","password"]',
        '"just-a-string"',
        `{"account":"${"x".repeat(256 + 1)}","password":"demo"}`,
      ];
      for (const payload of badShapes) {
        await expectFailure(app, payload, BAD_REQUEST_ENVELOPE);
      }
      const malformed = await postLogin(app, '{"account": ', {
        "content-type": "application/json",
      });
      expect(malformed.statusCode).toBe(400);
      const tooLarge = await postLogin(
        app,
        `{"account":"${"x".repeat(17_000)}","password":"demo"}`,
      );
      expect(tooLarge.statusCode).toBe(400);
      await expectFailure(app, "binary", BAD_REQUEST_ENVELOPE, {
        "content-type": "application/octet-stream",
      });
      await expectFailure(app, "text", BAD_REQUEST_ENVELOPE, { "content-type": "text/plain" });

      expect(invocations).toHaveLength(0);
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("KDF 失败（injected source reject）是 generic 5xx，无 Set-Cookie、auth_sessions 不变", async () => {
    const failingSource: PasswordSource = async () => {
      throw new Error("scrypt engine failure");
    };
    await withLoginApp({ passwordSource: failingSource }, async (app, db) => {
      await expectFaultPreservesSessions(app, db, loginPayload("zhangsan", "demo"));
    });
  });

  it("已知账号：injected KDF 返回错误长度是 generic 5xx，不返回 401，无 cookie/会话", async () => {
    const wrongLengthSource: PasswordSource = async (_password, salt, _keyLength, _options) =>
      Buffer.alloc(salt.length);
    await withLoginApp({ passwordSource: wrongLengthSource }, async (app, db) => {
      await expectServerError(app, loginPayload("zhangsan", "demo"));
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("已知账号在某错误路径后账号散列原样保留；合法 64-hex 会话可插入（VALID_SESSION_ID 仅测试常量）", async () => {
    await withLoginApp({}, async (app, db) => {
      const beforeHashes = db.prepare("SELECT id, password_hash FROM accounts ORDER BY id").all();
      await expectFailure(app, loginPayload("zhangsan", "wrong"), CREDENTIAL_FAILURE_ENVELOPE);
      expect(db.prepare("SELECT id, password_hash FROM accounts ORDER BY id").all()).toEqual(
        beforeHashes,
      );
      db.prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)").run(
        VALID_SESSION_ID,
        "u1",
        FIXED_NOW,
      );
      expect(sessionCount(db)).toBe(1);
    });
  });
});

describe("empty JSON body boundary", () => {
  it("content-type application/json with empty body maps to exact 400 bad_request，且不执行 KDF/cookie/session", async () => {
    const invocations: DerivationInvocation[] = [];

    await withLoginApp({ passwordSource: makeCountingSource(invocations) }, async (app, db) => {
      await expectBadRequest(app, db, "", { "content-type": "application/json" });
      expect(invocations).toHaveLength(0);
    });
  });
});
