/**
 * s2b-kb-retrieval tasks 6.3（#1919）：`POST /api/kb/settings/probe?target=rerank`（ragflow-backend「知识库模型设置」的
 * 「重排探活」「探活目标的取值」「非管理员」，knowledge-bases「知识库审计」的 `{rerankProbe}` 一行，http-service-skeleton
 * 「知识库的归属路由」的 `?target=rerank` 携 `{}`；design D7）。期望值是 spec 的字面量与 tasks.md「组 6 第二刀约定」。
 *
 * 假上游的 `/rerank` 只认 `EMBED_KEY`（`useSettingsWorlds` 用它启动假上游），所以走 `ok` 的重排模型指向假上游、带
 * `EMBED_KEY`；用的是哪把密钥由 `RERANK_KEY` 那一例证明。请求一律经 `world.call`，不带 body。
 */
import { describe, expect, it } from "vitest";
import {
  BAD_REQUEST,
  bodyOf,
  configuredWorld,
  EMBED_KEY,
  FORBIDDEN,
  RERANK_KEY,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";

const open = useSettingsWorlds();

const PROBE_ROUTE = "/api/kb/settings/probe";
const RERANK_PROBE = `${PROBE_ROUTE}?target=rerank`;
const NEVER = { status: "never", at: null, message: null };
const RERANK_TITLE = "探活知识库重排模型";
const SCORED = { body: { results: [{ index: 0, relevance_score: 0.5 }] } };
const VIEW_KEYS = [
  "bases",
  "chatModelId",
  "compileBases",
  "documents",
  "embedding",
  "rebuildFailed",
  "rebuilding",
  "rerank",
];

type Probe = { status: string; at: number | null; message: string | null };
type View = { embedding: { probe: Probe } | null; rerank: { name: string; probe: Probe } | null };

const viewOf = (response: { body: string }) => bodyOf(response) as View;
const rerankProbeOf = (response: { body: string }) => viewOf(response).rerank?.probe;
const embeddingProbeOf = (response: { body: string }) => viewOf(response).embedding?.probe;

/** 指向假上游的重排模型：`baseUrl` 要等世界开起来才知道。 */
const liveRerank = (world: World, apiKey = EMBED_KEY) => ({
  name: "qwen3-rerank",
  baseUrl: world.embedding.baseUrl,
  apiKey,
});

const rerankAudits = (world: World) =>
  world.audits().filter(({ detail }) => Object.hasOwn(detail as object, "rerankProbe"));

const probeAudits = (world: World) =>
  world
    .audits()
    .filter(({ detail }) =>
      ["probe", "rerankProbe"].some((key) => Object.hasOwn(detail as object, key)),
    )
    .map(({ detail }) => detail);

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** 只配了重排模型（可选再配嵌入模型），请求记录已清零。 */
async function rerankWorld(options: { embedding?: boolean; apiKey?: string } = {}): Promise<World> {
  const world = options.embedding === false ? await open() : await configuredWorld(open);
  expect((await world.put({ rerank: liveRerank(world, options.apiKey) })).statusCode).toBe(200);
  world.forget();
  return world;
}

/** 嵌入探活挂在假上游上，其后排入一个 `?target=rerank`；`release` 放行嵌入探活。 */
async function rerankBehindEmbedding(world: World) {
  const gate = world.upstream.embeddings.hold();
  const embedding = world.probe();
  await gate.reached;
  const rerank = world.call("POST", RERANK_PROBE, "admin");
  await settle();
  return { release: gate.release, embedding, rerank };
}

/** 重排探活挂在假上游上，其间保存 `body`，然后放行；返回探活的应答。 */
async function rerankAcrossSave(world: World, body: object) {
  const gate = world.upstream.rerank.hold();
  const pending = world.call("POST", RERANK_PROBE, "admin");
  await gate.reached;
  expect((await world.put(body)).statusCode).toBe(200);
  gate.release();
  return pending;
}

describe("重排探活", () => {
  it.each<[string, { status?: number; body?: unknown }, Partial<Probe>]>([
    ["2xx 且 relevance_score 为数字", SCORED, { status: "ok", message: null }],
    ["HTTP 401", { status: 401, body: { error: { message: "denied" } } }, { status: "failed" }],
    [
      "2xx 且 results 为空数组",
      { body: { results: [] } },
      { status: "failed", message: "响应不含重排分数" },
    ],
  ])("%s：200 no-store，八键读视图同随后的 GET，嵌入探活不变", async (_label, reply, expected) => {
    const world = await rerankWorld();
    world.upstream.rerank.answer(reply);
    const before = Date.now();
    const response = await world.call("POST", RERANK_PROBE, "admin");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(bodyOf(response) as object).sort()).toEqual(VIEW_KEYS);
    expect(bodyOf(response)).toEqual(bodyOf(await world.get()));
    const probe = rerankProbeOf(response);
    expect(probe).toMatchObject(expected);
    expect(probe?.at).toBeGreaterThanOrEqual(before);
    if (reply.status === 401) {
      expect(probe?.message).toMatch(/^HTTP 401/u);
    }
    expect(embeddingProbeOf(response)).toEqual(NEVER);
    expect(rerankAudits(world)).toEqual([
      { actorId: "u3", detail: { rerankProbe: expected.status } },
    ]);
    expect(world.sent()).toEqual([]);
    expect(world.upstream.embeddings.requests()).toEqual([]);
  });

  it("请求形状：POST <baseUrl>/rerank，body 恰为 {model, query, documents}；零个 RAGFlow 请求（没有 PATCH /models/default）", async () => {
    const world = await rerankWorld();
    expect((await world.call("POST", RERANK_PROBE, "admin")).statusCode).toBe(200);
    expect(world.upstream.rerank.requests()).toEqual([
      {
        authorization: `Bearer ${EMBED_KEY}`,
        body: { model: "qwen3-rerank", query: "ping", documents: ["ping"] },
      },
    ]);
    expect(world.sent()).toEqual([]);
  });

  it("审计：kind kb.settings，title 恰为探活知识库重排模型，detail 恰为 {rerankProbe}", async () => {
    const world = await rerankWorld();
    world.upstream.rerank.answer({ status: 500, body: "upstream secret text" });
    await world.call("POST", RERANK_PROBE, "admin");
    const rows = world.db
      .prepare("SELECT kind, actor_id, title, detail FROM audit_events WHERE title = ?")
      .all(RERANK_TITLE)
      .map((row) => ({ ...row, detail: JSON.parse(String(row.detail)) as unknown }));
    expect(rows).toEqual([
      {
        kind: "kb.settings",
        actor_id: "u3",
        title: RERANK_TITLE,
        detail: { rerankProbe: "failed" },
      },
    ]);
  });

  it("用的是重排模型的密钥：Bearer RERANK_KEY，上游 401 回显它，message、应答、审计与日志都不含哨兵", async () => {
    const world = await rerankWorld({ apiKey: RERANK_KEY });
    const response = await world.call("POST", RERANK_PROBE, "admin");
    expect(response.statusCode).toBe(200);
    expect(world.upstream.rerank.requests()[0]?.authorization).toBe(`Bearer ${RERANK_KEY}`);
    const probe = rerankProbeOf(response);
    expect(probe?.status).toBe("failed");
    expect(probe?.message).toMatch(/^HTTP 401/u);
    expect(probe?.message).not.toContain(RERANK_KEY);
    expect(response.body).not.toContain(RERANK_KEY);
    expect(JSON.stringify(world.audits())).not.toContain(RERANK_KEY);
    expect(JSON.stringify(world.logged)).not.toContain(RERANK_KEY);
    expect(rerankAudits(world)).toEqual([{ actorId: "u3", detail: { rerankProbe: "failed" } }]);
  });

  it("反方向：不带 target 的探活不改重排探活，也不发 /rerank", async () => {
    const world = await rerankWorld();
    const probed = rerankProbeOf(await world.call("POST", RERANK_PROBE, "admin"));
    expect(probed?.status).toBe("ok");
    world.upstream.embeddings.answer({ status: 500, body: "embedding broke" });
    const response = await world.probe();
    expect(embeddingProbeOf(response)?.status).toBe("failed");
    expect(rerankProbeOf(response)).toEqual(probed);
    expect(world.upstream.rerank.requests()).toHaveLength(1);
    expect(probeAudits(world)).toEqual([{ rerankProbe: "ok" }, { probe: "failed" }]);
  });
});

