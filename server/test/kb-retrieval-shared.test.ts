/**
 * s2c-kb-visibility 组 7（#2033）：可见的非所有者对共享库的检索测试（knowledge-bases「检索测试端点」的「非所有者按已存参数
 * 检索」「非所有者的 body 仍须合规」「共享审计写失败不检索」，「同一知识库的写操作串行」里「非所有者的检索测试从不取锁」，
 * 「知识库审计」的 `kb.shared_retrieval`；design D5、D6）。经 `createApp` + `app.inject()`，真实 SQLite，打假 RAGFlow。
 *
 * 库是 u1（zhangsan，平台研发部）的 `world.baseId`，每个用例先带外改为 `dept` 档、已存参数 {0.35, 0.5}，并把 u2（zhaoliu）
 * 改到平台研发部；检索者是 u2。期望值抄自规格与 tasks.md「组 7 约定」，一律写字面量，不从 `src/` 取。
 */
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { BAD_REQUEST, type IngestWorld, REBUILDING, useIngestWorlds } from "./kb-ingest-helpers.js";
import { KB_UNAVAILABLE } from "./kb-settings-helpers.js";
import { holdWriteLock } from "./kb-upload-helpers.js";
import { expectAnswer } from "./models-rest-helpers.js";
import { auditRows, padded, send } from "./mounts-rest-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const open = useIngestWorlds();

const SHARED = "kb.shared_retrieval";
const SETTINGS = "kb.retrieval_settings";
const RETRIEVAL = "POST /api/v1/retrieval";
const CHANGED = { question: "销售额", threshold: 0.1, vectorWeight: 0.9 };
const STORED_BODY = { question: "销售额", threshold: 0.35, vectorWeight: 0.5 };
const STORED = { threshold: 0.35, vectorWeight: 0.5 };
const REFUSE_SHARED =
  "CREATE TRIGGER refuse_shared BEFORE INSERT ON audit_events WHEN NEW.kind = 'kb.shared_retrieval' BEGIN SELECT RAISE(ABORT, 'injected'); END";

interface Peer {
  world: IngestWorld;
  /** u2 发一次检索测试：对象按 JSON 发，字符串原样发。 */
  post(body: unknown): Promise<LightMyRequestResponse>;
}

/** 带外：库改为 `dept` 档与已存参数 {0.35, 0.5}，u2 改到 u1 的部门；之后 u2 登录。 */
async function sharedPeer(): Promise<Peer> {
  const world = await open();
  const { db } = world.fw.world;
  db.prepare(
    "UPDATE knowledge_bases SET scope='dept', retrieval_threshold=0.35, retrieval_vector_weight=0.5 WHERE id=?",
  ).run(world.baseId);
  db.prepare("UPDATE accounts SET department='平台研发部' WHERE id='u2'").run();
  const cookie = await cookieFor(world.fw.rest.app, "zhaoliu");
  return {
    world,
    post: (body) =>
      world.fw.rest.app.inject({
        method: "POST",
        url: `/api/kb/bases/${world.baseId}/retrieval`,
        headers: { cookie, "content-type": "application/json" },
        payload: typeof body === "string" ? body : JSON.stringify(body),
      }),
  };
}

/** 库行的两列与 `updated_at`，原样读出。 */
const columns = (world: IngestWorld) =>
  world.fw.world.db
    .prepare(
      "SELECT retrieval_threshold, retrieval_vector_weight, updated_at FROM knowledge_bases WHERE id = ?",
    )
    .get(world.baseId);

const totalAudits = (world: IngestWorld): number => auditRows(world.fw.world).length;

const sharedAudit = (world: IngestWorld, scope: { scope: string; groupId: string | null }) => ({
  actorId: "u2",
  title: "检索共享知识库",
  detail: { id: world.baseId, name: `库 ${world.baseId}`, ownerId: "u1", scope },
  workspaceId: null,
});

const DEPT = { scope: "dept", groupId: null };

/** 恰一次检索请求，body 带已存的两个值。 */
function expectStoredRetrieval(world: IngestWorld): void {
  expect(world.lines()).toEqual([RETRIEVAL]);
  expect(world.fake.requests()[0]?.json).toMatchObject({
    similarity_threshold: 0.35,
    vector_similarity_weight: 0.5,
  });
}

