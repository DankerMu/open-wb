/**
 * s2a-kb-ragflow tasks 9.2（#1846）：`POST /api/kb/bases`，组 9 首刀，只走 `parse_type:1`（knowledge-bases「知识库端点」、
 * ragflow-backend「RAGFlow 出站请求」的「结果映射」、design D9）。全部经 `createApp` + `app.inject()` 打假 RAGFlow，
 * 期望值是 spec 与实测记录的字面量。列表在 `kb-bases-list.test.ts`，删库在 `kb-bases-delete.test.ts`。
 *
 * `raptor` 或 `graph` 为真的建库由第二刀（#1869）开放：这里只留开关的取值，序列、回滚与删库在 `kb-bases-compile.test.ts`。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { templateOf } from "../src/kb/templates.js";
import {
  auditsOf,
  baseCount,
  COMPILE_OFF,
  createBase,
  createdBase,
  DELETE_DATASETS,
  deleteBase,
  EMBEDDING_MODEL,
  GENERIC_500,
  ownerIdOf,
  POST_DATASETS,
  VALID,
} from "./kb-bases-helpers.js";
import {
  BAD_REQUEST,
  bodyOf,
  chatWorld,
  configuredWorld,
  KB_UNAVAILABLE,
  LEAK,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { createPlainBase, hex } from "./kb-store-helpers.js";

const open = useSettingsWorlds();
const ready = () => configuredWorld(open);

const NOT_READY = {
  error: {
    code: "kb_not_ready",
    message: "知识库模型未就绪，请管理员在模型设置里保存知识库嵌入模型",
  },
};
const CONFLICT = { error: { code: "conflict", message: "同名资源已存在" } };
const LIMIT = { error: { code: "kb_limit", message: "知识库或文档数已达上限" } };
const REJECTED = { error: { code: "kb_rejected", message: "知识库服务拒绝了这个请求" } };
const REBUILD_REQUIRED = {
  error: {
    code: "kb_rebuild_required",
    message: "更换嵌入模型需要重建全部知识库，请确认后再保存",
  },
};
const REFUSE_BASE =
  "CREATE TRIGGER refuse_base BEFORE INSERT ON knowledge_bases BEGIN SELECT RAISE(ABORT, 'injected'); END";
const REFUSE_AUDIT =
  "CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_events WHEN NEW.kind = 'kb.create' BEGIN SELECT RAISE(ABORT, 'injected'); END";

/** spec：`parser_id` 在 `naive` 时为 `general`，其余等于模板名。 */
const TEMPLATES = [
  ["naive", "general"],
  ["book", "book"],
  ["email", "email"],
  ["laws", "laws"],
  ["manual", "manual"],
  ["one", "one"],
  ["paper", "paper"],
  ["picture", "picture"],
  ["presentation", "presentation"],
  ["qa", "qa"],
  ["table", "table"],
] as const;

async function expectRefused(world: World, body: unknown, envelope: unknown, status: number) {
  const response = await createBase(world, body);
  expect(response.statusCode).toBe(status);
  expect(bodyOf(response)).toEqual(envelope);
  expect(response.headers["cache-control"]).toBe("no-store");
}

