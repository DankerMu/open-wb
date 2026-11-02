/**
 * s2a-kb-ragflow tasks 13.2（#1850）：`DELETE /api/kb/bases/:id/documents?doc=<id>`（knowledge-bases「重新入库与移出」的移出部分、
 * 「知识库端点」的「文档路由的所有权」、「知识库审计」的移出一腿，ragflow-backend「不存在视为已删」的移出一腿，design D13、D20）。
 * 经 `createApp` + `app.inject()` 打假 RAGFlow（`kb-ingest-helpers.ts`）。源文件相关的用例走真实入库，其余的文档行由 store 直接插入，
 * RAGFlow 文档经 `fake.addDocument` 种进当前数据集；状态由 store 直接设置。
 *
 * 假 RAGFlow 的文档状态是静态的：`RUNNING`、`STOPPING` 的删除回 `deleted:0`，用例在挂起点改状态。断言请求次数的用例把重发期限
 * 拉长到 60 s，结果不随机器快慢变；只有断言 `busy` 的用例用 helper 的短期限。期望值是 spec 与实测记录（§8.2、§8.5、表 B）的字面量。
 */
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { KbDocument } from "../src/kb/store.js";
import {
  BAD_REQUEST,
  bytesOf,
  CONTENT_SENTINEL,
  DELETE_DOCUMENT,
  type IngestWorld,
  MESSAGE_SENTINEL,
  NOT_FOUND,
  REBUILDING,
  STOP,
  useIngestWorlds,
} from "./kb-ingest-helpers.js";
import { KB_UNAVAILABLE } from "./kb-settings-helpers.js";
import { holdWriteLock, KB_REJECTED } from "./kb-upload-helpers.js";
import { OWNER, W1 } from "./mounts-manager-helpers.js";
import { auditRows, send } from "./mounts-rest-helpers.js";
import { UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";

const open = useIngestWorlds();

const KB_DOCUMENT_BUSY = {
  error: { code: "kb_document_busy", message: "文档正在停止解析，请稍后再试" },
};
const DELETED_ZERO = { code: 0, data: { deleted: 0 } };
/** 断言请求次数时用：到期远在用例结束之后。 */
const LONG = { documentDelete: { retryMs: 2, deadlineMs: 60_000 } };
const ABSENT_ID = "f".repeat(32);
const TITLE = "知识库移出文档";

type Who = "admin" | "member" | "anonymous";

interface RemoveOptions {
  who?: Who;
  baseId?: string;
  body?: unknown;
}

/** `query` 原样拼在路径后面，含 `?`。 */
const removeWith = (
  world: IngestWorld,
  query: string,
  options: RemoveOptions = {},
): Promise<LightMyRequestResponse> =>
  send(
    world.fw.rest,
    options.who ?? "member",
    "DELETE",
    `/api/kb/bases/${options.baseId ?? world.baseId}/documents${query}`,
    options.body,
  );

const remove = (world: IngestWorld, documentId: string, options?: RemoveOptions) =>
  removeWith(world, `?doc=${documentId}`, options);

/** 一份上传来源的文档：RAGFlow 里处于 `ingestionStatus`，本地有行。 */
function seeded(world: IngestWorld, ingestionStatus = "UNSTART"): KbDocument {
  const ragflowDocumentId = world.fake.addDocument(world.datasetId, {
    name: "a.md",
    content: "a",
    ingestionStatus,
  });
  return world.store.addDocument({
    kbId: world.baseId,
    ragflowDocumentId,
    name: "a.md",
    size: 1,
    source: "upload",
  });
}

/** 经真实入库的一份工作空间来源的文档。 */
async function ingested(world: IngestWorld, path: string, bytes: string): Promise<KbDocument> {
  world.write(path, bytes);
  expect((await world.ingest([path])).statusCode).toBe(201);
  const row = world.rows().find((document) => document.sourcePath === path);
  if (row === undefined) {
    throw new Error(`ingest left no row for ${path}`);
  }
  return row;
}

const ragflowIds = (world: IngestWorld): string[] =>
  world.fake.documents(world.datasetId).map(({ id }) => id);

/** 失败的移出：行与 RAGFlow 文档都在，没有 `kb.document_delete`。 */
function expectUntouched(world: IngestWorld, document: KbDocument): void {
  expect(world.rows()).toEqual([document]);
  expect(ragflowIds(world)).toContain(document.ragflowDocumentId);
  expect(world.audits("kb.document_delete")).toEqual([]);
}

function expectRemoved(world: IngestWorld, response: LightMyRequestResponse, id: string): void {
  expect(response.statusCode, response.body).toBe(204);
  expect(response.body).toBe("");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(world.store.getDocument(world.baseId, id)).toBeUndefined();
}

describe("移出", () => {
  it("移出不动源文件：204，源文件字节与修改时间不变，RAGFlow 文档已删，恰一条 kb.document_delete", async () => {
    const world = await open();
    const document = await ingested(world, "docs/a.md", "正文");
    const before = statSync(join(world.root, "docs/a.md")).mtimeMs;
    const bytes = bytesOf(world, "docs/a.md");
    const audited = auditRows(world.fw.world).length;

    const response = await remove(world, document.id);
    expectRemoved(world, response, document.id);
    expect(bytesOf(world, "docs/a.md")).toEqual(bytes);
    expect(statSync(join(world.root, "docs/a.md")).mtimeMs).toBe(before);
    expect(ragflowIds(world)).toEqual([]);
    expect(world.audits("kb.document_delete")).toEqual([
      {
        actorId: OWNER,
        title: TITLE,
        detail: { id: world.baseId, documentId: document.id },
        workspaceId: W1,
      },
    ]);
    expect(auditRows(world.fw.world)).toHaveLength(audited + 1);
  });

  it("不读沙箱：源文件已删除也照常 204，只发一次删除", async () => {
    const world = await open();
    const document = await ingested(world, "a.md", "a");
    rmSync(join(world.root, "a.md"));
    const sent = world.fake.requests().length;
    expectRemoved(world, await remove(world, document.id), document.id);
    expect(world.lines().slice(sent)).toEqual([
      `DELETE /api/v1/datasets/${world.datasetId}/documents`,
    ]);
    expect(world.audits("sandbox.reject")).toEqual([]);
  });

  it("上传来源的文档：204，审计的 workspace_id 为 null；同库别的文档不受影响", async () => {
    const world = await open();
    const kept = seeded(world);
    const document = seeded(world);
    expectRemoved(world, await remove(world, document.id), document.id);
    expect(world.rows()).toEqual([kept]);
    expect(ragflowIds(world)).toEqual([kept.ragflowDocumentId]);
    expect(world.audits("kb.document_delete")).toEqual([
      {
        actorId: OWNER,
        title: TITLE,
        detail: { id: world.baseId, documentId: document.id },
        workspaceId: null,
      },
    ]);
  });

  it("删除带的是该行的 RAGFlow 文档 id，只发这一个", async () => {
    const world = await open();
    const document = seeded(world);
    await remove(world, document.id);
    const deletes = world.fake
      .requests()
      .filter(({ method }) => method === "DELETE")
      .map(({ json }) => json);
    expect(deletes).toEqual([{ ids: [document.ragflowDocumentId] }]);
  });
});

describe("D13 的删除写法（端点层）", () => {
  it("移出解析中的文档：依次收到删除、停止、删除，204，行已删除，恰一条 kb.document_delete", async () => {
    const world = await open({ kb: LONG });
    const document = seeded(world, "RUNNING");
    const gate = world.fake.fault(STOP, { kind: "hold" });
    const pending = remove(world, document.id);
    await gate.reached;
    world.fake.setDocumentStatus(world.datasetId, document.ragflowDocumentId, "STOPPED");
    gate.release();
    expectRemoved(world, await pending, document.id);
    const documents = `/api/v1/datasets/${world.datasetId}/documents`;
    expect(world.lines()).toEqual([
      `DELETE ${documents}`,
      `POST ${documents}/stop`,
      `DELETE ${documents}`,
    ]);
    expect(world.audits("kb.document_delete")).toHaveLength(1);
  });

  it("停止已在 STOPPING 的文档：恰一次停止与四次删除，204", async () => {
    const world = await open({ kb: LONG });
    const document = seeded(world, "STOPPING");
    world.fake.answer(DELETE_DOCUMENT, DELETED_ZERO, { times: 3 });
    const gate = world.fake.fault(DELETE_DOCUMENT, { kind: "hold" });
    const pending = remove(world, document.id);
    await gate.reached;
    world.fake.setDocumentStatus(world.datasetId, document.ragflowDocumentId, "STOPPED");
    gate.release();
    expectRemoved(world, await pending, document.id);
    expect(world.countOf(STOP)).toBe(1);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(4);
    expect(ragflowIds(world)).toEqual([]);
  });

  it("停止解析的其余结果：success_count:0 与 code:100 都继续重发删除，204；HTTP 503 即 503，行不变，不再删除", async () => {
    const world = await open({ kb: LONG });

    const completed = seeded(world, "COMPLETED");
    world.fake.answer(DELETE_DOCUMENT, DELETED_ZERO);
    expectRemoved(world, await remove(world, completed.id), completed.id);
    expect([world.countOf(DELETE_DOCUMENT), world.countOf(STOP)]).toEqual([2, 1]);

    const vanished = seeded(world);
    const ragflowId = vanished.ragflowDocumentId;
    world.fake.answer(DELETE_DOCUMENT, DELETED_ZERO);
    world.fake.answer(STOP, { code: 100, message: `Documents not found: ['${ragflowId}']` });
    expectRemoved(world, await remove(world, vanished.id), vanished.id);
    expect([world.countOf(DELETE_DOCUMENT), world.countOf(STOP)]).toEqual([4, 2]);

    const running = seeded(world, "RUNNING");
    world.fake.fault(STOP, { kind: "status", status: 503 });
    const down = await remove(world, running.id);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual(KB_UNAVAILABLE);
    expect([world.countOf(DELETE_DOCUMENT), world.countOf(STOP)]).toEqual([5, 3]);
    expect(world.lines().at(-1)).toBe(`POST /api/v1/datasets/${world.datasetId}/documents/stop`);
    expect(world.rows()).toEqual([running]);
    expect(world.audits("kb.document_delete")).toHaveLength(2);
  });

  it("重试期间不可达：立即 503 kb_unavailable，不等到期；行不变，没有 kb.document_delete", async () => {
    const world = await open({ kb: LONG });
    const document = seeded(world, "RUNNING");
    world.fake.answer(DELETE_DOCUMENT, DELETED_ZERO);
    world.fake.fault(DELETE_DOCUMENT, { kind: "status", status: 503 });
    const response = await remove(world, document.id);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(KB_UNAVAILABLE);
    expect([world.countOf(DELETE_DOCUMENT), world.countOf(STOP)]).toEqual([2, 1]);
    expectUntouched(world, document);
  });

  it("停不下来的文档：到期 409 kb_document_busy，行仍在，没有 kb.document_delete，恰一次停止", async () => {
    const world = await open();
    const document = seeded(world, "RUNNING");
    const response = await remove(world, document.id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(KB_DOCUMENT_BUSY);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(world.countOf(STOP)).toBe(1);
    expect(world.countOf(DELETE_DOCUMENT)).toBeGreaterThan(1);
    expectUntouched(world, document);
    expect(world.logged).toEqual([]);
  });

  it("停下来之后再移出：204", async () => {
    const world = await open();
    const document = seeded(world, "RUNNING");
    expect((await remove(world, document.id)).statusCode).toBe(409);
    world.fake.setDocumentStatus(world.datasetId, document.ragflowDocumentId, "STOPPED");
    expectRemoved(world, await remove(world, document.id), document.id);
  });
});

describe("RAGFlow 的失败与不存在", () => {
  it("不存在视为已删：RAGFlow 回 code:102 与「不属于该数据集」前缀，204，行已删除，恰一条 kb.document_delete；再删库 204", async () => {
    const world = await open();
    const document = world.store.addDocument({
      kbId: world.baseId,
      ragflowDocumentId: ABSENT_ID,
      name: "a.md",
      size: 1,
      source: "upload",
    });
    expectRemoved(world, await remove(world, document.id), document.id);
    expect(world.lines()).toEqual([`DELETE /api/v1/datasets/${world.datasetId}/documents`]);
    expect(world.audits("kb.document_delete")).toHaveLength(1);

    world.fake.answer("DELETE /api/v1/datasets", { code: 403, message: "Permission denied" });
    const dropped = await send(world.fw.rest, "member", "DELETE", `/api/kb/bases/${world.baseId}`);
    expect(dropped.statusCode).toBe(204);
    expect(world.store.getBase(world.baseId)).toBeUndefined();
    expect(world.audits("kb.delete")).toHaveLength(1);
    expect(world.logged).toEqual([]);
  });

  it.each([
    ["连接被重置", { kind: "reset" }],
    ["HTTP 503", { kind: "status", status: 503 }],
  ] as const)(
    "RAGFlow 不可达（%s）：503 kb_unavailable，行不变，不发停止",
    async (_label, fault) => {
      const world = await open();
      const document = seeded(world);
      world.fake.fault(DELETE_DOCUMENT, fault);
      const response = await remove(world, document.id);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(KB_UNAVAILABLE);
      expect(world.countOf(STOP)).toBe(0);
      expectUntouched(world, document);
    },
  );

  it("删除被拒（code:101）：400 kb_rejected，行不变", async () => {
    const world = await open();
    const document = seeded(world);
    world.fake.answer(DELETE_DOCUMENT, { code: 101, message: "Duplicate ids" });
    const response = await remove(world, document.id);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(KB_REJECTED);
    expectUntouched(world, document);
  });
});

describe("请求判定", () => {
  it.each([
    ["缺失", ""],
    ["为空", "?doc="],
    ["多值", `?doc=${ABSENT_ID}&doc=${ABSENT_ID}`],
    ["只有别的参数", `?id=${ABSENT_ID}`],
  ])("doc %s：400，零出站，没有审计", async (_label, query) => {
    const world = await open();
    const document = seeded(world);
    const audited = auditRows(world.fw.world).length;
    const response = await removeWith(world, query);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(BAD_REQUEST);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(world.lines()).toEqual([]);
    expect(world.rows()).toEqual([document]);
    expect(auditRows(world.fw.world)).toHaveLength(audited);
  });

  it("文档不属于该库：自己另一个库的文档与不存在的 id 都 404，零出站，两行都在", async () => {
    const world = await open();
    const document = seeded(world);
    const other = world.addBase("naive");
    const ragflowDocumentId = world.fake.addDocument(other.datasetId, {
      name: "b.md",
      content: "b",
    });
    const elsewhere = world.store.addDocument({
      kbId: other.baseId,
      ragflowDocumentId,
      name: "b.md",
      size: 1,
      source: "upload",
    });
    for (const id of [elsewhere.id, ABSENT_ID, document.ragflowDocumentId]) {
      const response = await remove(world, id);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND);
    }
    expect(world.lines()).toEqual([]);
    expect(world.rows()).toEqual([document]);
    expect(world.store.listDocuments(other.baseId)).toEqual([elsewhere]);
    expect(world.audits("kb.document_delete")).toEqual([]);
  });

  it("判定次序：doc 参数先于 state，state 先于文档归属", async () => {
    const world = await open();
    world.setState("rebuilding");
    expect((await removeWith(world, "")).json()).toEqual(BAD_REQUEST);
    expect((await remove(world, ABSENT_ID)).json()).toEqual(REBUILDING);
    expect(world.lines()).toEqual([]);
  });

  it("未登录 401，先于所有权", async () => {
    const world = await open();
    const document = seeded(world);
    const response = await remove(world, document.id, { who: "anonymous" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED_ENVELOPE);
    expect(world.lines()).toEqual([]);
    expect(world.rows()).toEqual([document]);
  });
});

describe("文档路由的所有权", () => {
  it("别人的库与不存在的 id：都 404，判定先于 body 与 doc 参数，零出站，没有审计，A 的行不变", async () => {
    const world = await open();
    const document = await ingested(world, "a.md", "a");
    const audited = auditRows(world.fw.world).length;
    const sent = world.fake.requests().length;
    const responses = [
      await remove(world, document.id, { who: "admin" }),
      await remove(world, document.id, { baseId: "e".repeat(32) }),
      await removeWith(world, "", { who: "admin" }),
      await remove(world, document.id, {
        who: "admin",
        body: { raw: "{not json", type: "application/json" },
      }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(responses[1]?.body).toBe(responses[0]?.body);
    expect(world.fake.requests()).toHaveLength(sent);
    expect(auditRows(world.fw.world)).toHaveLength(audited);
    expect(world.rows()).toEqual([document]);
  });

  it("重建中的别人的库：404 先于 state", async () => {
    const world = await open();
    const document = seeded(world);
    world.setState("rebuilding");
    expect((await remove(world, document.id, { who: "admin" })).json()).toEqual(NOT_FOUND);
    expect((await remove(world, document.id)).json()).toEqual(REBUILDING);
  });
});

describe("state 与写锁（design D20）", () => {
  it("重建失败后移出：rebuild_failed 时 204，该行已删除，RAGFlow 文档从当前数据集删除", async () => {
    const world = await open();
    const document = seeded(world);
    world.setState("rebuild_failed");
    expectRemoved(world, await remove(world, document.id), document.id);
    expect(world.lines()).toEqual([`DELETE /api/v1/datasets/${world.datasetId}/documents`]);
    expect(world.audits("kb.document_delete")).toHaveLength(1);
  });

  it("rebuilding：409 kb_rebuilding，零出站，行不变", async () => {
    const world = await open();
    const document = seeded(world);
    world.setState("rebuilding");
    const response = await remove(world, document.id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(REBUILDING);
    expect(world.lines()).toEqual([]);
    expectUntouched(world, document);
  });

  it("写锁被重建器持有：不排队，立即 409 kb_rebuilding，零出站", async () => {
    const world = await open();
    const document = seeded(world);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rebuild = world.locks.rebuild(world.baseId, () => held);
    const response = await remove(world, document.id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(REBUILDING);
    expect(world.lines()).toEqual([]);
    expect(world.rows()).toEqual([document]);
    release();
    await rebuild;
  });

  it("在途写操作结束之后才发删除", async () => {
    const world = await open();
    const document = seeded(world);
    const finish = holdWriteLock(world);
    const pending = remove(world, document.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(world.baseId)).toBe(1);
    });
    expect(world.lines()).toEqual([]);
    await finish();
    expectRemoved(world, await pending, document.id);
  });

  it("排队期间库转入 rebuilding：取锁后重判，409，零出站", async () => {
    const world = await open();
    const document = seeded(world);
    const finish = holdWriteLock(world);
    const pending = remove(world, document.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(world.baseId)).toBe(1);
    });
    world.setState("rebuilding");
    await finish();
    expect((await pending).json()).toEqual(REBUILDING);
    expect(world.lines()).toEqual([]);
    expect(world.rows()).toEqual([document]);
  });

  it("同一文档的两个移出并发：后到的取锁后 404，恰一次删除，恰一条 kb.document_delete", async () => {
    const world = await open();
    const document = seeded(world);
    const gate = world.fake.fault(DELETE_DOCUMENT, { kind: "hold" });
    const first = remove(world, document.id);
    await gate.reached;
    const second = remove(world, document.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(world.baseId)).toBe(1);
    });
    gate.release();
    expectRemoved(world, await first, document.id);
    const late = await second;
    expect(late.statusCode).toBe(404);
    expect(late.json()).toEqual(NOT_FOUND);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(1);
    expect(world.audits("kb.document_delete")).toHaveLength(1);
  });

  it("排队期间该行换了 RAGFlow 文档：删的是取锁后读到的那一份", async () => {
    const world = await open();
    const document = seeded(world);
    const replacement = world.fake.addDocument(world.datasetId, { name: "a.md", content: "a2" });
    const finish = holdWriteLock(world);
    const pending = remove(world, document.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(world.baseId)).toBe(1);
    });
    world.fw.world.db
      .prepare("UPDATE kb_documents SET ragflow_document_id = ? WHERE id = ?")
      .run(replacement, document.id);
    await finish();
    expectRemoved(world, await pending, document.id);
    expect(ragflowIds(world)).toEqual([document.ragflowDocumentId]);
  });
});

