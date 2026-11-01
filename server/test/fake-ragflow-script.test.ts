/**
 * s2a-kb-ragflow tasks 5.2（#1840）：假 RAGFlow 脚本层（`answer()` 与 `fault()`）的自测。边界抄自实测记录
 * `docs/reviews/2026-10-28-ragflow-rc2-api.md` 与 tasks.md 头部的四种故障，不从夹具导入。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";
import { callFake, type FakeCallOptions } from "./support/fake-ragflow-call.js";

const KEY = "wb-issue1840-fixture-key";
const ABSENT = "0123456789abcdef0123456789abcdef";

let fake: FakeRagflowServer;

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
});

afterEach(async () => {
  await fake.close();
});

const call = (method: string, path: string, options?: FakeCallOptions) =>
  callFake(fake.baseUrl, KEY, method, path, options);

describe("脚本化应答", () => {
  it("按路由应答一次，之后恢复；* 匹配一段路径", async () => {
    const id = fake.addDataset();
    fake.answer("POST /api/v1/datasets/*/documents/parse", { code: 500, message: "boom" });
    const path = `/api/v1/datasets/${id}/documents/parse`;
    expect((await call("POST", path, { json: { document_ids: [] } })).body).toMatchObject({
      code: 500,
    });
    expect((await call("POST", path, { json: { document_ids: [] } })).body).toMatchObject({
      code: 102,
    });
  });

  it("times 控制次数，先脚本化的先生效", async () => {
    fake.answer("GET /api/v1/system/version", { code: 100 }, { times: 2 });
    fake.answer("GET /api/v1/system/version", { code: 101 });
    const codes: unknown[] = [];
    for (let round = 0; round < 4; round += 1) {
      codes.push((await call("GET", "/api/v1/system/version")).body.code);
    }
    expect(codes).toEqual([100, 100, 101, 0]);
  });

  it("HTTP 状态可设：§12 的 404 与 401", async () => {
    fake.answer("GET /api/v1/system/version", { status: 401, code: 401, message: "x" });
    expect((await call("GET", "/api/v1/system/version")).status).toBe(401);
  });

  it.each([[108], [109], [999]])("code:%i 不在实测记录里，拒绝脚本化", (code) => {
    expect(() => {
      fake.answer("GET /api/v1/system/version", { code });
    }).toThrow(/record/u);
  });

  it("脚本化的路由不算未知路由", async () => {
    fake.answer("POST /api/v1/providers/*/instances", { code: 0, data: null, message: "success" });
    await call("POST", "/api/v1/providers/x/instances", { json: {} });
    expect(fake.unknownRoutes()).toEqual([]);
    expect(fake.requests()[0]?.unknown).toBe(false);
  });
});

describe("脚本化应答的边界（§12）", () => {
  const SCRIPTED: [string, string, string][] = [
    ["夹具有的路由", "POST /api/v1/datasets", "/api/v1/datasets"],
    ["夹具没有的路由", "POST /api/v1/providers/*/instances", "/api/v1/providers/x/instances"],
  ];

  it.each(SCRIPTED)("%s先过鉴权：没有 key 回记录的 401", async (_label, route, path) => {
    fake.answer(route, { code: 0, data: { id: "x" }, message: "success" });
    const answer = await call("POST", path, { json: {}, key: null });
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: 401, message: "Missing Authorization header" });
  });

  it.each(SCRIPTED)("%s先过鉴权：错误密钥回记录的 401", async (_label, route, path) => {
    fake.answer(route, { code: 0, data: { id: "x" }, message: "success" });
    const answer = await call("POST", path, { json: {}, key: "wrong" });
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: 401, message: "Invalid access token" });
  });

  it("被鉴权挡下的请求不消耗脚本", async () => {
    fake.answer("POST /api/v1/providers/*/instances", { code: 0, data: null, message: "success" });
    await call("POST", "/api/v1/providers/x/instances", { json: {}, key: null });
    const answer = await call("POST", "/api/v1/providers/x/instances", { json: {} });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 0 });
  });

  it("版本接口不要密钥，脚本化了也一样（§3）", async () => {
    fake.answer("GET /api/v1/system/version", { code: 100 });
    const answer = await call("GET", "/api/v1/system/version", { key: null });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 100 });
  });

  it.each([
    [400, 400],
    [401, 401],
    [404, 404],
    [200, 0],
    [200, 400],
    [200, 404],
  ])("HTTP %i + code:%i 是记录里的配对", async (status, code) => {
    fake.answer("GET /api/v1/system/version", { status, code });
    const answer = await call("GET", "/api/v1/system/version");
    expect(answer.status).toBe(status);
    expect(answer.body).toMatchObject({ code });
  });

  it.each([
    [400, 102],
    [500, 0],
    [200, 401],
    [404, 0],
    [401, 403],
    [403, 403],
  ])("HTTP %i + code:%i 不是记录里的配对，拒绝脚本化", (status, code) => {
    expect(() => {
      fake.answer("GET /api/v1/system/version", { status, code });
    }).toThrow(/record/u);
  });

  it("不写 status 就是 HTTP 200，code:401 同样拒绝", () => {
    expect(() => {
      fake.answer("GET /api/v1/system/version", { code: 401 });
    }).toThrow(/record/u);
  });
});

