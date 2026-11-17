import { readdirSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import {
  accountSnapshot,
  bearerCookie,
  disableAccount,
  enableAccount,
  FIXED_NOW,
  type InjectResponse,
  insertRow,
  loginSessionPair,
  sessionSnapshot,
  testId,
  totalChanges,
  UNAUTHORIZED_ENVELOPE,
  withApp,
} from "./auth-lifecycle-helpers.js";

const U1 =
  '{"department":"平台研发部","groups":[{"id":"g1","name":"内网落地专项","memberCount":2}]}';
const U2 = '{"department":"数据部","groups":[{"id":"g1","name":"内网落地专项","memberCount":2}]}';
const U3 = '{"department":"产品部","groups":[]}';
const U4 = '{"department":null,"groups":[]}';
const UNAUTHORIZED_JSON = JSON.stringify(UNAUTHORIZED_ENVELOPE);
const ACCOUNTS_DIR = new URL("../src/accounts/", import.meta.url);

async function requestScope(
  app: FastifyInstance,
  cookie?: string,
  search = "",
): Promise<InjectResponse> {
  return app.inject({
    method: "GET",
    url: `/api/accounts/me/scope${search}`,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

function expectScope(response: InjectResponse, payload: string): void {
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(response.payload).toBe(payload);
}

/** 守卫 401：no-store、无 Set-Cookie、会话与账号快照不变、没有写入。 */
async function expectGuardRejects(db: DatabaseSync, send: () => Promise<InjectResponse>) {
  const sessions = sessionSnapshot(db);
  const accounts = accountSnapshot(db);
  const before = totalChanges(db);
  const response = await send();
  expect(response.statusCode).toBe(401);
  expect(response.payload).toBe(UNAUTHORIZED_JSON);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(sessionSnapshot(db)).toEqual(sessions);
  expect(accountSnapshot(db)).toEqual(accounts);
  expect(totalChanges(db) - before).toBe(0);
}

describe("GET /api/accounts/me/scope", () => {
  it("三个账号：每人只得自己的部门与项目组，查询参数不改身份，端点不写任何表", async () => {
    await withApp({}, async ({ app, db }) => {
      enableAccount(db, "u4");
      const u1 = await loginSessionPair(app, "zhangsan");
      const u2 = await loginSessionPair(app, "zhaoliu");
      const u3 = await loginSessionPair(app, "lisi");
      const u4 = await loginSessionPair(app, "wangwu");
      const before = totalChanges(db);

      expectScope(await requestScope(app, u1), U1);
      expectScope(await requestScope(app, u2), U2);
      expectScope(await requestScope(app, u3), U3);
      expectScope(await requestScope(app, u4), U4);
      expectScope(await requestScope(app, u1, "?accountId=u3&id=u3"), U1);

      expect(totalChanges(db) - before).toBe(0);
    });
  });

  it("此刻、成员数与码点序：带外改部门与成员后同一 cookie 立刻看到，组按 name 码点升序", async () => {
    await withApp({}, async ({ app, db }) => {
      const u1 = await loginSessionPair(app, "zhangsan");
      const u3 = await loginSessionPair(app, "lisi");
      expectScope(await requestScope(app, u3), U3);

      const insertGroup = db.prepare(
        "INSERT INTO project_groups(id, name, created_at) VALUES (?, ?, 0)",
      );
      for (const [id, name] of [
        ["g2", "\u{1F600}组"],
        ["g3", "a组"],
        ["g4", "｡组"],
        ["g5", "Z组"],
      ] as const) {
        insertGroup.run(id, name);
      }
      const insertMember = db.prepare(
        "INSERT INTO project_group_members(group_id, account_id) VALUES (?, 'u3')",
      );
      for (const group of ["g2", "g3", "g4", "g5", "g1"]) {
        insertMember.run(group);
      }
      db.prepare("UPDATE accounts SET department = '设计部' WHERE id = 'u3'").run();

      expectScope(
        await requestScope(app, u3),
        '{"department":"设计部","groups":[{"id":"g5","name":"Z组","memberCount":1},{"id":"g3","name":"a组","memberCount":1},{"id":"g1","name":"内网落地专项","memberCount":3},{"id":"g4","name":"｡组","memberCount":1},{"id":"g2","name":"😀组","memberCount":1}]}',
      );
      expectScope(
        await requestScope(app, u1),
        '{"department":"平台研发部","groups":[{"id":"g1","name":"内网落地专项","memberCount":3}]}',
      );
    });
  });

  it("未登录：401 unauthorized，no-store，不清 cookie，不写表", async () => {
    await withApp({}, async ({ app, db }) => {
      await expectGuardRejects(db, () => requestScope(app));
    });
  });

  it("停用账号：种子 u4 的预置会话 401，会话行仍在", async () => {
    await withApp({}, async ({ app, db }) => {
      const id = testId("b");
      insertRow(db, id, "u4", FIXED_NOW + 60_000);
      await expectGuardRejects(db, () => requestScope(app, bearerCookie(id)));
      expect(sessionSnapshot(db).map((row) => row.id)).toEqual([id]);
    });
  });

  it("停用账号：u4 启用后登录、再停用，真实 cookie 401，会话行仍在", async () => {
    await withApp({}, async ({ app, db }) => {
      enableAccount(db, "u4");
      const cookie = await loginSessionPair(app, "wangwu");
      disableAccount(db, "u4");
      await expectGuardRejects(db, () => requestScope(app, cookie));
      expect(sessionSnapshot(db).map((row) => row.user_id)).toEqual(["u4"]);
    });
  });

  it("依赖方向：accounts 的源码不导入 ../kb/", () => {
    const sources = readdirSync(ACCOUNTS_DIR).filter((name) => name.endsWith(".ts"));
    expect(sources).toEqual(expect.arrayContaining(["index.ts", "scope.ts"]));
    for (const name of sources) {
      expect(readFileSync(new URL(name, ACCOUNTS_DIR), "utf8"), name).not.toMatch(
        /from\s+["']\.\.\/kb\//,
      );
    }
  });
});