describe("审计", () => {
  it("detail 不含敏感内容：文件内容与 RAGFlow message 的哨兵进不了应答、审计与 stderr 记录，detail 恰为 {id, documentId}", async () => {
    const world = await open();
    const refused = await ingested(world, "a.md", `正文 ${CONTENT_SENTINEL}`);
    const document = await ingested(world, "b.md", `正文 ${CONTENT_SENTINEL}`);
    world.fake.answer(DELETE_DOCUMENT, { code: 101, message: MESSAGE_SENTINEL });
    const rejected = await remove(world, refused.id);
    expect(rejected.statusCode).toBe(400);
    world.fake.answer(DELETE_DOCUMENT, {
      code: 102,
      message: `These documents do not belong to dataset ${world.datasetId} or Document not found: ${MESSAGE_SENTINEL}`,
    });
    const removed = await remove(world, document.id);
    expect(removed.statusCode).toBe(204);
    for (const response of [rejected, removed]) {
      expect(response.body).not.toContain(CONTENT_SENTINEL);
      expect(response.body).not.toContain(MESSAGE_SENTINEL);
    }
    const audits = world.audits("kb.document_delete");
    expect(audits.map(({ detail }) => Object.keys(detail).sort())).toEqual([["documentId", "id"]]);
    const text = JSON.stringify(auditRows(world.fw.world));
    expect(text).not.toContain(CONTENT_SENTINEL);
    expect(text).not.toContain(MESSAGE_SENTINEL);
    expect(JSON.stringify(world.logged)).not.toContain(MESSAGE_SENTINEL);
  });
});