describe("故障注入", () => {
  const VERSION = "GET /api/v1/system/version";
  const version = () => call("GET", "/api/v1/system/version");

  it("hang：不应答；close 仍能结束", async () => {
    fake.fault(VERSION, { kind: "hang" });
    const pending = version().catch(() => "failed");
    await expect.poll(() => fake.requests().length).toBe(1);
    await fake.close();
    await expect(pending).resolves.toBe("failed");
    fake = await start({ apiKey: KEY });
  });

  it("hold：挂起后放行，照常处理", async () => {
    const gate = fake.fault(VERSION, { kind: "hold" });
    const pending = version();
    await gate.reached;
    gate.release();
    expect((await pending).body).toMatchObject({ code: 0, data: "v1.0.0-rc2" });
  });

  it("reset：不发应答头就断开", async () => {
    fake.fault(VERSION, { kind: "reset" });
    await expect(version()).rejects.toThrow();
  });

  it("cut：发出部分正文后断开", async () => {
    fake.fault(VERSION, { kind: "cut", body: '{"code":0' });
    await expect(version()).rejects.toThrow();
  });

  it("stall：发出部分正文后不再有字节", async () => {
    fake.fault(VERSION, { kind: "stall", body: "partial" });
    const response = await fetch(`${fake.baseUrl}/api/v1/system/version`);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(Buffer.from(first?.value ?? []).toString()).toBe("partial");
    await reader?.cancel();
  });

  it.each([["stall"], ["cut"]] as const)(
    "%s 不走 chunked：没给长度时 Content-Length 大于正文",
    async (kind) => {
      fake.fault(VERSION, { kind, body: "partial" });
      const response = await fetch(`${fake.baseUrl}/api/v1/system/version`);
      expect(response.headers.get("transfer-encoding")).toBeNull();
      expect(Number(response.headers.get("content-length"))).toBeGreaterThan(7);
      await response.body?.cancel();
    },
  );

  it("stall：给足长度就是完整应答", async () => {
    fake.fault(VERSION, { kind: "stall", headers: { "content-length": "7" }, body: "partial" });
    const response = await fetch(`${fake.baseUrl}/api/v1/system/version`);
    expect(response.headers.get("transfer-encoding")).toBeNull();
    await expect(response.text()).resolves.toBe("partial");
  });

  it("redirect：3xx 带 Location 与任意正文", async () => {
    fake.fault(VERSION, { kind: "redirect", location: "http://elsewhere.test/", body: "{}" });
    const answer = await version();
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe("http://elsewhere.test/");
  });

  it("status：5xx", async () => {
    fake.fault(VERSION, { kind: "status", status: 503, body: "upstream down" });
    const answer = await version();
    expect(answer.status).toBe(503);
    expect(answer.text).toBe("upstream down");
  });

  it("not_json：HTTP 200 的非 JSON", async () => {
    fake.fault(VERSION, { kind: "not_json" });
    const answer = await version();
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({});
  });

  it.each([['{"code":0}'], ["[0]"], ["1"], ['"text"'], ["null"]])(
    "not_json 的正文必须真不是 JSON：%s 拒绝",
    (body) => {
      expect(() => {
        fake.fault(VERSION, { kind: "not_json", body });
      }).toThrow(/not_json/u);
    },
  );

  it.each([
    ["not_json", { kind: "not_json", body: '{"code":109' }],
    ["not_json", { kind: "not_json", body: '{"code": 108,' }],
    ["oversize", { kind: "oversize", bytes: 100, envelope: { code: 108 } }],
    ["oversize", { kind: "oversize", bytes: 100, envelope: { code: 109 } }],
    ["status", { kind: "status", status: 500, body: '{"code":109}' }],
    ["redirect", { kind: "redirect", location: "/", body: '{"code":108}' }],
    ["cut", { kind: "cut", body: '{"code":109' }],
    ["stall", { kind: "stall", body: '{"code":108' }],
  ] as const)("%s 的正文不能带记录里没有的 code", (_label, fault) => {
    expect(() => {
      fake.fault(VERSION, fault);
    }).toThrow(/record/u);
  });

  it.each([[200], [302], [404]])("status 故障只收 5xx：%i 拒绝", (status) => {
    expect(() => {
      fake.fault(VERSION, { kind: "status", status });
    }).toThrow(/5xx/u);
  });

  it.each([
    [200, false],
    [299, false],
    [300, true],
    [302, true],
    [399, true],
    [400, false],
    [403, false],
  ])("redirect 故障的 status 只收 300–399：%i 接受与否 %s", async (status, accepted) => {
    const inject = () => {
      fake.fault(VERSION, { kind: "redirect", status, location: "/" });
    };
    if (!accepted) {
      expect(inject).toThrow(/3xx/u);
      return;
    }
    inject();
    expect((await version()).status).toBe(status);
  });

  it("oversize：恰为给定字节数，仍是合法 JSON", async () => {
    fake.fault(VERSION, { kind: "oversize", bytes: 1_048_577, envelope: { code: 0, data: "v" } });
    const answer = await version();
    expect(Buffer.byteLength(answer.text)).toBe(1_048_577);
    expect(answer.body).toEqual({ code: 0, data: "v" });
  });

  it("version：不符的版本串", async () => {
    fake.fault(VERSION, { kind: "version", value: "v1.0.0-rc1" });
    expect((await version()).body).toMatchObject({ code: 0, data: "v1.0.0-rc1" });
  });

  it("combo：防御性组合", async () => {
    fake.fault("DELETE /api/v1/datasets", { kind: "combo", deletedList: true });
    const answer = await call("DELETE", "/api/v1/datasets", { json: { ids: [ABSENT] } });
    expect(answer.text).toBe('{"code":0,"data":{"deleted":[]},"message":null}');
    fake.fault(VERSION, { kind: "combo", code: 403, message: "Permission denied" });
    expect((await version()).body).toMatchObject({ code: 403 });
  });

  it("combo：成功应答缺字段，HTTP 200 的 code:401", async () => {
    fake.fault(VERSION, { kind: "combo", code: 0, data: {} });
    const missing = await version();
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ code: 0, data: {} });
    fake.fault(VERSION, { kind: "combo", code: 401 });
    const denied = await version();
    expect(denied.status).toBe(200);
    expect(denied.body).toMatchObject({ code: 401 });
  });

  it.each([[500], [404], [108], [109]])(
    "combo 只接受 0、100、101、102、401、403：%i 拒绝",
    (code) => {
      expect(() => {
        fake.fault(VERSION, { kind: "combo", code });
      }).toThrow(/combo/u);
    },
  );

  it("没有分块下载这一种故障，未知种类直接抛", () => {
    expect(() => {
      fake.fault(VERSION, { kind: "chunked" } as never);
    }).toThrow(/fault/u);
  });

  it("脚本不改请求记录：挂起的请求也有查询串与 key 状态", async () => {
    fake.fault("GET /api/v1/datasets/*/documents", { kind: "reset" });
    await call("GET", `/api/v1/datasets/${ABSENT}/documents?page=2`).catch(() => undefined);
    expect(fake.requests()[0]).toMatchObject({ query: "page=2", bearer: "ok" });
  });
});
