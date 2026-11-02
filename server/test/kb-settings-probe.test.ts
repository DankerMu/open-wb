/**
 * s2a-kb-ragflow tasks 8.2（#1844）：`POST /api/kb/settings/probe`（ragflow-backend「知识库模型设置」的探活，design D7、
 * D20）。期望值是 spec 的字面量；假嵌入上游是 `fake-upstream.mjs` 的 `/embeddings`。
 *
 * 探活的请求在设置锁外，写回在锁内、按身份判定：所以「在途期间被改」靠挂起上游、「写回排在锁后」靠挂起假 RAGFlow。
 */
import { describe, expect, it, vi } from "vitest";
import {
  BAD_REQUEST,
  EMBED_KEY,
  FORBIDDEN,
  PATCH_DEFAULT,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";

const open = useSettingsWorlds();

const NEVER = { status: "never", at: null, message: null };
const NOT_READY = {
  error: {
    code: "kb_not_ready",
    message: "知识库模型未就绪，请管理员在模型设置里保存知识库嵌入模型",
  },
};
const PROBE_ROUTE = "/api/kb/settings/probe";

const bodyOf = (response: { body: string }) => JSON.parse(response.body) as unknown;

const probeOf = (response: { body: string }) =>
  (bodyOf(response) as { embedding: { probe: { status: string; message: string | null } } })
    .embedding.probe;

const probeAudits = (world: World) =>
  world.audits().filter(({ detail }) => Object.hasOwn(detail as object, "probe"));

async function configured(options?: Parameters<typeof open>[0]): Promise<World> {
  const world = await open(options);
  expect((await world.put({ embedding: world.embedding })).statusCode).toBe(200);
  world.forget();
  return world;
}

describe("探活", () => {
  it("依次 ok、HTTP 500、空数组：200，写回，各一条审计；不发 RAGFlow，不改嵌入身份", async () => {
    const world = await configured();
    const { embeddings } = world.upstream;
    const identity = world.store.settings().embedding;
    embeddings.answer({ body: { data: [{ embedding: [0.25, 0.5] }] } });
    embeddings.answer({ status: 500, body: { error: { message: "upstream broke" } } });
    embeddings.answer({ body: { data: [{ embedding: [] }] } });

    const before = Date.now();
    const statuses: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const response = await world.probe();
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      statuses.push(probeOf(response).status);
    }
    expect(statuses).toEqual(["ok", "failed", "failed"]);
    expect(probeAudits(world)).toEqual([
      { actorId: "u3", detail: { probe: "ok" } },
      { actorId: "u3", detail: { probe: "failed" } },
      { actorId: "u3", detail: { probe: "failed" } },
    ]);
    expect(world.sent()).toEqual([]);
    expect(world.store.settings().embedding).toEqual(identity);
    expect(world.store.embeddingApiKey()).toBe(EMBED_KEY);
    expect(world.store.settings().probe.at).toBeGreaterThanOrEqual(before);
  });

  it("读视图带写回的三个字段：ok 时 message 为 null", async () => {
    const world = await configured();
    const body = bodyOf(await world.probe()) as { embedding: { probe: unknown } };
    expect(body.embedding.probe).toEqual({
      status: "ok",
      at: expect.any(Number),
      message: null,
    });
    expect(bodyOf(await world.get())).toEqual(body);
  });

  it("请求形状：POST <baseUrl>/embeddings，body 恰为 {model, input}，Bearer 是嵌入模型的密钥", async () => {
    const world = await configured();
    await world.probe();
    expect(world.upstream.embeddings.requests()).toEqual([
      {
        authorization: `Bearer ${EMBED_KEY}`,
        body: { model: "bge-m3", input: "ping" },
      },
    ]);
  });

  it("未配置：409 kb_not_ready，没有审计，不发请求", async () => {
    const world = await open();
    const response = await world.probe();
    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toEqual(NOT_READY);
    expect(world.audits()).toEqual([]);
    expect(world.upstream.embeddings.requests()).toEqual([]);
  });

  it.each<[string, { status?: number; body?: unknown; headers?: Record<string, string> }]>([
    ["data 不是数组", { body: { data: {} } }],
    ["data 为空", { body: { data: [] } }],
    ["没有 embedding 字段", { body: { data: [{}] } }],
    ["embedding 不是数组", { body: { data: [{ embedding: "0.1" }] } }],
    ["embedding 含非数字", { body: { data: [{ embedding: [0.1, "0.2"] }] } }],
    ["不是 JSON", { body: "<html>not json</html>" }],
    ["JSON 不是对象", { body: "null" }],
  ])("2xx 但 %s：failed", async (_label, reply) => {
    const world = await configured();
    world.upstream.embeddings.answer(reply);
    expect(probeOf(await world.probe()).status).toBe("failed");
  });

  it("3xx 不跟随：failed，message 写状态码", async () => {
    const world = await configured();
    const target = `http://127.0.0.1:${String(world.upstream.port)}/v1/embeddings`;
    world.upstream.embeddings.answer({ status: 302, headers: { location: target } });
    const probe = probeOf(await world.probe());
    expect(probe.status).toBe("failed");
    expect(probe.message).toMatch(/^HTTP 302/u);
    expect(world.upstream.embeddings.requests()).toHaveLength(1);
  });

  it("超过 1 MiB 的 2xx 应答：failed", async () => {
    const world = await configured();
    const bytes = "x".repeat(1_048_577);
    world.upstream.embeddings.answer({ body: { data: [{ embedding: [0.1] }], padding: bytes } });
    expect(probeOf(await world.probe()).status).toBe("failed");
  });

  it("上游不可达：failed，无法连接", async () => {
    const world = await configured();
    await world.upstream.close();
    expect(probeOf(await world.probe())).toMatchObject({ status: "failed", message: "无法连接" });
  });

  it("上游挂起超过总期限：failed，超时（期限经装配注入缩短）", async () => {
    const world = await configured({ probeDeadlines: { totalDeadlineMs: 50 } });
    world.upstream.embeddings.hold();
    expect(probeOf(await world.probe())).toMatchObject({ status: "failed", message: "超时" });
  });

  it("上游回显密钥：写回的 message、应答与审计都不含哨兵", async () => {
    const world = await open();
    const leaked = "Snt1nelRejected1844Key";
    const embedding = { ...world.embedding, apiKey: leaked };
    expect((await world.put({ embedding })).statusCode).toBe(200);
    const response = await world.probe();
    expect(probeOf(response).status).toBe("failed");
    expect(probeOf(response).message).toMatch(/^HTTP 401/u);
    expect(response.body).not.toContain(leaked);
    expect(JSON.stringify(world.audits())).not.toContain(leaked);
    expect(JSON.stringify(world.store.settings())).not.toContain(leaked);
    expect(JSON.stringify(world.logged)).not.toContain(leaked);
  });

  it("探活的 message 不进审计：detail 恰为 {probe}", async () => {
    const world = await configured();
    world.upstream.embeddings.answer({ status: 500, body: "upstream secret text" });
    await world.probe();
    expect(probeAudits(world).at(-1)?.detail).toEqual({ probe: "failed" });
  });
});