describe("普通模板的建库请求", () => {
  it("naive 与 manual：只收到两次建数据集，parser_id 依次 general、manual，不含 chunk_method", async () => {
    const world = await ready();
    const first = await createdBase(world, "通用库", "naive");
    const second = await createdBase(world, "规范库", "manual");
    expect(routes(world.sent())).toEqual([POST_DATASETS, POST_DATASETS]);
    expect(world.sent().map(({ json }) => json)).toEqual([
      {
        name: `owb-${first.id}-g0`,
        parser_id: "general",
        parse_type: 1,
        embedding_model: EMBEDDING_MODEL,
      },
      {
        name: `owb-${second.id}-g0`,
        parser_id: "manual",
        parse_type: 1,
        embedding_model: EMBEDDING_MODEL,
      },
    ]);
  });

  it("十一种模板都能建，本地存模板名，发给 RAGFlow 的是 parser_id", async () => {
    const world = await ready();
    const seen: string[] = [];
    for (const [template] of TEMPLATES) {
      seen.push((await createdBase(world, `库 ${template}`, template)).template);
    }
    expect(seen).toEqual(TEMPLATES.map(([template]) => template));
    expect(world.fake.datasets().map(({ parserId }) => parserId)).toEqual(
      TEMPLATES.map(([, parserId]) => parserId),
    );
  });

  it("数据集名取锁内的当前代数，库行记下数据集 id 与代数，没有画布与模板组", async () => {
    const world = await ready();
    world.db.prepare("UPDATE kb_settings SET embedding_generation = 7").run();
    const view = await createdBase(world, "第七代");
    const [dataset] = world.fake.datasets();
    expect(dataset).toMatchObject({ name: `owb-${view.id}-g7`, embeddingModel: EMBEDDING_MODEL });
    expect(world.store.getBase(view.id)).toMatchObject({
      datasetId: dataset?.id,
      canvasId: null,
      templateGroupId: null,
      embeddingGeneration: 7,
    });
  });

  it("201 的 BaseView 恰十键，只有一次建数据集，不为应答读 RAGFlow", async () => {
    const world = await ready();
    const response = await createBase(world, { ...VALID, raptor: false, graph: false });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const view = response.json<{ createdAt: number }>();
    expect(view).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/u),
      name: "规范库",
      template: "manual",
      raptor: false,
      graph: false,
      state: "ready",
      stateMessage: null,
      documents: 0,
      compile: COMPILE_OFF,
      createdAt: expect.any(Number),
    });
    expect(Number.isSafeInteger(view.createdAt) && view.createdAt >= 0).toBe(true);
    expect(routes(world.sent())).toEqual([POST_DATASETS]);
  });

  it("kb.create 与插行同一事务：detail 恰四键，actor 是建库人，没有工作空间，标题不带用户文本", async () => {
    const world = await ready();
    const view = await createdBase(world, "哨兵库名", "paper");
    expect(auditsOf(world, "kb.create")).toEqual([
      {
        actorId: ownerIdOf(world, view.id),
        title: expect.not.stringContaining("哨兵库名"),
        detail: { id: view.id, template: "paper", raptor: false, graph: false },
        workspaceId: null,
      },
    ]);
  });
});

describe("开关校验", () => {
  it("未指定知识库对话模型时 graph:true 400；嵌入未配置 409；tag 与 audio 400；四次都没有出站", async () => {
    const configured = await ready();
    await expectRefused(configured, { ...VALID, graph: true }, BAD_REQUEST, 400);
    await expectRefused(configured, { name: "标签", template: "tag" }, BAD_REQUEST, 400);
    await expectRefused(configured, { name: "语音", template: "audio" }, BAD_REQUEST, 400);
    expect(configured.sent()).toEqual([]);

    const blank = await open();
    await expectRefused(blank, VALID, NOT_READY, 409);
    await expectRefused(blank, { ...VALID, raptor: true }, NOT_READY, 409);
    expect(blank.fake.requests()).toEqual([]);
    expect(baseCount(blank)).toBe(0);
  });

  it.each([
    ["raptor", { raptor: true }, { raptor: "pending", graph: "off" }],
    ["graph", { graph: true }, { raptor: "off", graph: "pending" }],
    ["两个开关", { raptor: true, graph: true }, { raptor: "pending", graph: "pending" }],
    ["一开一关", { raptor: true, graph: false }, { raptor: "pending", graph: "off" }],
  ])("%s 为真、对话模型已指定：201，开着的类型为 pending", async (_label, switches, compile) => {
    const world = await chatWorld(open);
    const response = await createBase(world, { ...VALID, ...switches });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ compile });
    expect(routes(world.sent())).toContain(POST_DATASETS);
    expect(baseCount(world)).toBe(1);
  });
});

