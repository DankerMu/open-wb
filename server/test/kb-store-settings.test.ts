/**
 * Issue #1836（任务 7.2）：`kb/store.ts` 的 `kb_settings` 一行（design D7、D8）：设置读写、确认重建、重试与探活写回，
 * 经 `openDb(":memory:")` 的真实迁移与 `createKbStore` 这一个公开入口测。期望值是 spec 与 design 里的字面量；
 * 密钥取值是哨兵，证明读视图带不出来。Issue #1912（s2b-kb-retrieval 任务 1.3）：迁移 051 的重排三列与重排探活
 * （design D5、D6；knowledge-bases「重排三列整组写入」）。
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  BOOM,
  boom,
  createCompileBase,
  createPlainBase,
  EMBEDDING,
  FOREIGN_KEY,
  hex,
  insertRow,
  KEY_SENTINEL,
  MODEL_ROW,
  NEXT,
  NEXT_PLAIN,
  REBUILD_FAILED,
  rows,
  settingsRow,
  T0,
  useKbDatabases,
} from "./kb-store-helpers.js";

const fresh = useKbDatabases();

describe("kb store: 设置", () => {
  it("迁移后的设置：没有嵌入模型，代数 0，探活 never", () => {
    const { store } = fresh();
    expect(store.settings()).toEqual({
      embedding: null,
      embeddingGeneration: 0,
      probe: { status: "never", at: null, message: null },
      rerank: null,
      rerankProbe: { status: "never", at: null, message: null },
      chatModelId: null,
      rebuildActorId: null,
      updatedAt: 0,
    });
    expect(store.embeddingApiKey()).toBeNull();
    expect(store.rerankApiKey()).toBeNull();
  });

  it("保存嵌入模型：读视图只有名称与地址，密钥只经 embeddingApiKey 读出", () => {
    const { db, store } = fresh();
    const seen: unknown[] = [];
    const saved = store.saveSettings({ embedding: EMBEDDING }, (view) => seen.push(view));
    expect(saved).toEqual({
      embedding: { name: "bge-m3", baseUrl: "http://embed/v1" },
      embeddingGeneration: 0,
      probe: { status: "never", at: null, message: null },
      rerank: null,
      rerankProbe: { status: "never", at: null, message: null },
      chatModelId: null,
      rebuildActorId: null,
      updatedAt: T0,
    });
    expect(seen).toEqual([saved]);
    expect(JSON.stringify(store.settings())).not.toContain(KEY_SENTINEL);
    expect(store.embeddingApiKey()).toBe(KEY_SENTINEL);
    expect(settingsRow(db)).toMatchObject({
      embedding_name: "bge-m3",
      embedding_base_url: "http://embed/v1",
      embedding_api_key: KEY_SENTINEL,
    });
  });

  it("保存对话模型不动嵌入模型，保存嵌入模型不动对话模型，null 即取消指定", () => {
    const { db, store } = fresh();
    insertRow(db, "models", MODEL_ROW);
    store.saveSettings({ embedding: EMBEDDING });
    expect(store.saveSettings({ chatModelId: "m1" })).toMatchObject({
      embedding: { name: "bge-m3" },
      chatModelId: "m1",
    });
    expect(store.saveSettings({ embedding: { ...EMBEDDING, name: "bge-large" } })).toMatchObject({
      embedding: { name: "bge-large" },
      chatModelId: "m1",
    });
    expect(store.saveSettings({ chatModelId: null })).toMatchObject({
      embedding: { name: "bge-large" },
      chatModelId: null,
    });
    expect(store.embeddingApiKey()).toBe(KEY_SENTINEL);
  });

  it("不确认重建时，保存不动代数、库状态与 rebuild_actor_id", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    expect(store.saveSettings({ embedding: EMBEDDING })).toMatchObject({
      embeddingGeneration: 0,
      rebuildActorId: null,
    });
    expect(store.getBase(hex(1))).toMatchObject({ state: "ready" });
  });

  it("未知的对话模型被外键拒绝，同一次保存的嵌入模型一起回滚", () => {
    const { store } = fresh();
    expect(() => store.saveSettings({ embedding: EMBEDDING, chatModelId: "nope" })).toThrow(
      FOREIGN_KEY,
    );
    expect(store.settings().embedding).toBeNull();
    expect(store.embeddingApiKey()).toBeNull();
  });

  it("within 抛出即整体回滚", () => {
    const { store } = fresh();
    expect(() => store.saveSettings({ embedding: EMBEDDING }, boom)).toThrow(BOOM);
    expect(store.settings()).toMatchObject({ embedding: null, updatedAt: 0 });
  });

  it("确认重建：代数加一，全部知识库置 rebuilding，记下发起的管理员，失败库残留的一代留给 D8 第 1 步", () => {
    const { db, store } = fresh();
    store.saveSettings({ embedding: EMBEDDING });
    createPlainBase(store, hex(1));
    createCompileBase(store, hex(2));
    createPlainBase(store, hex(3));
    store.setRebuildGeneration(hex(2), NEXT);
    store.failRebuild(hex(2), REBUILD_FAILED);
    vi.setSystemTime(T0 + 5);

    const seen: unknown[] = [];
    const saved = store.saveSettings(
      { embedding: { ...EMBEDDING, name: "bge-large" }, rebuildActorId: "u3" },
      (view) => seen.push([view.embeddingGeneration, store.countBasesInState("rebuilding")]),
    );

    expect(saved).toMatchObject({
      embedding: { name: "bge-large" },
      embeddingGeneration: 1,
      rebuildActorId: "u3",
      updatedAt: T0 + 5,
    });
    expect(seen).toEqual([[1, 3]]);
    expect(rows(db, "knowledge_bases")).toMatchObject(
      Array(3).fill({ state: "rebuilding", state_message: null, embedding_generation: 0 }),
    );
    expect(store.getBase(hex(1))?.updatedAt).toBe(T0 + 5);
    expect(store.getBase(hex(2))).toMatchObject({
      rebuildDatasetId: "ds-new",
      rebuildCanvasId: "canvas-new",
      rebuildTemplateGroupId: "group-new",
    });
  });

  it("确认重建的 within 抛出：设置、代数与库状态都不变", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    expect(() => store.saveSettings({ embedding: EMBEDDING, rebuildActorId: "u3" }, boom)).toThrow(
      BOOM,
    );
    expect(store.settings()).toMatchObject({
      embedding: null,
      embeddingGeneration: 0,
      rebuildActorId: null,
    });
    expect(store.getBase(hex(1))).toMatchObject({ state: "ready" });
  });

  it("重试只把 rebuild_failed 置回 rebuilding，改写发起者，不动代数，残留的一代留给 D8 第 1 步", () => {
    const { store } = fresh();
    store.saveSettings({ embedding: EMBEDDING, rebuildActorId: "u1" });
    createCompileBase(store, hex(1));
    createPlainBase(store, hex(2));
    createPlainBase(store, hex(3));
    store.setRebuildGeneration(hex(1), NEXT);
    store.setRebuildGeneration(hex(3), NEXT_PLAIN);
    store.failRebuild(hex(1), REBUILD_FAILED);
    store.failRebuild(hex(3), REBUILD_FAILED);
    vi.setSystemTime(T0 + 5);

    const seen: string[][] = [];
    const retried = store.retryFailedRebuilds("u3", (bases) => {
      seen.push(bases.map((base) => base.id).sort());
    });

    expect(retried.map((base) => base.id).sort()).toEqual([hex(1), hex(3)]);
    expect(seen).toEqual([[hex(1), hex(3)]]);
    expect(store.settings()).toMatchObject({
      embeddingGeneration: 1,
      rebuildActorId: "u3",
      updatedAt: T0 + 5,
    });
    expect(store.getBase(hex(1))).toMatchObject({
      state: "rebuilding",
      stateMessage: null,
      rebuildDatasetId: "ds-new",
      rebuildCanvasId: "canvas-new",
      rebuildTemplateGroupId: "group-new",
    });
    expect(store.getBase(hex(2))).toMatchObject({ state: "ready", updatedAt: T0 });
    expect(store.getBase(hex(3))).toMatchObject({
      state: "rebuilding",
      stateMessage: null,
      rebuildDatasetId: "ds-new",
      rebuildCanvasId: null,
      rebuildTemplateGroupId: null,
    });
  });

  it("没有失败库时重试不写库，不调 within", () => {
    const { store } = fresh();
    store.saveSettings({ embedding: EMBEDDING, rebuildActorId: "u1" });
    createPlainBase(store, hex(1));
    vi.setSystemTime(T0 + 5);
    const within = vi.fn();
    expect(store.retryFailedRebuilds("u3", within)).toEqual([]);
    expect(within).not.toHaveBeenCalled();
    expect(store.settings()).toMatchObject({ rebuildActorId: "u1", updatedAt: T0 });
  });

  it("重试的 within 抛出：库状态与发起者都不变", () => {
    const { store } = fresh();
    store.saveSettings({ embedding: EMBEDDING, rebuildActorId: "u1" });
    createPlainBase(store, hex(1));
    store.failRebuild(hex(1), REBUILD_FAILED);
    expect(() => store.retryFailedRebuilds("u3", boom)).toThrow(BOOM);
    expect(store.settings().rebuildActorId).toBe("u1");
    expect(store.getBase(hex(1))).toMatchObject({
      state: "rebuild_failed",
      stateMessage: REBUILD_FAILED,
    });
  });

  it("探活写回三列，不动 updated_at 与嵌入身份；within 抛出即回滚", () => {
    const { store } = fresh();
    store.saveSettings({ embedding: EMBEDDING });
    vi.setSystemTime(T0 + 5);
    const result = { status: "failed", at: T0 + 5, message: "上游拒绝" } as const;
    expect(() => store.recordEmbeddingProbe(EMBEDDING, result, boom)).toThrow(BOOM);
    expect(store.settings().probe).toEqual({ status: "never", at: null, message: null });

    const seen: unknown[] = [];
    expect(
      store.recordEmbeddingProbe(EMBEDDING, result, (view) => seen.push(view.probe)),
    ).toMatchObject({
      view: {
        embedding: { name: "bge-m3", baseUrl: "http://embed/v1" },
        probe: result,
        updatedAt: T0,
      },
      recorded: true,
    });
    expect(seen).toEqual([result]);
    const ok = { status: "ok", at: T0 + 6, message: null } as const;
    expect(store.recordEmbeddingProbe(EMBEDDING, ok).view.probe).toEqual(ok);
    expect(store.embeddingApiKey()).toBe(KEY_SENTINEL);
  });

  describe("嵌入模型换身份时探活重置", () => {
    const NEVER = { status: "never", at: null, message: null };
    const earlier = { status: "failed", at: T0 + 1, message: "上游拒绝" } as const;
    const late = { status: "ok", at: T0 + 5, message: null } as const;
    const CHANGES: [string, Partial<typeof EMBEDDING>][] = [
      ["名称", { name: "bge-large" }],
      ["地址", { baseUrl: "http://other/v1" }],
      ["密钥", { apiKey: "rotated-key" }],
    ];

    function probed() {
      const opened = fresh();
      opened.store.saveSettings({ embedding: EMBEDDING });
      opened.store.recordEmbeddingProbe(EMBEDDING, earlier);
      return opened;
    }

    it.each(CHANGES)("%s变了：探活三列重置，within 里已是重置后的状态", (_field, change) => {
      const { db, store } = probed();
      const seen: unknown[] = [];
      const embedding = { ...EMBEDDING, ...change };
      const saved = store.saveSettings({ embedding }, (view) => seen.push(view.probe));
      expect(saved.probe).toEqual(NEVER);
      expect(seen).toEqual([NEVER]);
      expect(settingsRow(db)).toMatchObject({
        embedding_probe_status: "never",
        embedding_probe_at: null,
        embedding_probe_message: null,
      });
    });

    it.each(CHANGES)("%s变了之后：旧身份的探活写回丢弃，within 不调用", (_field, change) => {
      const { store } = probed();
      store.saveSettings({ embedding: { ...EMBEDDING, ...change } });

      const within = vi.fn();
      expect(store.recordEmbeddingProbe(EMBEDDING, late, within)).toMatchObject({
        view: { probe: NEVER },
        recorded: false,
      });
      expect(within).not.toHaveBeenCalled();
      expect(store.settings().probe).toEqual(NEVER);
    });

    it.each(CHANGES)("%s变了而 within 抛出：身份与探活一起回滚", (_field, change) => {
      const { store } = probed();
      const embedding = { ...EMBEDDING, ...change };
      expect(() => store.saveSettings({ embedding }, boom)).toThrow(BOOM);
      expect(store.settings().probe).toEqual(earlier);
      expect(store.settings().embedding?.name).toBe(EMBEDDING.name);
      expect(store.settings().embedding?.baseUrl).toBe(EMBEDDING.baseUrl);
      expect(store.embeddingApiKey()).toBe(EMBEDDING.apiKey);
    });

    it("身份没变（同名同址同密钥重存）：探活保留", () => {
      const { store } = probed();
      expect(store.saveSettings({ embedding: EMBEDDING }).probe).toEqual(earlier);
      expect(store.settings().probe).toEqual(earlier);
    });

    it("只改 chatModelId 不碰嵌入模型：探活保留", () => {
      const { db, store } = probed();
      insertRow(db, "models", MODEL_ROW);
      expect(store.saveSettings({ chatModelId: "m1" }).probe).toEqual(earlier);
    });
  });

  it("没有配置嵌入模型时探活写回丢弃", () => {
    const { store } = fresh();
    const within = vi.fn();
    const result = { status: "ok", at: T0 + 5, message: null } as const;
    expect(store.recordEmbeddingProbe(EMBEDDING, result, within).recorded).toBe(false);
    expect(within).not.toHaveBeenCalled();
    expect(store.settings().probe).toEqual({ status: "never", at: null, message: null });
  });
});

/** 重排模型的密钥哨兵与嵌入的不同：读视图里找不到它，才说明是重排这一列没漏出来。 */
const RERANK_KEY_SENTINEL = "rerank-sentinel-rerank";
const RERANK = { name: "bge-reranker", baseUrl: "http://rerank/v1", apiKey: RERANK_KEY_SENTINEL };
const NEVER = { status: "never", at: null, message: null } as const;
const RERANK_CHANGES: [string, Partial<typeof RERANK>][] = [
  ["名称", { name: "bge-reranker-large" }],
  ["地址", { baseUrl: "http://rerank-other/v1" }],
  ["密钥", { apiKey: "rotated-rerank-key" }],
];

