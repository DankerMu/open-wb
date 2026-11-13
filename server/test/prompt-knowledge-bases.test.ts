/**
 * Issue #1971 (s2c-kb-session tasks 7.4 / 7.5) the write side of knowledge-base references:
 * message-attachments「prompt 引用知识库」(拒绝, the admission and the stored column, 坏值) and「交给
 * omp 的附件后缀」(带知识库引用的后缀), chat-sessions「REST prompt 受理与补偿」(the four key sets);
 * issue #1972 (tasks 7.6 / 7.7) the read side: the snapshot's `knowledgeBases` (受理与快照, 坏值).
 * The main world is the production createApp → registerSessions assembly with the real kb module
 * against the fake RAGFlow (precedent: `openKbWorld` of session-host-tool-align.test.ts), a real
 * in-memory SQLite and `supervisor.prompt` a resolving spy, driven through `app.inject()`; the base
 * rows are inserted through the kb store. The knowledge-base-off world is the same without `kb`.
 * Oracles: the response, the spy's arguments, the `chat_messages` rows, the audit rows a request
 * added and the fake RAGFlow's request log. Expected values are the specs' literals.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import { createKbStore } from "../src/kb/store.js";
import { BAD_REQUEST_ENVELOPE, NOT_FOUND_ENVELOPE } from "./session-db-helpers.js";
import { A_PDF_SUFFIX, K1_STORED, K1_SUFFIX } from "./session-fork-helpers.js";
import {
  A_PDF,
  closeWorlds,
  expectAdmitted,
  expectEnvelope,
  expectRefused,
  openWorld,
  put,
  rowsOf,
  send,
  type World,
} from "./session-prompt-attachments-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  getSessionMessages,
  SESSION_ARCHIVED_ENVELOPE,
} from "./session-rest-helpers.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";
import { SANDBOX_DENIED_ENVELOPE } from "./workspace-upload-helpers.js";

const RAGFLOW_KEY = "wb-issue1971-ragflow-key";
/**
 * The bases the specs call k1, k2, k3 (and a k9 that does not exist): a base id is 32 lowercase hex
 * digits (migration 050's CHECK), so the literal `k1` stands for `K1` wherever a row holds it.
 */
const [K1, K2, K3, K9] = ["1", "2", "3", "9"].map((digit) => digit.padStart(32, "0")) as [
  string,
  string,
  string,
  string,
];
/** message-attachments「交给 omp 的附件后缀」's reference segment, with `k1` standing for K1. */
const K1_SEGMENT = K1_SUFFIX.replace("（k1）", `（${K1}）`);
const K1_COLUMN = K1_STORED.replace('"k1"', `"${K1}"`);
const fakes: FakeRagflowServer[] = [];

afterEach(async () => {
  await closeWorlds();
  for (const fake of fakes.splice(0)) {
    await fake.close();
  }
});

/**
 * The knowledge base on: zhangsan (`u1`) owns k1 `产品文档` and k3 `运维手册`, lisi (`u3`) owns k2.
 * `ragflow()` is the fake's request log as it is now.
 */
async function openKbWorld() {
  const fake = await start({ apiKey: RAGFLOW_KEY });
  fakes.push(fake);
  const world = await openWorld(undefined, {
    key: { read: () => RAGFLOW_KEY },
    baseUrl: fake.baseUrl,
    uploadMaxBytes: 1024,
    uploadMaxFiles: 10,
    log: () => {},
  });
  const store = createKbStore(world.db);
  for (const [id, ownerId, name] of [
    [K1, "u1", "产品文档"],
    [K2, "u3", "B 的库"],
    [K3, "u1", "运维手册"],
  ] as const) {
    store.createBase({
      id,
      ownerId,
      name,
      template: "naive",
      raptor: false,
      graph: false,
      datasetId: fake.addDataset(),
      canvasId: null,
      templateGroupId: null,
    });
  }
  return { ...world, ragflow: () => fake.requests().map((entry) => ({ ...entry })) };
}

function columnOf(world: World, session: string) {
  return world.db
    .prepare(
      "SELECT role, content, knowledge_bases FROM chat_messages WHERE session_id = ? ORDER BY id",
    )
    .all(session);
}

/**
 * The snapshot over `GET /api/sessions/:id/messages`: 200 and every reference exactly `{id, name}`;
 * each message's id, role and `knowledgeBases`.
 */