describe("名称与 body", () => {
  it.each([
    ["缺 name", { template: "naive" }],
    ["缺 template", { name: "库" }],
    ["多余键", { ...VALID, parser_id: "general" }],
    ["name 空串", { name: "", template: "naive" }],
    ["name 65 码点", { name: "库".repeat(65), template: "naive" }],
    ["name 含换行", { name: "a\nb", template: "naive" }],
    ["name 含 NUL", { name: "a\u0000b", template: "naive" }],
    ["name 含 U+001F", { name: "a\u001fb", template: "naive" }],
    ["name 含 DEL", { name: "a\u007fb", template: "naive" }],
    ["name 不是字符串", { name: 1, template: "naive" }],
    ["template 不是字符串", { name: "库", template: 1 }],
    ["template 未知", { name: "库", template: "nope" }],
    ["template 是对象原型上的名字", { name: "库", template: "constructor" }],
    ["raptor 不是布尔", { ...VALID, raptor: "true" }],
    ["graph 为 null", { ...VALID, graph: null }],
    ["body 是数组", [VALID]],
  ])("%s：400，这一步不读库，所以先于嵌入未就绪", async (_label, body) => {
    const world = await open();
    await expectRefused(world, body, BAD_REQUEST, 400);
    expect(world.fake.requests()).toEqual([]);
  });

  it.each([
    ["64 个 BMP 码点", "库".repeat(64)],
    ["64 个星芒码点：按码点数，不按 UTF-16 单元", "😀".repeat(64)],
    ["带空格，不 trim", " 空 格 "],
    ["U+0085 不是 C0", "a\u0085b"],
  ])("%s：201，原样保存", async (_label, name) => {
    const world = await ready();
    expect((await createdBase(world, name)).name).toBe(name);
  });
});

describe("重名与上限", () => {
  it("同账号重名 409 conflict，没有出站；别的账号可以用同名", async () => {
    const world = await ready();
    await createdBase(world, "规范库", "manual");
    world.forget();
    await expectRefused(world, { name: "规范库", template: "naive" }, CONFLICT, 409);
    expect(world.sent()).toEqual([]);
    await createdBase(world, "规范库", "manual", "peer");
    expect(world.fake.datasets()).toHaveLength(2);
  });

  it("知识库数上限：第 50 个 201，第 51 个 409 kb_limit 且没有出站，上限按账号算", async () => {
    const world = await ready();
    const first = await createdBase(world, "第 1 个");
    const ownerId = ownerIdOf(world, first.id);
    for (let n = 2; n <= 49; n += 1) createPlainBase(world.store, hex(n), ownerId);
    await createdBase(world, "第 50 个");
    world.forget();

    await expectRefused(world, { name: "第 51 个", template: "naive" }, LIMIT, 409);
    await expectRefused(world, { name: "第 50 个", template: "naive" }, CONFLICT, 409);
    expect(world.sent()).toEqual([]);
    await createdBase(world, "第 51 个", "naive", "peer");
  });
});