describe("非所有者按已存参数检索", () => {
  it("dept 档的同部门非所有者以不同参数检索：200 用已存值，不写回，恰一条 kb.shared_retrieval", async () => {
    const { world, post } = await sharedPeer();
    const before = columns(world);
    expectAnswer(await post(CHANGED), 200, { hits: [], retrieval: STORED });
    expectStoredRetrieval(world);
    expect(columns(world)).toEqual(before);
    expect(world.audits(SETTINGS)).toEqual([]);
    expect(world.audits(SHARED)).toEqual([sharedAudit(world, DEPT)]);
  });

  it("group 档的成员：detail 的 scope 为 {scope:group, groupId:g1}", async () => {
    const { world, post } = await sharedPeer();
    world.fw.world.db
      .prepare("UPDATE knowledge_bases SET scope='group', scope_group_id='g1' WHERE id=?")
      .run(world.baseId);
    expectAnswer(await post(CHANGED), 200, { hits: [], retrieval: STORED });
    expect(world.audits(SHARED)).toEqual([sharedAudit(world, { scope: "group", groupId: "g1" })]);
  });

  it("时点：审计写在检索请求之前——检索被挂起时已恰一条，放行后 200", async () => {
    const { world, post } = await sharedPeer();
    const gate = world.fake.fault(RETRIEVAL, { kind: "hold" });
    const pending = post(CHANGED);
    await gate.reached;
    expect(world.audits(SHARED)).toEqual([sharedAudit(world, DEPT)]);
    gate.release();
    expectAnswer(await pending, 200, { hits: [], retrieval: STORED });
    expect(world.audits(SHARED)).toHaveLength(1);
  });

  it("检索失败与审计无关：假 RAGFlow 回 503，应答 503 kb_unavailable，共享审计仍恰一条", async () => {
    const { world, post } = await sharedPeer();
    world.fake.fault(RETRIEVAL, { kind: "status", status: 503 });
    expectAnswer(await post(CHANGED), 503, KB_UNAVAILABLE);
    expect(world.audits(SHARED)).toEqual([sharedAudit(world, DEPT)]);
  });
});

describe("非所有者的 body 仍须合规", () => {
  it("坏 body 与超限 400，rebuild_failed / rebuilding 409，rebuilding 带坏 body 400：零出站，零审计", async () => {
    const { world, post } = await sharedPeer();
    const audited = totalAudits(world);
    const bad = { ...CHANGED, threshold: 1.5 };
    const oversized = padded(16 * 1024 + 1, CHANGED).raw;
    expectAnswer(await post(bad), 400, BAD_REQUEST);
    expectAnswer(await post(oversized), 400, BAD_REQUEST);
    world.setState("rebuild_failed");
    expectAnswer(await post(CHANGED), 409, REBUILDING);
    world.setState("rebuilding");
    expectAnswer(await post(CHANGED), 409, REBUILDING);
    expectAnswer(await post(bad), 400, BAD_REQUEST);
    expect(world.lines()).toEqual([]);
    expect(totalAudits(world)).toBe(audited);
  });
});

describe("共享审计写失败不检索", () => {
  it("触发器拒写 kb.shared_retrieval：通用 500 逐字节，零出站，零审计，两列与 updated_at 不变", async () => {
    const { world, post } = await sharedPeer();
    world.fw.world.db.exec(REFUSE_SHARED);
    const audited = totalAudits(world);
    const before = columns(world);
    const response = await post(STORED_BODY);
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: { message: "服务器内部错误" } }));
    expect(world.lines()).toEqual([]);
    expect(totalAudits(world)).toBe(audited);
    expect(columns(world)).toEqual(before);
  });
});

describe("同一知识库的写操作串行：非所有者的检索测试从不取锁", () => {
  it("重建器持锁时以不同参数检索 200（所有者同情形 409），不排队", async () => {
    const { world, post } = await sharedPeer();
    const release = holdWriteLock(world, "rebuild");
    expectAnswer(await post(CHANGED), 200, { hits: [], retrieval: STORED });
    expect(world.locks.writeWaiters(world.baseId)).toBe(0);
    await release();
  });

  it("写者持锁时以不同参数检索不等待即 200，不排队", async () => {
    const { world, post } = await sharedPeer();
    const release = holdWriteLock(world);
    expectAnswer(await post(CHANGED), 200, { hits: [], retrieval: STORED });
    expect(world.locks.writeWaiters(world.baseId)).toBe(0);
    await release();
    expect(world.audits(SETTINGS)).toEqual([]);
  });
});

describe("所有者对共享库", () => {
  it("u1 对自己的 dept 库：参数相同零审计，参数不同恰一条 kb.retrieval_settings，从不写 kb.shared_retrieval", async () => {
    const { world } = await sharedPeer();
    const ownerPost = (body: unknown) =>
      send(world.fw.rest, "member", "POST", `/api/kb/bases/${world.baseId}/retrieval`, body);
    const audited = totalAudits(world);
    expectAnswer(await ownerPost(STORED_BODY), 200, { hits: [], retrieval: STORED });
    expect(totalAudits(world)).toBe(audited);
    const changed = { threshold: 0.1, vectorWeight: 0.9 };
    expectAnswer(await ownerPost(CHANGED), 200, { hits: [], retrieval: changed });
    expect(world.audits(SETTINGS)).toHaveLength(1);
    expect(world.audits(SHARED)).toEqual([]);
  });
});
