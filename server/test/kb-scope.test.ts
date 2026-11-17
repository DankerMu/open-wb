/**
 * #2037 s2c-kb-visibility 组 11：范围端点与建库范围（knowledge-bases「知识库范围端点」「知识库端点」建库、
 * 「同一知识库的写操作串行」「知识库审计」`kb.scope`；http-service-skeleton「统一错误信封」）。
 *
 * 种子账号 u1（zhangsan，平台研发部，g1 成员）、u2（zhaoliu，g1 成员）、u3（lisi，管理员，不是 g1 成员），u4（wangwu，部门为空）
 * 按需带外启用。期望值抄自规格与 tasks.md「组 11 约定」，一律写字面量；`kb.scope` 的 detail 按原始串比较，钉住键序。
 */
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { PARSER_INPUTS } from "./http-guard-helpers.js";
import {
  auditsOf,
  BASES,
  baseCount,
  COMPILE_OFF,
  createBase,
  createdBase,
  deleteBase,
  GENERIC_500,
  NOT_FOUND,
} from "./kb-bases-helpers.js";
import { LIST, UPLOAD, useIngestWorlds } from "./kb-ingest-helpers.js";
import {
  addCompileBase,
  BAD_REQUEST,
  chatWorld,
  configuredWorld,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { hex } from "./kb-store-helpers.js";
import { holdWriteLock } from "./kb-upload-helpers.js";
import { expectAnswer } from "./models-rest-helpers.js";
import { padded, send } from "./mounts-rest-helpers.js";
import { enableAccount, totalChanges } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const open = useSettingsWorlds();
const openIngest = useIngestWorlds();
const ready = () => configuredWorld(open);

type Who = Parameters<World["call"]>[2];
type Ref = [scope: string, groupId: string | null];

const TITLE = "修改知识库可见范围";
const G1 = { scope: "group", group: { id: "g1", name: "内网落地专项" } };
const ALL = { scope: "all", group: null };
const CONFLICT = { error: { code: "conflict", message: "同名资源已存在" } };
const NOT_READY = {
  error: {
    code: "kb_not_ready",
    message: "知识库模型未就绪，请管理员在模型设置里保存知识库嵌入模型",
  },
};

const scopeUrl = (id: string) => `${BASES}/${id}/scope`;
const put = (world: World, id: string, body: unknown, who: Who = "member") =>
  world.call("PUT", scopeUrl(id), who, body);
const rawPut = (world: World, id: string, payload: string, type: string) =>
  world.raw("PUT", scopeUrl(id), payload, type, "member");

/** `kb.scope` 的原始行，旧的在前。 */
const scopeRows = (world: World) =>
  world.db
    .prepare(
      "SELECT actor_id, title, detail, workspace_id FROM audit_events WHERE kind = 'kb.scope' ORDER BY id",
    )
    .all()
    .map((row) => ({ ...row }));

const quoted = (value: string | null) => (value === null ? "null" : `"${value}"`);

/** u1 的一行 `kb.scope`：detail 是原始串的字面量写法。 */
const scopeRow = (id: string, [scope, groupId]: Ref, [nextScope, nextGroupId]: Ref) => ({
  actor_id: "u1",
  title: TITLE,
  detail: `{"id":"${id}","before":{"scope":"${scope}","groupId":${quoted(groupId)}},"after":{"scope":"${nextScope}","groupId":${quoted(nextGroupId)}}}`,
  workspace_id: null,
});

/** 全部库行的范围两列与 `updated_at`。 */
const baseRows = (world: World) =>
  world.db
    .prepare("SELECT id, scope, scope_group_id, updated_at FROM knowledge_bases ORDER BY id")
    .all()
    .map((row) => ({ ...row }));

/** 被拒的请求之后：库行不变，没有 `kb.scope`，零出站。 */
function expectUntouched(world: World, before: ReturnType<typeof baseRows>): void {
  expect(baseRows(world)).toEqual(before);
  expect(scopeRows(world)).toEqual([]);
  expect(world.sent()).toEqual([]);
}

const rowOf = (world: World, id: string) => baseRows(world).find((row) => row.id === id);

async function idsOf(world: World, who: Who): Promise<Array<[string, boolean]>> {
  const response = await world.call("GET", BASES, who);
  expect(response.statusCode).toBe(200);
  const { bases } = response.json<{ bases: Array<{ id: string; owned: boolean }> }>();
  return bases.map(({ id, owned }) => [id, owned]);
}

/** u4 先带外启用、再登录：返回以 u4 身份发 JSON 请求的函数。 */
async function asWangwu(world: World) {
  enableAccount(world.db, "u4");
  const cookie = await cookieFor(world.app, "wangwu");
  return (method: "POST" | "PUT", url: string, payload: object) =>
    world.app.inject({ method, url, headers: { cookie }, payload });
}

function expectScopeBody(response: LightMyRequestResponse, scope: unknown, compile: unknown) {
  expectAnswer(response, 200);
  expect(response.json()).toMatchObject({ scope, compile });
}

describe("知识库范围端点", () => {
  it("改范围并审计：相同不写，应答带组名，恰两条 kb.scope，可见集合随之变，不动 updated_at，零出站", async () => {
    const world = await ready();
    const created = await createdBase(world, "规范库");
    const K = created.id;
    const updatedAt = rowOf(world, K)?.updated_at;
    world.forget();
    const toGroup = { scope: "group", groupId: "g1" };
    expectAnswer(await put(world, K, toGroup), 200, { ...created, scope: G1 });
    expect(await idsOf(world, "peer")).toEqual([[K, false]]);
    expect(await idsOf(world, "admin")).toEqual([]);
    const changes = totalChanges(world.db);
    expectAnswer(await put(world, K, toGroup), 200, { ...created, scope: G1 });
    expect(totalChanges(world.db) - changes).toBe(0);
    expectAnswer(await put(world, K, { scope: "all" }), 200, { ...created, scope: ALL });
    expect(await idsOf(world, "admin")).toEqual([[K, false]]);
    expect(scopeRows(world)).toEqual([
      scopeRow(K, ["me", null], ["group", "g1"]),
      scopeRow(K, ["group", "g1"], ["all", null]),
    ]);
    expect(rowOf(world, K)).toEqual({
      id: K,
      scope: "all",
      scope_group_id: null,
      updated_at: updatedAt,
    });
    expect(world.sent()).toEqual([]);
  });

  it("所有者条件与形状：部门为空、不是成员、组不存在与各种坏 body 都是 400，范围不变，没有审计", async () => {
    const world = await ready();
    const wangwu = await asWangwu(world);
    const empty = await wangwu("POST", BASES, { name: "空部门库", template: "naive" });
    expect(empty.statusCode).toBe(201);
    const lisi = await createdBase(world, "管理员库", "naive", "admin");
    const K = (await createdBase(world, "规范库")).id;
    world.forget();
    const before = baseRows(world);
    const rejected = [
      await wangwu("PUT", scopeUrl(empty.json<{ id: string }>().id), { scope: "dept" }),
      await put(world, lisi.id, { scope: "group", groupId: "g1" }, "admin"),
    ];
    for (const body of [
      { scope: "group" },
      { scope: "all", groupId: "g1" },
      { scope: "group", groupId: "nope" },
      { scope: "me", extra: 1 },
      {},
      { scope: "team" },
      { scope: "ME" },
      { scope: null },
      { scope: "me", groupId: null },
      { scope: "group", groupId: "" },
      { scope: "group", groupId: 1 },
      { scope: "group", groupId: "g1", extra: 1 },
    ]) {
      rejected.push(await put(world, K, body));
    }
    rejected.push(await rawPut(world, K, "[]", "application/json"));
    rejected.push(await rawPut(world, K, '"all"', "application/json"));
    expect(rejected).toHaveLength(16);
    for (const response of rejected) {
      expectAnswer(response, 400, BAD_REQUEST);
    }
    expectUntouched(world, before);
    const dept = { scope: "dept", group: null };
    expectScopeBody(await put(world, K, { scope: "dept" }), dept, COMPILE_OFF);
    expect(scopeRows(world)).toEqual([scopeRow(K, ["me", null], ["dept", null])]);
  });

  it("重建中也能改：重建器持锁时 200 不是 409，不等写锁，rebuild_failed 同样 200，零出站", async () => {
    const world = await openIngest();
    const url = scopeUrl(world.baseId);
    world.setState("rebuilding");
    const release = holdWriteLock(world, "rebuild");
    const lines = world.lines().length;
    const response = await send(world.fw.rest, "member", "PUT", url, { scope: "all" });
    expectAnswer(response, 200);
    expect(response.json()).toMatchObject({
      state: "rebuilding",
      scope: ALL,
      compile: COMPILE_OFF,
    });
    expect(world.locks.writeWaiters(world.baseId)).toBe(0);
    expect(world.audits("kb.scope")).toEqual([
      {
        actorId: "u1",
        title: TITLE,
        detail: {
          id: world.baseId,
          before: { scope: "me", groupId: null },
          after: { scope: "all", groupId: null },
        },
        workspaceId: null,
      },
    ]);
    expect(world.lines().slice(lines)).toEqual([]);
    await release();
    world.setState("rebuild_failed");
    expectAnswer(await send(world.fw.rest, "member", "PUT", url, { scope: "me" }), 200);
    expect(world.audits("kb.scope")).toHaveLength(2);
  });

  describe("读编译状态失败不影响改范围", () => {
    /** u1 名下开了 RAPTOR 的库 hex(1)，数据集真实存在、没有文档。 */
    function addRaptorBase(world: World): string {
      addCompileBase(world, 1);
      const ds = world.fake.addDataset();
      world.db.prepare("UPDATE knowledge_bases SET dataset_id = ? WHERE id = ?").run(ds, hex(1));
      world.forget();
      return ds;
    }

    it("阳性对照恰读两条；假 RAGFlow 不可达时 compile 为 null 仍 200，范围已写、审计已记", async () => {
      const world = await ready();
      const ds = addRaptorBase(world);
      const pending = { raptor: "pending", graph: "off" };
      expectScopeBody(await put(world, hex(1), { scope: "all" }), ALL, pending);
      expect(routes(world.sent())).toEqual([
        `GET /api/v1/datasets/${ds}/documents`,
        `GET /api/v1/datasets/${ds}/ingestions`,
      ]);
      await world.fake.close();
      const me = { scope: "me", group: null };
      expectScopeBody(await put(world, hex(1), { scope: "me" }), me, null);
      expect(scopeRows(world)).toHaveLength(2);
    });

    it("读取挂起：同一个 5 s 期限（缩短为 300 ms）到点 compile 为 null，仍 200", async () => {
      const world = await configuredWorld(open, { compileStatusDeadlineMs: 300 });
      addRaptorBase(world);
      world.fake.fault(LIST, { kind: "hang" });
      const started = Date.now();
      const response = await put(world, hex(1), { scope: "all" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(299);
      expectScopeBody(response, ALL, null);
      expect(scopeRows(world)).toHaveLength(1);
      expect(world.db.isTransaction).toBe(false);
    });
  });

  it("已失去条件时重存同一范围：所有者条件先于「与已存值相同」，400 不写；改回 me 照常 200", async () => {
    const world = await ready();
    const K = (await createdBase(world, "规范库")).id;
    const toGroup = { scope: "group", groupId: "g1" };
    expectAnswer(await put(world, K, toGroup), 200);
    world.db
      .prepare("DELETE FROM project_group_members WHERE group_id = 'g1' AND account_id = 'u1'")
      .run();
    expectAnswer(await put(world, K, toGroup), 400, BAD_REQUEST);
    expect(rowOf(world, K)).toMatchObject({ scope: "group", scope_group_id: "g1" });
    expect(scopeRows(world)).toHaveLength(1);
    expectAnswer(await put(world, K, { scope: "me" }), 200);
    expect(scopeRows(world)).toEqual([
      scopeRow(K, ["me", null], ["group", "g1"]),
      scopeRow(K, ["group", "g1"], ["me", null]),
    ]);
  });

  it("与删库并发：更新 0 行即 404 回滚、不审计；真实删库挂起时改范围不排队，删完之后 404", async () => {
    const world = await ready();
    const K = (await createdBase(world, "规范库")).id;
    world.db.exec(
      "CREATE TEMP TRIGGER scope_race BEFORE UPDATE OF scope ON knowledge_bases BEGIN SELECT RAISE(IGNORE); END",
    );
    expectAnswer(await put(world, K, { scope: "all" }), 404, NOT_FOUND);
    expect(scopeRows(world)).toEqual([]);
    expect(rowOf(world, K)).toMatchObject({ scope: "me", scope_group_id: null });
    expect(world.db.isTransaction).toBe(false);
    world.db.exec("DROP TRIGGER scope_race");
    expectAnswer(await put(world, K, { scope: "all" }), 200);
    expect(scopeRows(world)).toHaveLength(1);

    const K2 = (await createdBase(world, "第二库")).id;
    const gate = world.fake.fault("DELETE /api/v1/datasets", { kind: "hold" });
    const removing = deleteBase(world, K2);
    await gate.reached;
    expectAnswer(await put(world, K2, { scope: "all" }), 200);
    expect(world.locks.writeWaiters(K2)).toBe(0);
    gate.release();
    expect((await removing).statusCode).toBe(204);
    expectAnswer(await put(world, K2, { scope: "me" }), 404, NOT_FOUND);
    const ofK2 = scopeRows(world).filter(({ detail }) => String(detail).includes(K2));
    expect(ofK2).toEqual([scopeRow(K2, ["me", null], ["all", null])]);
  });

  it("改范围不排队：入库持有写锁（上传挂起）时立即 200，入库仍未落定，恰一条 kb.scope", async () => {
    const world = await openIngest();
    world.write("docs/a.md", "one");
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    let settled = false;
    const pending = world.ingest(["docs/a.md"]).finally(() => {
      settled = true;
    });
    await gate.reached;
    const url = scopeUrl(world.baseId);
    expectAnswer(await send(world.fw.rest, "member", "PUT", url, { scope: "all" }), 200);
    expect(settled).toBe(false);
    expect(world.locks.writeWaiters(world.baseId)).toBe(0);
    expect(world.audits("kb.scope")).toHaveLength(1);
    expect(world.countOf(UPLOAD)).toBe(1);
    gate.release();
    expect((await pending).statusCode).toBe(201);
  });

  it("归属路由：畸形 JSON、空 JSON、错媒体类型、超限、text/plain 与 16 KiB+1 都是 400；恰 16 KiB 得 200", async () => {
    const world = await ready();
    const K = (await createdBase(world, "规范库")).id;
    world.forget();
    const before = baseRows(world);
    const over = padded(16 * 1024 + 1, { scope: "all" });
    const inputs: Array<[string, string]> = [
      ...PARSER_INPUTS.map(({ payload, contentType }): [string, string] => [payload, contentType]),
      ['{"scope":"all"}', "text/plain"],
      [over.raw, over.type],
    ];
    for (const [payload, type] of inputs) {
      expectAnswer(await rawPut(world, K, payload, type), 400, BAD_REQUEST);
    }
    expectUntouched(world, before);
    const fits = padded(16 * 1024, { scope: "all" });
    expectScopeBody(await rawPut(world, K, fits.raw, fits.type), ALL, COMPILE_OFF);
  });

  it("一条事务：kb.scope 审计写不进时通用 500，范围不变，事务已收尾", async () => {
    const world = await ready();
    const K = (await createdBase(world, "规范库")).id;
    world.db.exec(
      "CREATE TEMP TRIGGER refuse_scope BEFORE INSERT ON audit_events WHEN NEW.kind = 'kb.scope' BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    const response = await put(world, K, { scope: "all" });
    expect([response.statusCode, response.json()]).toEqual([500, GENERIC_500]);
    expect(rowOf(world, K)).toMatchObject({ scope: "me", scope_group_id: null });
    expect(world.db.isTransaction).toBe(false);
  });
});

describe("知识库端点：建库带范围", () => {
  it("建库带 group 与 dept：201 带范围，kb.create detail 带 scope；条件在锁内、重名之后、出站之前", async () => {
    const world = await chatWorld(open);
    const naive = { template: "naive" };
    const grouped = await createBase(world, {
      name: "组库",
      ...naive,
      scope: "group",
      groupId: "g1",
    });
    expect(grouped.statusCode).toBe(201);
    expect(grouped.json()).toMatchObject({ owned: true, scope: G1 });
    const dept = await createBase(world, { name: "部门库", ...naive, scope: "dept" });
    expect(dept.statusCode).toBe(201);
    expect(dept.json()).toMatchObject({ owned: true, scope: { scope: "dept", group: null } });
    const [groupId, deptId] = [grouped, dept].map((response) => response.json<{ id: string }>().id);
    const created = { template: "naive", raptor: false, graph: false };
    expect(auditsOf(world, "kb.create").map(({ detail }) => detail)).toEqual([
      { id: groupId, ...created, scope: { scope: "group", groupId: "g1" } },
      { id: deptId, ...created, scope: { scope: "dept", groupId: null } },
    ]);
    expect([rowOf(world, groupId ?? ""), rowOf(world, deptId ?? "")]).toMatchObject([
      { scope: "group", scope_group_id: "g1" },
      { scope: "dept", scope_group_id: null },
    ]);

    world.forget();
    const count = baseCount(world);
    const wangwu = await asWangwu(world);
    const raptor = { ...naive, raptor: true };
    const rejected = [
      await wangwu("POST", BASES, { name: "u4 库", ...raptor, scope: "dept" }),
      await createBase(world, { name: "u3 库", ...raptor, scope: "group", groupId: "g1" }, "admin"),
      await createBase(world, { name: "甲", ...naive, scope: "all", groupId: "g1" }),
      await createBase(world, { name: "乙", ...naive, scope: "team" }),
      await createBase(world, { name: "丙", ...naive, groupId: "g1" }),
    ];
    for (const response of rejected) {
      expectAnswer(response, 400, BAD_REQUEST);
    }
    const taken = { name: "组库", ...naive, scope: "group", groupId: "nope" };
    expectAnswer(await createBase(world, taken), 409, CONFLICT);
    expect(world.sent()).toEqual([]);
    expect(baseCount(world)).toBe(count);
    expect(auditsOf(world, "kb.create")).toHaveLength(2);
  });

  it("未配置嵌入：坏范围 400（第 1 步不读库），部门为空的 dept 是 409 kb_not_ready（条件在就绪之后）", async () => {
    const world = await open();
    const body = { name: "规范库", template: "naive" };
    const bad = await createBase(world, { ...body, scope: "all", groupId: "g1" });
    expectAnswer(bad, 400, BAD_REQUEST);
    const wangwu = await asWangwu(world);
    expectAnswer(await wangwu("POST", BASES, { ...body, scope: "dept" }), 409, NOT_READY);
    expect(world.sent()).toEqual([]);
  });
});