async function referencesOf(world: World, session: string) {
  const history = await getSessionMessages(world.app, session, world.cookie);
  expect(history.statusCode).toBe(200);
  const { messages } = history.json<{ messages: Array<Record<string, unknown>> }>();
  for (const message of messages) {
    for (const ref of message.knowledgeBases as object[]) {
      expect(Object.keys(ref)).toEqual(["id", "name"]);
    }
  }
  return messages.map((message) => [message.id, message.role, message.knowledgeBases]);
}

/** A 404 of the reference check: no row, dispatch, notification or audit row; its raw body. */
async function expectNotFound(world: World, session: string, body: unknown): Promise<string> {
  const before = rowsOf(world, session);
  const sent = await send(world, session, body);
  expectEnvelope(sent.response, 404, NOT_FOUND_ENVELOPE);
  expect(rowsOf(world, session)).toEqual(before);
  expect([sent.calls, sent.notified, sent.audit]).toEqual([[], 0, []]);
  return sent.response.body;
}

describe("prompt 引用知识库: 拒绝 (#1971)", () => {
  it("五个形状不合规的 knowledgeBases 都是 400，没有新增行、派发或审计，假 RAGFlow 没有收到请求", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();
    const ragflow = world.ragflow();
    const six = ["k1", "k2", "k3", "k4", "k5", "k6"];

    for (const knowledgeBases of ["k1", [1], [""], [K1, K1], six]) {
      const audit = await expectRefused(
        world,
        session,
        { message: "查一下", knowledgeBases },
        400,
        BAD_REQUEST_ENVELOPE,
      );
      expect(audit).toEqual([]);
    }
    expect(world.ragflow()).toEqual(ragflow);
  });

  it("引用不放宽空文本规则；四种键集之外的键集都是 400", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();

    for (const body of [
      { message: "  ", knowledgeBases: [K1] },
      { message: "查一下", knowledgeBases: [K1], extra: 1 },
      { message: "查一下", attachments: [A_PDF], knowledgeBases: [K1], extra: 1 },
      { knowledgeBases: [K1] },
      { message: 1, knowledgeBases: [K1] },
    ]) {
      expect(await expectRefused(world, session, body, 400, BAD_REQUEST_ENVELOPE)).toEqual([]);
    }
  });

  it("不存在的 id、别人的库与知识库关闭三个 404 的 body 逐字节相同，不访问 RAGFlow", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();
    const ragflow = world.ragflow();

    const missing = await expectNotFound(world, session, {
      message: "查一下",
      knowledgeBases: [K9],
    });
    const foreign = await expectNotFound(world, session, {
      message: "查一下",
      knowledgeBases: [K1, K2],
    });
    expect(world.ragflow()).toEqual(ragflow);

    const off = await openWorld();
    const offSession = await off.proj.session();
    const closed = await expectNotFound(off, offSession, {
      message: "查一下",
      knowledgeBases: [K1],
    });

    expect(foreign).toBe(missing);
    expect(closed).toBe(missing);
  });
});

describe("prompt 引用知识库: 判定次序 (#1971)", () => {
  it("被 sandbox 拒绝的附件先于形状不合规的引用：403 且恰一行审计", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();
    put(`${world.proj.root}/../other`, "secret.txt", "secret");

    const audit = await expectRefused(
      world,
      session,
      { message: "看看", attachments: ["../other/secret.txt"], knowledgeBases: "k1" },
      403,
      SANDBOX_DENIED_ENVELOPE,
    );

    expect(audit).toEqual([
      expect.objectContaining({
        kind: "sandbox.reject",
        actorId: "u1",
        workspaceId: world.proj.id,
      }),
    ]);
  });

  it("已归档会话先于形状不合规的引用：409 session_archived", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();
    world.db.prepare("UPDATE chat_sessions SET archived_at = 1 WHERE id = ?").run(session);

    const body = { message: "查一下", knowledgeBases: [K1, K1] };
    expect(await expectRefused(world, session, body, 409, SESSION_ARCHIVED_ENVELOPE)).toEqual([]);
  });

  it("合规的附件与不属于本人的引用：404，行数不变", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();

    await expectNotFound(world, session, {
      message: "看看",
      attachments: [A_PDF],
      knowledgeBases: [K2],
    });
  });
});