/** 裸行里的重排三列。 */
function rerankColumns(db: Parameters<typeof settingsRow>[0]) {
  const row = settingsRow(db) as Record<string, unknown>;
  return [row.rerank_name, row.rerank_base_url, row.rerank_api_key];
}

/** 三列同为 NULL 或同为非 NULL（knowledge-bases「重排三列整组写入」）。 */
function expectWholeGroup(db: Parameters<typeof settingsRow>[0]): void {
  const nulls = rerankColumns(db).filter((value) => value === null).length;
  expect([0, 3]).toContain(nulls);
}

describe("kb store: 重排模型", () => {
  const probedOk = { status: "ok", at: T0 + 1, message: null } as const;

  function rerankProbed() {
    const opened = fresh();
    opened.store.saveSettings({ rerank: RERANK });
    opened.store.recordRerankProbe(RERANK, probedOk);
    return opened;
  }

  it("SettingsPatch.rerank 只能是完整三项或 null：类型层防部分写入", () => {
    type Patch = NonNullable<Parameters<ReturnType<typeof fresh>["store"]["saveSettings"]>[0]>;
    expectTypeOf<Patch["rerank"]>().toEqualTypeOf<
      { name: string; baseUrl: string; apiKey: string } | null | undefined
    >();
  });

  it("首次保存：三列写入，探活 never，updated_at 更新；读视图不带密钥，密钥只经 rerankApiKey 读出", () => {
    const { db, store } = fresh();
    vi.setSystemTime(T0 + 5);
    const seen: unknown[] = [];
    const saved = store.saveSettings({ rerank: RERANK }, (view) => seen.push(view));
    expect(saved).toEqual({
      embedding: null,
      embeddingGeneration: 0,
      probe: NEVER,
      rerank: { name: "bge-reranker", baseUrl: "http://rerank/v1" },
      rerankProbe: NEVER,
      chatModelId: null,
      rebuildActorId: null,
      updatedAt: T0 + 5,
    });
    expect(seen).toEqual([saved]);
    expect(store.settings()).toEqual(saved);
    expect(JSON.stringify(store.settings())).not.toContain(RERANK_KEY_SENTINEL);
    expect(store.rerankApiKey()).toBe(RERANK_KEY_SENTINEL);
    expect(store.embeddingApiKey()).toBeNull();
    expect(rerankColumns(db)).toEqual(["bge-reranker", "http://rerank/v1", RERANK_KEY_SENTINEL]);
  });

  it("同一身份重存：探活保留，updated_at 更新", () => {
    const { store } = rerankProbed();
    vi.setSystemTime(T0 + 5);
    expect(store.saveSettings({ rerank: RERANK })).toMatchObject({
      rerankProbe: probedOk,
      updatedAt: T0 + 5,
    });
  });

  it.each(RERANK_CHANGES)("%s变了：重排探活重置，within 里已是重置后的状态", (_field, change) => {
    const { db, store } = rerankProbed();
    const rerank = { ...RERANK, ...change };
    const seen: unknown[] = [];
    const saved = store.saveSettings({ rerank }, (view) => seen.push(view.rerankProbe));
    expect(saved.rerankProbe).toEqual(NEVER);
    expect(seen).toEqual([NEVER]);
    expect(saved.rerank).toEqual({ name: rerank.name, baseUrl: rerank.baseUrl });
    expect(store.rerankApiKey()).toBe(rerank.apiKey);
    expect(settingsRow(db)).toMatchObject({
      rerank_probe_status: "never",
      rerank_probe_at: null,
      rerank_probe_message: null,
    });
  });

  it("null 即清除：三列置 NULL，探活重置，updated_at 更新，rerankApiKey 为 null", () => {
    const { db, store } = rerankProbed();
    vi.setSystemTime(T0 + 5);
    const seen: unknown[] = [];
    const saved = store.saveSettings({ rerank: null }, (view) => seen.push(view));
    expect(saved).toMatchObject({ rerank: null, rerankProbe: NEVER, updatedAt: T0 + 5 });
    expect(seen).toEqual([saved]);
    expect(store.rerankApiKey()).toBeNull();
    expect(rerankColumns(db)).toEqual([null, null, null]);
  });

  it("store 不判 null→null 无操作：未配置时再清除照常写 updated_at、调 within", () => {
    const { store } = fresh();
    vi.setSystemTime(T0 + 5);
    const within = vi.fn();
    expect(store.saveSettings({ rerank: null }, within)).toMatchObject({
      rerank: null,
      rerankProbe: NEVER,
      updatedAt: T0 + 5,
    });
    expect(within).toHaveBeenCalledOnce();
  });

  it("保存重排不动嵌入的身份、探活与代数；保存嵌入不动重排的身份与探活", () => {
    const { store } = fresh();
    const embeddingProbe = { status: "failed", at: T0 + 2, message: "上游拒绝" } as const;
    store.saveSettings({ embedding: EMBEDDING, rebuildActorId: "u1" });
    store.recordEmbeddingProbe(EMBEDDING, embeddingProbe);
    store.saveSettings({ rerank: RERANK });
    store.recordRerankProbe(RERANK, probedOk);

    const rerankChanged = { ...RERANK, name: "bge-reranker-large" };
    expect(store.saveSettings({ rerank: rerankChanged })).toMatchObject({
      embedding: { name: "bge-m3", baseUrl: "http://embed/v1" },
      embeddingGeneration: 1,
      probe: embeddingProbe,
    });
    expect(store.embeddingApiKey()).toBe(KEY_SENTINEL);

    store.recordRerankProbe(rerankChanged, probedOk);
    expect(store.saveSettings({ embedding: { ...EMBEDDING, name: "bge-large" } })).toMatchObject({
      probe: NEVER,
      rerank: { name: "bge-reranker-large", baseUrl: "http://rerank/v1" },
      rerankProbe: probedOk,
    });
    expect(store.rerankApiKey()).toBe(RERANK_KEY_SENTINEL);
  });

  it("与嵌入、对话模型同一事务：对话模型被外键拒绝时，同一次保存的重排一起回滚", () => {
    const { store } = fresh();
    expect(() => store.saveSettings({ rerank: RERANK, chatModelId: "nope" })).toThrow(FOREIGN_KEY);
    expect(store.settings()).toMatchObject({ rerank: null, updatedAt: 0 });
    expect(store.rerankApiKey()).toBeNull();
  });

  it("重排三列整组写入：保存、更换、清除每一步之后三列同为 NULL 或同为非 NULL", () => {
    const { db, store } = fresh();
    expectWholeGroup(db);
    store.saveSettings({ rerank: RERANK });
    expectWholeGroup(db);
    expect(rerankColumns(db)).not.toContain(null);
    store.saveSettings({ rerank: { name: "n2", baseUrl: "http://r2/v1", apiKey: "k2" } });
    expectWholeGroup(db);
    expect(rerankColumns(db)).toEqual(["n2", "http://r2/v1", "k2"]);
    store.saveSettings({ rerank: null });
    expectWholeGroup(db);
    expect(rerankColumns(db)).toEqual([null, null, null]);
  });

  it.each([
    ["保存", null, RERANK],
    ["更换", RERANK, { ...RERANK, baseUrl: "http://rerank-other/v1" }],
    ["清除", RERANK, null],
  ] as const)("%s时 within 抛出：三列与探活一起回滚", (_step, before, after) => {
    const { db, store } = fresh();
    if (before !== null) {
      store.saveSettings({ rerank: before });
      store.recordRerankProbe(before, probedOk);
    }
    const snapshot = settingsRow(db);
    expect(() => store.saveSettings({ rerank: after }, boom)).toThrow(BOOM);
    expect(settingsRow(db)).toEqual(snapshot);
    expectWholeGroup(db);
  });

  describe("重排探活写回", () => {
    const failed = { status: "failed", at: T0 + 5, message: "上游拒绝" } as const;

    it("同一身份：写三列并调 within，不动 updated_at 与嵌入探活；读视图不带密钥", () => {
      const { store } = fresh();
      store.saveSettings({ embedding: EMBEDDING, rerank: RERANK });
      vi.setSystemTime(T0 + 5);
      const seen: unknown[] = [];
      const recorded = store.recordRerankProbe(RERANK, failed, (view) => seen.push(view));
      expect(recorded).toEqual({ view: store.settings(), recorded: true });
      expect(recorded.view).toMatchObject({
        rerank: { name: "bge-reranker", baseUrl: "http://rerank/v1" },
        rerankProbe: failed,
        probe: NEVER,
        updatedAt: T0,
      });
      expect(seen).toEqual([recorded.view]);
      expect(JSON.stringify(store.settings())).not.toContain(RERANK_KEY_SENTINEL);
      expect(store.rerankApiKey()).toBe(RERANK_KEY_SENTINEL);
    });

    it.each(RERANK_CHANGES)(
      "%s与当前不同：recorded 为 false，不调 within，探活不变",
      (_field, change) => {
        const { store } = rerankProbed();
        const within = vi.fn();
        expect(store.recordRerankProbe({ ...RERANK, ...change }, failed, within)).toEqual({
          view: store.settings(),
          recorded: false,
        });
        expect(within).not.toHaveBeenCalled();
        expect(store.settings().rerankProbe).toEqual(probedOk);
      },
    );

    it("已清空：旧身份的写回丢弃，不调 within，探活仍是 never", () => {
      const { store } = rerankProbed();
      store.saveSettings({ rerank: null });
      const within = vi.fn();
      expect(store.recordRerankProbe(RERANK, failed, within).recorded).toBe(false);
      expect(within).not.toHaveBeenCalled();
      expect(store.settings().rerankProbe).toEqual(NEVER);
    });

    it("within 抛出：探活回滚", () => {
      const { store } = rerankProbed();
      expect(() => store.recordRerankProbe(RERANK, failed, boom)).toThrow(BOOM);
      expect(store.settings().rerankProbe).toEqual(probedOk);
    });

    it("嵌入探活写回不动重排探活", () => {
      const { store } = rerankProbed();
      store.saveSettings({ embedding: EMBEDDING });
      const embeddingOk = { status: "ok", at: T0 + 7, message: null } as const;
      expect(store.recordEmbeddingProbe(EMBEDDING, embeddingOk).view).toMatchObject({
        probe: embeddingOk,
        rerankProbe: probedOk,
      });
    });
  });
});
