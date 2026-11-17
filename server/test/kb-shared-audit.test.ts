/**
 * #2034 s2c-kb-visibility 组 8：knowledge-bases「知识库审计」的「共享检索审计不含问句」（design D6）。u2（zhaoliu）以含哨兵的
 * 问句对 u1 的库 K（`group`，g1）做一次检索测试、再执行一次覆盖 K 与自己的库 A2 的 `kb_search`：恰两条 `kb.shared_retrieval`，
 * 都不含问句；`GET /api/audit` 按 actor 过滤，u1 看不到、管理员 u3 与检索者 u2 看得到。
 *
 * 经真实 `createApp`（`registerKb` 的透传 spy 取会话检索），真实 SQLite，打假 RAGFlow；问句带 `CONTENT_SENTINEL`，收尾的
 * stdout / stderr 哨兵检查（`kb-ingest-helpers.ts`）因此也覆盖它。期望值是规格与 tasks.md「组 8 约定」的字面量。
 */
import { describe, expect, it } from "vitest";
import { CONTENT_SENTINEL, useIngestWorlds } from "./kb-ingest-helpers.js";
import { seedBase, share, useSessionSearch } from "./kb-session-search-helpers.js";
import { send } from "./mounts-rest-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const open = useIngestWorlds();
const sessionSearch = useSessionSearch();

const A2 = "f6".repeat(16);
const Q = `销售额 ${CONTENT_SENTINEL}`;
const AUDIT_URL = "/api/audit?limit=200";

interface AuditEvent {
  kind: string;
  actorId: string;
  detail: unknown;
}

describe("共享检索审计不含问句", () => {
  it("检索测试与 kb_search 恰两条 kb.shared_retrieval，不含问句；u1 读不到，u3 与 u2 各读到两条", async () => {
    const world = await open();
    const K = world.baseId;
    const { db } = world.fw.world;
    share(world, K, "group");
    seedBase(world, { id: A2, name: "销售手册", ownerId: "u2", createdAt: 2_500 });
    const u2 = await cookieFor(world.fw.rest.app, "zhaoliu");

    const tested = await world.fw.rest.app.inject({
      method: "POST",
      url: `/api/kb/bases/${K}/retrieval`,
      headers: { cookie: u2, "content-type": "application/json" },
      payload: JSON.stringify({ question: Q, threshold: 0.2, vectorWeight: 0.7 }),
    });
    expect(tested.statusCode, tested.body).toBe(200);
    const searched = await sessionSearch().execute(
      "u2",
      { question: Q, kb_ids: [K, A2] },
      new AbortController().signal,
    );
    expect(searched.isError).toBe(false);

    const detail = `{"id":"${K}","name":"库 ${K}","ownerId":"u1","scope":{"scope":"group","groupId":"g1"}}`;
    const row = {
      actor_id: "u2",
      kind: "kb.shared_retrieval",
      title: "检索共享知识库",
      detail,
      workspace_id: null,
    };
    const rows = db
      .prepare(
        "SELECT actor_id, kind, title, detail, workspace_id FROM audit_events WHERE kind = 'kb.shared_retrieval' ORDER BY id",
      )
      .all()
      .map((entry) => ({ ...entry }));
    expect(rows).toStrictEqual([row, row]);
    const all = db.prepare("SELECT * FROM audit_events ORDER BY id").all();
    expect(all.filter((entry) => String(entry.detail).includes(A2))).toEqual([]);
    expect(JSON.stringify(all)).not.toContain(CONTENT_SENTINEL);
    expect(JSON.stringify(world.logged)).not.toContain(CONTENT_SENTINEL);

    const readers = [
      send(world.fw.rest, "member", "GET", AUDIT_URL),
      send(world.fw.rest, "admin", "GET", AUDIT_URL),
      world.fw.rest.app.inject({ method: "GET", url: AUDIT_URL, headers: { cookie: u2 } }),
    ];
    const shared = { kind: "kb.shared_retrieval", actorId: "u2", detail: JSON.parse(detail) };
    const expected = [[], [shared, shared], [shared, shared]];
    for (const [index, pending] of readers.entries()) {
      const response = await pending;
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain(CONTENT_SENTINEL);
      const events = response
        .json<{ events: AuditEvent[] }>()
        .events.filter(({ kind }) => kind === "kb.shared_retrieval")
        .map(({ kind, actorId, detail: value }) => ({ kind, actorId, detail: value }));
      expect(events).toStrictEqual(expected[index]);
    }
  });
});