describe("prompt 引用知识库: 受理、后缀与落库 (#1971)", () => {
  it("带知识库引用的后缀：派发文本逐字节是原文接引用段，落库 content 为原文、列为紧凑 JSON", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();
    const ragflow = world.ragflow();

    const { text } = await expectAdmitted(world, session, {
      message: "查一下工单超时",
      knowledgeBases: [K1],
    });

    expect(text).toBe(
      `查一下工单超时\n\n用户在本条消息中引用了以下知识库，可以用 kb_search 检索：\n- 产品文档（${K1}）`,
    );
    expect(columnOf(world, session)).toEqual([
      {
        role: "user",
        content: "查一下工单超时",
        knowledge_bases: `[{"id":"${K1}","name":"产品文档"}]`,
      },
      { role: "assistant", content: "", knowledge_bases: null },
    ]);
    expect(world.ragflow()).toEqual(ragflow);
  });

  it("附件与引用：附件段在前、引用段在后，按请求次序", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();

    const { text } = await expectAdmitted(world, session, {
      message: "看看",
      attachments: [A_PDF],
      knowledgeBases: [K3, K1],
    });

    expect(text).toBe(
      `看看${A_PDF_SUFFIX}\n\n用户在本条消息中引用了以下知识库，可以用 kb_search 检索：\n- 运维手册（${K3}）\n- 产品文档（${K1}）`,
    );
    expect(columnOf(world, session)[0]).toMatchObject({
      knowledge_bases: `[{"id":"${K3}","name":"运维手册"},{"id":"${K1}","name":"产品文档"}]`,
    });
  });

  it("builtin 命令带引用按规格字面受理（规格缺口）：202，派发 /compact 接引用段", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();

    const { text } = await expectAdmitted(world, session, {
      message: "/compact",
      knowledgeBases: [K1],
    });

    expect(text).toBe(`/compact${K1_SEGMENT}`);
    expect(columnOf(world, session)[0]).toMatchObject({
      content: "/compact",
      knowledge_bases: K1_COLUMN,
    });
  });

  it.each([
    ["on", openKbWorld],
    ["off", () => openWorld()],
  ])(
    "knowledge base %s: `knowledgeBases: []` and its absence dispatch the same bytes and store NULL",
    async (_n, open) => {
      const world = await open();
      const texts: unknown[] = [];
      for (const body of [{ message: "查一下" }, { message: "查一下", knowledgeBases: [] }]) {
        const session = await world.proj.session();
        texts.push((await expectAdmitted(world, session, body)).text);
        expect(columnOf(world, session).map((row) => row.knowledge_bases)).toEqual([null, null]);
      }
      expect(texts).toEqual(["查一下", "查一下"]);
    },
  );

  it("wire 拒绝时补偿删除用户行，引用随行一并消失", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();
    world.wire.mockRejectedValueOnce(new HttpError("agent_unavailable"));

    const sent = await send(world, session, { message: "查一下", knowledgeBases: [K1] });

    expectEnvelope(sent.response, 502, AGENT_UNAVAILABLE_ENVELOPE);
    expect(sent.calls).toHaveLength(1);
    expect(columnOf(world, session)).toEqual([]);
    expect(
      world.db
        .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE knowledge_bases IS NOT NULL")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("store.knowledgeBaseRefs: message id → the stored snapshot; NULL and bad values have no entry", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();
    const first = await expectAdmitted(world, session, {
      message: "查一下",
      knowledgeBases: [K1],
    });
    const insert = world.db.prepare(
      "INSERT INTO chat_messages(session_id, role, content, status, created_at, knowledge_bases) VALUES (?, 'user', 'x', 'done', 0, ?)",
    );
    insert.run(session, "not json");
    insert.run(session, "[]");

    const refs = world.app.sessions.store.knowledgeBaseRefs(session);

    expect([...refs]).toEqual([[first.body.userMessageId, [{ id: K1, name: "产品文档" }]]]);
    expect(columnOf(world, session).map((row) => row.knowledge_bases)).toEqual([
      K1_COLUMN,
      null,
      "not json",
      "[]",
    ]);
  });
});

