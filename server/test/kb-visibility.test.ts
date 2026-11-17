/**
 * s2c-kb-visibility 组 5（#2031）：可见判定与两级归属（knowledge-bases「可见范围判定」「知识库端点」）。
 *
 * 多账号世界：种子账号 u1（zhangsan，平台研发部）、u2（zhaoliu，数据部）、u3（lisi，管理员，产品部）与 g1（内网落地专项，
 * 成员 u1、u2），u4（wangwu，部门为空）按需带外启用。库行与范围列带外写入（组 11 之前没有改范围的路由）。期望值抄自规格与
 * tasks.md「组 5 约定」，一律写字面量。
 *
 * 本刀七条 `:id` 路由对可见的非所有者都是 403：`GET …/documents` 与 `POST …/retrieval` 由组 6、组 7 原地改为 200。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { BASES, NOT_FOUND } from "./kb-bases-helpers.js";
import {
  chatWorld,
  configuredWorld,
  FORBIDDEN,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import {
  BASE_ROW,
  COMPILE_ROW,
  hex,
  insertRow,
  type Row,
  T0,
  UPLOAD_ROW,
} from "./kb-store-helpers.js";
import { disableAccount, enableAccount } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const open = useSettingsWorlds();
const ready = () => configuredWorld(open);

type Who = "member" | "peer" | "admin";
type View = Record<string, unknown> & { id: string };

const U1 = { id: "u1", account: "zhangsan", department: "平台研发部" };
const U2 = { id: "u2", account: "zhaoliu", department: "数据部" };
const U3 = { id: "u3", account: "lisi", department: "产品部" };
const G1 = { scope: "group", group: { id: "g1", name: "内网落地专项" } };
const [KM, KD, KG, KA] = [hex(1), hex(2), hex(3), hex(4)] as const;
const GHOST = "e".repeat(32);

/** u1 名下的一个库：名称与数据集按序号区分（`UNIQUE (owner_id, name)`）。 */
function addBase(world: World, n: number, fields: Row = {}): void {
  insertRow(world.db, "knowledge_bases", {
    ...BASE_ROW,
    id: hex(n),
    name: `库 ${String(n)}`,
    dataset_id: `ds-${String(n)}`,
    ...fields,
  });
}

/** 「四档 × 查看者」的四个库：me、dept、group（g1）、all，`created_at` 依次为 T0+1…T0+4。 */
function addTiers(world: World): void {
  addBase(world, 1, { created_at: T0 + 1 });
  addBase(world, 2, { scope: "dept", created_at: T0 + 2 });
  addBase(world, 3, { scope: "group", scope_group_id: "g1", created_at: T0 + 3 });
  addBase(world, 4, { scope: "all", created_at: T0 + 4 });
}

function listed(response: LightMyRequestResponse): View[] {
  expect(response.statusCode).toBe(200);
  return (response.json() as { bases: View[] }).bases;
}

const listOf = async (world: World, who: Who) => listed(await world.call("GET", BASES, who));
const idsOf = async (world: World, who: Who) => (await listOf(world, who)).map(({ id }) => id);

/** u4 先带外启用、再登录，用真实 cookie 列表。 */
async function wangwuIds(world: World): Promise<string[]> {
  enableAccount(world.db, "u4");
  const cookie = await cookieFor(world.app, "wangwu");
  const response = await world.app.inject({ method: "GET", url: BASES, headers: { cookie } });
  return listed(response).map(({ id }) => id);
}

const documentsOf = (world: World, id: string, who: Who) =>
  world.call("GET", `${BASES}/${id}/documents`, who);

type Send = (world: World, id: string) => Promise<LightMyRequestResponse>;

