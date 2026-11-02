/**
 * Issue #1836（任务 7.2）：`kb/store.ts` 的 `kb_settings` 一行（design D7、D8）：设置读写、确认重建、重试与探活写回，
 * 经 `openDb(":memory:")` 的真实迁移与 `createKbStore` 这一个公开入口测。期望值是 spec 与 design 里的字面量；
 * 密钥取值是哨兵，证明读视图带不出来。
 */
import { describe, expect, it, vi } from "vitest";
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
      chatModelId: null,
      rebuildActorId: null,
      updatedAt: 0,
    });
    expect(store.embeddingApiKey()).toBeNull();
  });

  it("保存嵌入模型：读视图只有名称与地址，密钥只经 embeddingApiKey 读出", () => {
    const { db, store } = fresh();
    const seen: unknown[] = [];
    const saved = store.saveSettings({ embedding: EMBEDDING }, (view) => seen.push(view));
    expect(saved).toEqual({
      embedding: { name: "bge-m3", baseUrl: "http://embed/v1" },
      embeddingGeneration: 0,
      probe: { status: "never", at: null, message: null },
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