describe("prompt 引用知识库: 快照 (#1972)", () => {
  it("受理与快照: 带引用的用户消息读出受理时的 {id, name}，其余消息为 []；删库后再读值不变", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();
    const plain = (await expectAdmitted(world, session, { message: "你好" })).body.userMessageId;
    expect(world.app.sessions.store.finishTurn(plain + 1, "done")).toBe(true);
    const referred = (
      await expectAdmitted(world, session, { message: "查一下", knowledgeBases: [K1] })
    ).body.userMessageId;
    const expected = [
      [plain, "user", []],
      [plain + 1, "assistant", []],
      [referred, "user", [{ id: K1, name: "产品文档" }]],
      [referred + 1, "assistant", []],
    ];
    expect(await referencesOf(world, session)).toEqual(expected);

    const removed = await world.app.inject({
      method: "DELETE",
      url: `/api/kb/bases/${K1}`,
      headers: { cookie: world.cookie },
    });

    expect(removed.statusCode).toBe(204);
    expect(createKbStore(world.db).getBase(K1)).toBeUndefined();
    expect(await referencesOf(world, session)).toEqual(expected);
  });

  it("带外写到助手行的合法列表读作 []：快照 200，列原文不变", async () => {
    const world = await openKbWorld();
    const session = await world.proj.session();
    const user = (await expectAdmitted(world, session, { message: "查一下", knowledgeBases: [K1] }))
      .body.userMessageId;
    world.db
      .prepare("UPDATE chat_messages SET knowledge_bases = ? WHERE id = ?")
      .run(K1_COLUMN, user + 1);

    expect(await referencesOf(world, session)).toEqual([
      [user, "user", [{ id: K1, name: "产品文档" }]],
      [user + 1, "assistant", []],
    ]);
    expect(columnOf(world, session).map((row) => row.knowledge_bases)).toEqual([
      K1_COLUMN,
      K1_COLUMN,
    ]);
  });

  it.each(["not json", '[{"id":"k1"}]', '[{"id":"k1","name":"x","extra":1}]'])(
    "坏值 %s: 快照 200，该消息 knowledgeBases 为 []，列值未被改写",
    async (stored) => {
      const world = await openKbWorld();
      const session = await world.proj.session();
      const user = (await expectAdmitted(world, session, { message: "查一下" })).body.userMessageId;
      world.db
        .prepare("UPDATE chat_messages SET knowledge_bases = ? WHERE id = ?")
        .run(stored, user);

      expect(await referencesOf(world, session)).toEqual([
        [user, "user", []],
        [user + 1, "assistant", []],
      ]);
      expect(columnOf(world, session).map((row) => row.knowledge_bases)).toEqual([stored, null]);
    },
  );
});

describe("store-knowledge-bases.ts on its own (#1971)", () => {
  it("admitKnowledgeBases without a resolver (knowledge base off) is 404; no reference asks none", async () => {
    const { admitKnowledgeBases } = await import("../src/sessions/store-knowledge-bases.js");

    expect(() => admitKnowledgeBases(["k1"], "u1", undefined)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(admitKnowledgeBases([], "u1", undefined)).toEqual([]);
    expect(admitKnowledgeBases(undefined, "u1", undefined)).toEqual([]);
  });

  it("坏值: anything but a list of at most five distinct `{id, name}` reads as []", async () => {
    const { parseKnowledgeBases } = await import("../src/sessions/store-knowledge-bases.js");
    const item = (id: string) => `{"id":"${id}","name":"n${id}"}`;

    for (const stored of [
      "not json",
      '[{"id":"k1"}]',
      '[{"id":"k1","name":"x","extra":1}]',
      '{"id":"k1","name":"x"}',
      '[{"id":"","name":"x"}]',
      '[{"id":"k1","name":""}]',
      '[{"id":"k1","name":1}]',
      '[{"id":"k1","name":"a"},{"id":"k1","name":"b"}]',
      `[${["1", "2", "3", "4", "5", "6"].map(item).join(",")}]`,
      '["k1"]',
      "[null]",
      null,
      7,
    ]) {
      expect(parseKnowledgeBases(stored)).toEqual([]);
    }
  });

  it("a well-formed list reads back in its stored order, each element exactly two keys", async () => {
    const { parseKnowledgeBases } = await import("../src/sessions/store-knowledge-bases.js");

    expect(parseKnowledgeBases('[{"name":"b","id":"k2"},{"id":"k1","name":"a"}]')).toEqual([
      { id: "k2", name: "b" },
      { id: "k1", name: "a" },
    ]);
    expect(parseKnowledgeBases("[]")).toEqual([]);
    const five = `[${["1", "2", "3", "4", "5"].map((id) => `{"id":"k${id}","name":"x"}`).join(",")}]`;
    expect(parseKnowledgeBases(five)).toHaveLength(5);
  });
});