describe("重排未配置", () => {
  it("全新世界与只配了嵌入模型：?target=rerank 都是 400 bad_request，不是 kb_not_ready，没有审计", async () => {
    for (const world of [await open(), await configuredWorld(open)]) {
      const response = await world.call("POST", RERANK_PROBE, "admin");
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response)).toEqual(BAD_REQUEST);
      expect(probeAudits(world)).toEqual([]);
      expect(world.upstream.rerank.requests()).toEqual([]);
      expect(world.upstream.embeddings.requests()).toEqual([]);
    }
  });

  it("只配了重排、没配嵌入：?target=rerank 照常 200 ok", async () => {
    const world = await rerankWorld({ embedding: false });
    const response = await world.call("POST", RERANK_PROBE, "admin");
    expect(response.statusCode).toBe(200);
    expect(viewOf(response).embedding).toBeNull();
    expect(rerankProbeOf(response)?.status).toBe("ok");
  });

  it("轮到时才判：排在挂起的嵌入探活之后，其间清除重排模型，放行后 400，/rerank 零个请求", async () => {
    const world = await rerankWorld();
    const { release, embedding, rerank } = await rerankBehindEmbedding(world);
    expect((await world.put({ rerank: null })).statusCode).toBe(200);
    release();
    expect((await embedding).statusCode).toBe(200);
    const response = await rerank;
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual(BAD_REQUEST);
    expect(world.upstream.rerank.requests()).toEqual([]);
    expect(rerankAudits(world)).toEqual([]);
  });
});