/** 本刀七条 `:id` 路由，合法的请求，都由 peer（u2）发出。 */
const VALID: Array<[string, Send]> = [
  ["GET 文档列表", (w, id) => documentsOf(w, id, "peer")],
  [
    "POST 检索测试",
    (w, id) =>
      w.call("POST", `${BASES}/${id}/retrieval`, "peer", {
        question: "退款时限",
        threshold: 0.5,
        vectorWeight: 0.3,
      }),
  ],
  ["DELETE 库", (w, id) => w.call("DELETE", `${BASES}/${id}`, "peer")],
  [
    "POST 文档",
    (w, id) =>
      w.call("POST", `${BASES}/${id}/documents`, "peer", { workspaceId: "w1", paths: ["a.md"] }),
  ],
  ["DELETE 文档", (w, id) => w.call("DELETE", `${BASES}/${id}/documents?doc=doc-1`, "peer")],
  [
    "POST 重新入库",
    (w, id) => w.call("POST", `${BASES}/${id}/documents/reingest?doc=doc-1`, "peer"),
  ],
  [
    "POST 上传",
    (w, id) =>
      w.raw("POST", `${BASES}/${id}/uploads?name=a.md`, "abc", "application/octet-stream", "peer"),
  ],
];

/** 坏 body、空 `doc`、超 16 KiB、bodyless 带 `{}`、上传错媒体类型：所有者得 400 的五种请求。 */
const MALFORMED: Array<[string, Send]> = [
  [
    "POST 文档 坏 JSON",
    (w, id) => w.raw("POST", `${BASES}/${id}/documents`, "{not json", "text/plain", "peer"),
  ],
  ["DELETE 文档 doc=", (w, id) => w.call("DELETE", `${BASES}/${id}/documents?doc=`, "peer")],
  [
    "POST 检索测试 16 KiB+1",
    (w, id) =>
      w.raw(
        "POST",
        `${BASES}/${id}/retrieval`,
        "x".repeat(16 * 1024 + 1),
        "application/json",
        "peer",
      ),
  ],
  [
    "POST 重新入库 带 {}",
    (w, id) => w.call("POST", `${BASES}/${id}/documents/reingest?doc=doc-1`, "peer", {}),
  ],
  [
    "POST 上传 text/plain",
    (w, id) => w.raw("POST", `${BASES}/${id}/uploads?name=a.md`, "abc", "text/plain", "peer"),
  ],
];

/** 三张表逐行快照：写路由被拒时都不得变。 */
const snapshot = (world: World) =>
  ["knowledge_bases", "kb_documents", "audit_events"].map((table) =>
    world.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  );

/** u1 名下 ready 的库 K=hex(1)，带一行上传文档 `doc-1`。 */
function sharedWorld(world: World, scope: "me" | "all"): string {
  addBase(world, 1, { scope });
  insertRow(world.db, "kb_documents", UPLOAD_ROW);
  world.forget();
  return hex(1);
}