describe("判定 2–4 在设置锁内，建库全程持锁（design D9、D20）", () => {
  it("嵌入设置持锁时建库排队，放行后读到锁内的设置行", async () => {
    const world = await open();
    const gate = world.fake.fault("PUT /api/v1/providers", { kind: "hold" });
    const saving = world.put({ embedding: world.embedding });
    await gate.reached;
    const creating = createBase(world, VALID);
    await vi.waitFor(() => {
      expect(world.locks.settingsWaiters()).toBe(1);
    });
    gate.release();
    expect((await saving).statusCode).toBe(200);
    expect((await creating).statusCode).toBe(201);
  });

  it("建库持锁时换嵌入身份排队，放行后读到新建的库：409 kb_rebuild_required，不下发", async () => {
    const world = await ready();
    const gate = world.fake.fault(POST_DATASETS, { kind: "hold" });
    const creating = createBase(world, VALID);
    await gate.reached;
    const saving = world.put({ embedding: { ...world.embedding, name: "text-embedding-3-small" } });
    await vi.waitFor(() => {
      expect(world.locks.settingsWaiters()).toBe(1);
    });
    gate.release();
    expect((await creating).statusCode).toBe(201);
    const refused = await saving;
    expect(refused.statusCode).toBe(409);
    expect(bodyOf(refused)).toEqual(REBUILD_REQUIRED);
    expect(routes(world.sent())).toEqual([POST_DATASETS]);
  });

  it("两个同名建库并发：后到的在锁内读到先建的行，409 conflict，只建一个数据集", async () => {
    const world = await ready();
    const gate = world.fake.fault(POST_DATASETS, { kind: "hold" });
    const first = createBase(world, VALID);
    await gate.reached;
    const second = createBase(world, VALID);
    await vi.waitFor(() => {
      expect(world.locks.settingsWaiters()).toBe(1);
    });
    gate.release();
    expect((await first).statusCode).toBe(201);
    expect(bodyOf(await second)).toEqual(CONFLICT);
    expect(world.fake.datasets()).toHaveLength(1);
  });

  it("有库时换嵌入身份 409 kb_rebuild_required，删掉之后 200；重建中的库让它 409 kb_rebuilding", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    const renamed = { embedding: { ...world.embedding, name: "text-embedding-3-small" } };
    expect(bodyOf(await world.put(renamed))).toEqual(REBUILD_REQUIRED);

    world.db.prepare("UPDATE knowledge_bases SET state = 'rebuilding'").run();
    const rebuilding = await world.put(renamed);
    expect(rebuilding.json()).toMatchObject({ error: { code: "kb_rebuilding" } });

    world.db.prepare("UPDATE knowledge_bases SET state = 'ready'").run();
    expect((await deleteBase(world, view.id)).statusCode).toBe(204);
    expect((await world.put(renamed)).statusCode).toBe(200);
  });
});

describe("结果映射（经 POST /api/kb/bases）", () => {
  it("code:0、code:101、HTTP 401、302、非 JSON、挂起：201、400、503 三次；message 不外泄", async () => {
    const world = await configuredWorld(open, { deadlines: { totalMs: 200 } });
    const { fake } = world;
    await createdBase(world, "成功的库");

    const failed = async (name: string) => createBase(world, { name, template: "naive" });
    fake.answer(POST_DATASETS, { code: 101, message: LEAK });
    const rejected = await failed("拒绝");
    expect(rejected.statusCode).toBe(400);
    expect(bodyOf(rejected)).toEqual(REJECTED);

    fake.answer(POST_DATASETS, { status: 401, code: 401, message: LEAK });
    const denied = await failed("鉴权");
    expect(denied.statusCode).toBe(503);
    expect(bodyOf(denied)).toEqual(KB_UNAVAILABLE);
    expect(world.logged).toEqual([{ event: "kb_upstream_auth_failed" }]);

    fake.fault(POST_DATASETS, { kind: "redirect", location: fake.baseUrl, body: LEAK });
    const redirected = await failed("重定向");
    fake.fault(POST_DATASETS, { kind: "not_json", body: LEAK });
    const garbled = await failed("非 JSON");
    fake.fault(POST_DATASETS, { kind: "hang" });
    const hung = await failed("挂起");
    for (const response of [redirected, garbled, hung]) {
      expect(response.statusCode).toBe(503);
      expect(bodyOf(response)).toEqual(KB_UNAVAILABLE);
    }

    expect(baseCount(world)).toBe(1);
    expect(auditsOf(world, "kb.create")).toHaveLength(1);
    expect(world.logged).toEqual([{ event: "kb_upstream_auth_failed" }]);
    expect(JSON.stringify(world.logged)).not.toContain(LEAK);
  });
});