describe("探活目标的取值", () => {
  it.each([
    "?target=",
    "?target",
    "?target=rerank&target=embedding",
    "?target=rerank&target=rerank",
    "?target=Rerank",
    "?target=RERANK",
    "?target=%20rerank",
    "?target=nope",
  ])("%s：400 bad_request no-store，不发请求，没有审计", async (query) => {
    const world = await rerankWorld();
    const audits = world.audits();
    const response = await world.call("POST", `${PROBE_ROUTE}${query}`, "admin");
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual(BAD_REQUEST);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(world.upstream.embeddings.requests()).toEqual([]);
    expect(world.upstream.rerank.requests()).toEqual([]);
    expect(world.sent()).toEqual([]);
    expect(world.audits()).toEqual(audits);
  });

  it("?target=embedding 与不带 target 相同：探嵌入，上游请求与审计 detail 都一样；其它查询键忽略", async () => {
    const world = await rerankWorld();
    for (const query of ["", "?target=embedding", "?foo=1"]) {
      const response = await world.call("POST", `${PROBE_ROUTE}${query}`, "admin");
      expect(response.statusCode).toBe(200);
      expect(embeddingProbeOf(response)?.status).toBe("ok");
      expect(rerankProbeOf(response)).toEqual(NEVER);
    }
    const [first, ...rest] = world.upstream.embeddings.requests();
    expect(rest).toEqual([first, first]);
    expect(first?.body).toEqual({ model: "bge-m3", input: "ping" });
    expect(probeAudits(world)).toEqual([{ probe: "ok" }, { probe: "ok" }, { probe: "ok" }]);
    expect(world.upstream.rerank.requests()).toEqual([]);
  });

  it("其它查询键与 target=rerank 并存：探重排", async () => {
    const world = await rerankWorld();
    const response = await world.call("POST", `${RERANK_PROBE}&foo=1`, "admin");
    expect(rerankProbeOf(response)?.status).toBe("ok");
    expect(world.upstream.embeddings.requests()).toEqual([]);
  });

  it("非法 target 不进探活链：嵌入探活挂起期间 ?target=nope 立即 400", async () => {
    const world = await rerankWorld();
    const gate = world.upstream.embeddings.hold();
    const pending = world.probe();
    await gate.reached;
    const rejected = await world.call("POST", `${PROBE_ROUTE}?target=nope`, "admin");
    expect(rejected.statusCode).toBe(400);
    expect(bodyOf(rejected)).toEqual(BAD_REQUEST);
    gate.release();
    expect((await pending).statusCode).toBe(200);
  });
});