describe("探活期间嵌入模型被改（design D20）", () => {
  it.each<[string, (world: World) => object]>([
    ["名称", ({ embedding }) => ({ ...embedding, name: "bge-large" })],
    ["地址", ({ embedding }) => ({ ...embedding, baseUrl: `${embedding.baseUrl}/moved` })],
    ["密钥", ({ embedding }) => ({ ...embedding, apiKey: "rotated-key" })],
  ])(
    "%s被改：探活回到 never，结果丢弃，没有这次的审计，应答是当前读视图",
    async (_label, changed) => {
      const world = await configured();
      expect(probeOf(await world.probe()).status).toBe("ok");
      const gate = world.upstream.embeddings.hold();
      const pending = world.probe();
      await gate.reached;
      const saved = changed(world);
      expect((await world.put({ embedding: saved })).statusCode).toBe(200);
      gate.release();

      const response = await pending;
      expect(response.statusCode).toBe(200);
      expect(bodyOf(response)).toEqual(bodyOf(await world.get()));
      expect(probeOf(response)).toEqual(NEVER);
      expect(world.store.settings().probe).toEqual(NEVER);
      expect(probeAudits(world)).toEqual([{ actorId: "u3", detail: { probe: "ok" } }]);
    },
  );

  it("身份没变的重存：探活状态保留", async () => {
    const world = await configured();
    const probed = (bodyOf(await world.probe()) as { embedding: { probe: unknown } }).embedding;
    const saved = await world.put({ embedding: world.embedding });
    expect(saved.statusCode).toBe(200);
    expect(probeOf(saved)).toEqual(probed.probe);
    expect(probeOf(saved).status).toBe("ok");
  });

  it("写回排在设置锁后：持锁的保存提交之后才判身份，结果丢弃", async () => {
    const world = await configured();
    const gate = world.fake.fault(PATCH_DEFAULT, { kind: "hold" });
    const saving = world.put({ embedding: { ...world.embedding, name: "bge-large" } });
    await gate.reached;

    const probing = world.probe();
    await vi.waitFor(() => {
      expect(world.upstream.embeddings.requests()).toHaveLength(1);
    });
    let settled = false;
    void probing.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    gate.release();
    expect((await saving).statusCode).toBe(200);
    expect(probeOf(await probing)).toEqual(NEVER);
    expect(probeAudits(world)).toEqual([]);
  });

  it("身份没变：挂起的探活照常写回", async () => {
    const world = await configured();
    const gate = world.upstream.embeddings.hold();
    const pending = world.probe();
    await gate.reached;
    expect((await world.put({ chatModelId: null })).statusCode).toBe(200);
    gate.release();
    expect(probeOf(await pending).status).toBe("ok");
    expect(probeAudits(world)).toEqual([{ actorId: "u3", detail: { probe: "ok" } }]);
  });
});

describe("探活的权限与 body", () => {
  it("普通用户 403，匿名 401，都不发请求", async () => {
    const world = await configured();
    const member = await world.probe("member");
    expect(member.statusCode).toBe(403);
    expect(bodyOf(member)).toEqual(FORBIDDEN);
    expect(member.headers["cache-control"]).toBe("no-store");
    const anonymous = await world.probe("anonymous");
    expect(anonymous.statusCode).toBe(401);
    expect(bodyOf(anonymous)).toEqual(UNAUTHORIZED_ENVELOPE);
    expect(world.upstream.embeddings.requests()).toEqual([]);
  });

  it.each([
    ["{}", "application/json"],
    ['{"a":', "application/json"],
    ["1", "application/json"],
  ])("bodyless：携 %s 是 exact 400，发生在探活之前", async (payload, contentType) => {
    const world = await configured();
    const response = await world.raw("POST", PROBE_ROUTE, payload, contentType);
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual(BAD_REQUEST);
    expect(world.upstream.embeddings.requests()).toEqual([]);
  });
});