async function expectAllForbidden(world: World, requests: Array<[string, Send]>, id: string) {
  const before = snapshot(world);
  for (const [name, send] of requests) {
    const response = await send(world, id);
    expect({ name, status: response.statusCode, body: response.json() }).toEqual({
      name,
      status: 403,
      body: FORBIDDEN,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  }
  expect(world.sent()).toEqual([]);
  expect(snapshot(world)).toEqual(before);
}

describe("可见范围判定", () => {
  it("四档 × 查看者：自有库全见，dept 不跨部门，group 只给成员，all 给全部账号（管理员没有特权）", async () => {
    const world = await ready();
    addTiers(world);
    expect(await idsOf(world, "member")).toEqual([KM, KD, KG, KA]);
    expect(await idsOf(world, "peer")).toEqual([KG, KA]);
    expect(await idsOf(world, "admin")).toEqual([KA]);
    expect(await wangwuIds(world)).toEqual([KA]);
    expect(await listOf(world, "peer")).toEqual([
      {
        id: KG,
        name: "库 3",
        template: "naive",
        raptor: false,
        graph: false,
        state: "ready",
        stateMessage: null,
        documents: 0,
        compile: null,
        retrieval: { threshold: 0.2, vectorWeight: 0.7 },
        createdAt: T0 + 3,
        owned: false,
        owner: U1,
        scope: G1,
      },
      {
        id: KA,
        name: "库 4",
        template: "naive",
        raptor: false,
        graph: false,
        state: "ready",
        stateMessage: null,
        documents: 0,
        compile: null,
        retrieval: { threshold: 0.2, vectorWeight: 0.7 },
        createdAt: T0 + 4,
        owned: false,
        owner: U1,
        scope: { scope: "all", group: null },
      },
    ]);
    const [, dept] = await listOf(world, "member");
    expect(dept).toEqual({
      id: KD,
      name: "库 2",
      template: "naive",
      raptor: false,
      graph: false,
      state: "ready",
      stateMessage: null,
      documents: 0,
      compile: { raptor: "off", graph: "off" },
      retrieval: { threshold: 0.2, vectorWeight: 0.7 },
      createdAt: T0 + 2,
      owned: true,
      owner: U1,
      scope: { scope: "dept", group: null },
    });
    expect(world.sent()).toEqual([]);
    expect((await documentsOf(world, KM, "admin")).statusCode).toBe(404);
    expect((await documentsOf(world, KA, "admin")).statusCode).toBe(403);
  });

  it("同部门与空部门：部门现查；所有者或查看者部门为空都不匹配", async () => {
    const world = await ready();
    addTiers(world);
    world.db.prepare("UPDATE accounts SET department = '平台研发部' WHERE id = 'u2'").run();
    expect(await idsOf(world, "peer")).toEqual([KD, KG, KA]);
    world.db.prepare("UPDATE accounts SET department = NULL WHERE id = 'u1'").run();
    const shared = await listOf(world, "peer");
    expect(shared.map(({ id }) => id)).toEqual([KG, KA]);
    expect(shared[0]?.owner).toEqual({ id: "u1", account: "zhangsan", department: null });
    expect(await wangwuIds(world)).toEqual([KA]);
    expect(await idsOf(world, "member")).toEqual([KM, KD, KG, KA]);
  });

  it("成员关系与组名现查：删成员即 404，加成员即可见，改组名下一次请求即变", async () => {
    const world = await ready();
    addTiers(world);
    expect((await documentsOf(world, KG, "peer")).statusCode).toBe(403);
    world.db
      .prepare("DELETE FROM project_group_members WHERE group_id = 'g1' AND account_id = 'u2'")
      .run();
    expect(await idsOf(world, "peer")).toEqual([KA]);
    const hidden = await documentsOf(world, KG, "peer");
    expect({ status: hidden.statusCode, body: hidden.json() }).toEqual({
      status: 404,
      body: NOT_FOUND,
    });
    world.db
      .prepare("INSERT INTO project_group_members (group_id, account_id) VALUES ('g1', 'u3')")
      .run();
    expect(await idsOf(world, "admin")).toEqual([KG, KA]);
    world.db.prepare("UPDATE project_groups SET name = '新专项' WHERE id = 'g1'").run();
    const [group] = await listOf(world, "admin");
    expect(group?.scope).toEqual({ scope: "group", group: { id: "g1", name: "新专项" } });
  });

  it("停用的所有者：库照常对可见的人列出，owner 仍是 U1", async () => {
    const world = await ready();
    addTiers(world);
    disableAccount(world.db, "u1");
    const shared = await listOf(world, "peer");
    expect(shared.map(({ id }) => id)).toEqual([KG, KA]);
    expect(shared.map(({ owner }) => owner)).toEqual([U1, U1]);
  });

  it("只有一处可见判定：读范围、部门与组成员的 SQL 字面量只在点名的文件里", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const literals = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => {
        const code = readFileSync(join(src, name), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        const sql = (code.match(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []).filter((text) =>
          /\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|WHERE)\b/.test(text),
        );
        return { name: name.split("\\").join("/"), sql };
      });
    const filesWith = (pattern: RegExp) =>
      literals
        .filter(({ sql }) => sql.some((text) => pattern.test(text)))
        .map(({ name }) => name)
        .sort();
    expect(filesWith(/\bscope(?:_group_id)?\b/)).toEqual(["kb/visibility.ts"]);
    expect(filesWith(/\bproject_group_members\b/)).toEqual([
      "accounts/scope.ts",
      "kb/visibility.ts",
    ]);
    expect(filesWith(/\bdepartment\b/)).toEqual(["accounts/scope.ts", "kb/visibility.ts"]);
  });
});

describe("知识库端点：两级归属", () => {
  it("共享库的两级归属：可见的非所有者对本刀七条路由都 403，零出站，三张表逐行不变（组 6、组 7 把前两次原地改为 200）", async () => {
    const world = await ready();
    const id = sharedWorld(world, "all");
    await expectAllForbidden(world, VALID, id);
  });

  it("403 先于 body：畸形、超限、bodyless 带 {}、错媒体类型都是 403 不是 400", async () => {
    const world = await ready();
    const id = sharedWorld(world, "all");
    await expectAllForbidden(world, MALFORMED, id);
  });

  it("不可见与不存在不可区分：状态码、body 字节与去掉 date 的响应头全等，零出站，行不变", async () => {
    const world = await ready();
    const id = sharedWorld(world, "me");
    const before = snapshot(world);
    const withoutDate = ({ date: _date, ...rest }: LightMyRequestResponse["headers"]) => rest;
    for (const [name, send] of [...VALID, ...MALFORMED]) {
      const hidden = await send(world, id);
      const ghost = await send(world, GHOST);
      expect({ name, hidden: hidden.statusCode, ghost: ghost.statusCode }).toEqual({
        name,
        hidden: 404,
        ghost: 404,
      });
      expect(hidden.body).toBe(ghost.body);
      expect(JSON.parse(hidden.body)).toEqual(NOT_FOUND);
      expect(withoutDate(hidden.headers)).toEqual(withoutDate(ghost.headers));
    }
    expect(world.sent()).toEqual([]);
    expect(snapshot(world)).toEqual(before);
  });
});

describe("列表的可见集合、次序与非自有的编译状态", () => {
  it("自有库在前按 created_at，其余按 created_at 再按 id；非自有库 compile 为 null，只读自有 raptor 库", async () => {
    const world = await chatWorld(open);
    addBase(world, 3, { owner_id: "u3", scope: "all", created_at: T0 });
    insertRow(world.db, "knowledge_bases", {
      ...COMPILE_ROW,
      id: hex(1),
      name: "库 1",
      dataset_id: "ds-k1",
      scope: "all",
      created_at: T0,
    });
    addBase(world, 2, { created_at: T0 - 1 });
    const created = await world.call("POST", BASES, "peer", {
      name: "A2",
      template: "naive",
      raptor: true,
    });
    expect(created.statusCode).toBe(201);
    const a2 = created.json<{ id: string; createdAt: number }>();
    addBase(world, 5, { owner_id: "u2", created_at: a2.createdAt + 1 });
    const datasetId = world.store.getBase(a2.id)?.datasetId ?? "";
    world.forget();
    const bases = await listOf(world, "peer");
    expect(bases.map(({ id }) => id)).toEqual([a2.id, hex(5), hex(1), hex(3)]);
    expect(bases.map(({ owned }) => owned)).toEqual([true, true, false, false]);
    expect(bases.map(({ owner }) => owner)).toEqual([U2, U2, U1, U3]);
    expect(bases.map(({ compile }) => compile)).toEqual([
      { raptor: "pending", graph: "off" },
      { raptor: "off", graph: "off" },
      null,
      null,
    ]);
    expect(routes(world.sent())).toEqual([
      `GET /api/v1/datasets/${datasetId}/documents`,
      `GET /api/v1/datasets/${datasetId}/ingestions`,
    ]);
  });
});