describe("探活的权限与 body 次序", () => {
  it("普通用户对 ?target=rerank 与 ?target=nope 都 403，匿名 401，零个上游请求", async () => {
    const world = await rerankWorld();
    for (const query of ["?target=rerank", "?target=nope"]) {
      const response = await world.call("POST", `${PROBE_ROUTE}${query}`, "member");
      expect(response.statusCode).toBe(403);
      expect(bodyOf(response)).toEqual(FORBIDDEN);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const anonymous = await world.call("POST", RERANK_PROBE, "anonymous");
    expect(anonymous.statusCode).toBe(401);
    expect(bodyOf(anonymous)).toEqual(UNAUTHORIZED_ENVELOPE);
    expect(world.upstream.rerank.requests()).toEqual([]);
    expect(world.upstream.embeddings.requests()).toEqual([]);
  });

  it("管理员对 ?target=rerank 或 ?target=nope 携 {}：400，零个上游请求，没有审计", async () => {
    const world = await rerankWorld();
    const audits = world.audits();
    for (const query of ["?target=rerank", "?target=nope"]) {
      const response = await world.call("POST", `${PROBE_ROUTE}${query}`, "admin", {});
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response)).toEqual(BAD_REQUEST);
    }
    expect(world.upstream.rerank.requests()).toEqual([]);
    expect(world.upstream.embeddings.requests()).toEqual([]);
    expect(world.audits()).toEqual(audits);
  });
});

describe("重排探活只写回同一身份（design D20）", () => {
  it("在途期间换了重排模型：200 是当前读视图，名称为新的，探活为 never，没有 rerankProbe 审计", async () => {
    const world = await rerankWorld();
    const saved = { rerank: { ...liveRerank(world), name: "bge-reranker" } };
    const response = await rerankAcrossSave(world, saved);
    expect([response.statusCode, viewOf(response).rerank?.name]).toEqual([200, "bge-reranker"]);
    expect(bodyOf(response)).toEqual(bodyOf(await world.get()));
    expect(rerankProbeOf(response)).toEqual(NEVER);
    expect(rerankAudits(world)).toEqual([]);
  });

  it("独立性：在途期间改的是嵌入模型，重排探活照常写回，一条 {rerankProbe:ok}", async () => {
    const world = await rerankWorld();
    const saved = { embedding: { ...world.embedding, name: "bge-large" } };
    const response = await rerankAcrossSave(world, saved);
    expect(viewOf(response).embedding).toMatchObject({ name: "bge-large", probe: NEVER });
    expect(rerankProbeOf(response)?.status).toBe("ok");
    expect(rerankAudits(world)).toEqual([{ actorId: "u3", detail: { rerankProbe: "ok" } }]);
  });
});

describe("两种探活共用一条链", () => {
  it("排在挂起的嵌入探活之后：放行前 /rerank 零个请求，放行后两者 200，审计次序 probe → rerankProbe", async () => {
    const world = await rerankWorld();
    const { release, embedding, rerank } = await rerankBehindEmbedding(world);
    expect(world.upstream.rerank.requests()).toHaveLength(0);
    release();
    expect((await embedding).statusCode).toBe(200);
    expect((await rerank).statusCode).toBe(200);
    expect(probeAudits(world)).toEqual([{ probe: "ok" }, { rerankProbe: "ok" }]);
  });

  it("前一个失败不影响后一个：未配置重排时 400，紧接着不带 target 的探活照常 ok", async () => {
    const world = await configuredWorld(open);
    const rejected = await world.call("POST", RERANK_PROBE, "admin");
    expect(rejected.statusCode).toBe(400);
    expect(embeddingProbeOf(await world.probe())?.status).toBe("ok");
    expect(probeAudits(world)).toEqual([{ probe: "ok" }]);
  });
});