describe("写入失败不留审计：建库一腿", () => {
  it("插行失败：删掉刚建的数据集，500，没有行，没有 kb.create", async () => {
    const world = await ready();
    world.db.exec(REFUSE_BASE);
    const response = await createBase(world, VALID);
    expect(response.statusCode).toBe(500);
    expect(bodyOf(response)).toEqual(GENERIC_500);
    expect(routes(world.sent())).toEqual([POST_DATASETS, DELETE_DATASETS]);
    expect(world.fake.datasets()).toEqual([]);
    expect(baseCount(world)).toBe(0);
    expect(auditsOf(world, "kb.create")).toEqual([]);
    expect(world.logged).toEqual([]);
  });

  it("审计写入失败：行随事务回滚，数据集同样删掉", async () => {
    const world = await ready();
    world.db.exec(REFUSE_AUDIT);
    expect((await createBase(world, VALID)).statusCode).toBe(500);
    expect(world.fake.datasets()).toEqual([]);
    expect(baseCount(world)).toBe(0);
  });

  it("回滚时数据集已不在：code:403 视为已删，不写 leak", async () => {
    const world = await ready();
    world.db.exec(REFUSE_BASE);
    world.fake.answer(DELETE_DATASETS, { code: 403, message: "Permission denied" });
    expect((await createBase(world, VALID)).statusCode).toBe(500);
    expect(world.logged).toEqual([]);
  });

  it.each([
    ["HTTP 503", { kind: "status", status: 503 }],
    ["缺 success_count", { kind: "combo", deletedList: true }],
  ] as const)("回滚的删除得 %s：恰一行 kb_dataset_leak，应答不变", async (_label, fault) => {
    const world = await ready();
    world.db.exec(REFUSE_BASE);
    world.fake.fault(DELETE_DATASETS, fault);
    const response = await createBase(world, VALID);
    expect(response.statusCode).toBe(500);
    expect(bodyOf(response)).toEqual(GENERIC_500);
    const [leaked] = world.fake.datasets();
    expect(world.logged).toEqual([{ event: "kb_dataset_leak", datasetId: leaked?.id }]);
    expect(baseCount(world)).toBe(0);
    expect(auditsOf(world, "kb.create")).toEqual([]);
  });
});

describe("模板表（design D9）", () => {
  /** 实测记录表 C：模板名到 `parser_id` 与末列的后缀，括号里的说明不算。 */
  function tableC(): Map<string, { parserId: string; suffixes: string[] }> {
    const record = new URL("../../docs/reviews/2026-10-28-ragflow-rc2-api.md", import.meta.url);
    const text = readFileSync(record, "utf8");
    const table = text.slice(text.indexOf("## 表 C"), text.indexOf("## 13."));
    const cells = table
      .split("\n")
      .filter((line) => line.startsWith("| "))
      .map((line) => line.split("|").map((cell) => cell.trim()));
    const entries = cells.map(([, name = "", parser = "", ...rest]) => {
      const suffixes = String(rest.at(-2)).replace(/（.*?）/gu, "");
      return [
        name,
        { parserId: /`(\w+)`/u.exec(parser)?.[1] ?? "", suffixes: suffixes.split(/[、；]/u) },
      ] as const;
    });
    return new Map(entries);
  }

  it.each(TEMPLATES)("%s 的 parser_id 与后缀表抄自表 C", (template, parserId) => {
    const expected = tableC().get(template);
    expect(expected?.parserId).toBe(parserId);
    expect(templateOf(template)?.parserId).toBe(parserId);
    expect([...(templateOf(template)?.suffixes ?? [])].sort()).toEqual(expected?.suffixes.sort());
  });

  it.each(["tag", "audio", "constructor", "general"])("%s 不是模板", (name) => {
    expect(templateOf(name)).toBeUndefined();
  });
});
