/**
 * Issue #1836（任务 7.2）：knowledge-bases「迁移 050 知识库 schema」的「约束」场景与 `kb/store.ts`（design D6、D8、
 * D9 的落库部分）的知识库、文档与重建，经 `openDb(":memory:")` 的真实迁移与 `createKbStore` 这一个公开入口测。
 * 表形状的其余部分在 `kb-schema.test.ts`，设置在 `kb-store-settings.test.ts`。期望值是 spec 与 design 里的字面量。
 */
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  BASE_ROW,
  BOOM,
  boom,
  CHECK,
  COMPILE_ROW,
  createCompileBase,
  createPlainBase,
  EMBEDDING,
  hex,
  insertRow,
  MODEL_ROW,
  NEXT,
  NEXT_PLAIN,
  PLAIN_BASE,
  REBUILD_FAILED,
  type Row,
  rows,
  type Store,
  settingsRow,
  T0,
  UPLOAD_ROW,
  useKbDatabases,
} from "./kb-store-helpers.js";

const fresh = useKbDatabases();

const baseRow = (db: DatabaseSync, id: string) =>
  db.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(id);

function addUpload(store: Store, kbId: string, name = "a.txt") {
  return store.addDocument({
    kbId,
    ragflowDocumentId: `rf-${name}`,
    name,
    size: 3,
    source: "upload",
  });
}

function addWorkspaceFile(
  store: Store,
  kbId: string,
  sourcePath: string,
  workspaceId = "w1",
  sourceMtimeMs = T0,
) {
  return store.addDocument({
    kbId,
    ragflowDocumentId: `rf-${sourcePath}`,
    name: sourcePath,
    size: 7,
    source: "workspace",
    workspaceId,
    sourcePath,
    sourceMtimeMs,
  });
}

/** 确认重建：代数加一，全部知识库置 `rebuilding`。 */
function startRebuild(store: Store) {
  return store.saveSettings({ embedding: EMBEDDING, rebuildActorId: "u3" });
}

describe("约束", () => {
  it("前八次插入都被约束拒绝；删除被引用的模型成功，chat_model_id 变为 NULL", () => {
    const { db } = fresh();
    insertRow(db, "models", MODEL_ROW);
    db.exec("UPDATE kb_settings SET chat_model_id = 'm1'");
    insertRow(db, "knowledge_bases", BASE_ROW);
    const other = { id: hex(2), name: "另一个库" };
    const CANVAS = { canvas_id: "c", template_group_id: "g" };
    const REBUILD_CANVAS = { rebuild_canvas_id: "c", rebuild_template_group_id: "g" };
    const refused: Array<[string, Row, RegExp]> = [
      ["kb_settings", { id: "kb", updated_at: 0 }, /UNIQUE constraint failed: kb_settings\.id/],
      ["knowledge_bases", { ...BASE_ROW, ...other, template: "audio" }, /failed: template IN/],
      ["knowledge_bases", { ...BASE_ROW, ...other, template: "tag" }, /failed: template IN/],
      ["knowledge_bases", { ...BASE_ROW, ...other, raptor: 1 }, /failed: \(canvas_id/],
      ["knowledge_bases", { ...BASE_ROW, ...other, ...CANVAS }, /failed: \(canvas_id/],
      [
        "knowledge_bases",
        { ...COMPILE_ROW, ...other, ...REBUILD_CANVAS },
        /failed: \(rebuild_canvas/,
      ],
      ["kb_documents", { ...UPLOAD_ROW, source_path: "docs/a.txt" }, /failed: .*source_path/s],
      [
        "knowledge_bases",
        { ...BASE_ROW, id: hex(2) },
        /UNIQUE constraint failed: knowledge_bases\.owner_id, knowledge_bases\.name/,
      ],
    ];
    for (const [table, row, reason] of refused) {
      expect(() => insertRow(db, table, row), JSON.stringify(row)).toThrow(reason);
    }
    expect(rows(db, "kb_settings")).toHaveLength(1);
    expect(rows(db, "knowledge_bases")).toHaveLength(1);
    expect(rows(db, "kb_documents")).toEqual([]);

    db.prepare("DELETE FROM models WHERE id = 'm1'").run();
    expect(settingsRow(db)).toMatchObject({ chat_model_id: null });
  });

  it("kb_settings 只有 id = 'kb' 这一行：别的 id 被 CHECK 拒绝", () => {
    const { db } = fresh();
    expect(() => insertRow(db, "kb_settings", { id: "other", updated_at: 0 })).toThrow(CHECK);
    expect(rows(db, "kb_settings")).toHaveLength(1);
  });
});

describe("kb store: 知识库", () => {
  it("newId 是 32 位小写十六进制，且每次不同", () => {
    const { store } = fresh();
    const first = store.newId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(store.newId()).not.toBe(first);
  });

  it("建库按当前代数写行，状态 ready，读回 getBase", () => {
    const { store } = fresh();
    startRebuild(store);
    const seen: unknown[] = [];
    const created = store.createBase(
      {
        id: hex(1),
        ownerId: "u1",
        name: "论文",
        template: "paper",
        raptor: true,
        graph: true,
        datasetId: "ds-1",
        canvasId: "canvas-1",
        templateGroupId: "group-1",
      },
      (record) => seen.push(record),
    );
    expect(created).toEqual({
      id: hex(1),
      ownerId: "u1",
      name: "论文",
      template: "paper",
      raptor: true,
      graph: true,
      datasetId: "ds-1",
      canvasId: "canvas-1",
      templateGroupId: "group-1",
      rebuildDatasetId: null,
      rebuildCanvasId: null,
      rebuildTemplateGroupId: null,
      embeddingGeneration: 1,
      state: "ready",
      stateMessage: null,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(seen).toEqual([created]);
    expect(store.getBase(hex(1))).toEqual(created);
    expect(store.getBase(hex(2))).toBeUndefined();
  });

  it("建库的 within 抛出即不留行", () => {
    const { db, store } = fresh();
    expect(() => store.createBase(PLAIN_BASE, boom)).toThrow(BOOM);
    expect(rows(db, "knowledge_bases")).toEqual([]);
  });

  it("同一账号重名：isBaseNameTaken 为真，再插被唯一约束拒绝；别的账号可以同名", () => {
    const { store } = fresh();
    const name = `库 ${hex(1)}`;
    createPlainBase(store, hex(1));
    expect(store.isBaseNameTaken("u1", name)).toBe(true);
    expect(store.isBaseNameTaken("u2", name)).toBe(false);
    expect(store.isBaseNameTaken("u1", "别的名字")).toBe(false);
    const again = { ...PLAIN_BASE, id: hex(2), name };
    expect(() => store.createBase(again)).toThrow(/UNIQUE constraint failed/);
    expect(store.createBase({ ...again, ownerId: "u2" }).ownerId).toBe("u2");
  });

  it("按 owner 列出：created_at 升序，同刻按 id；不含别人的库", () => {
    const { store } = fresh();
    vi.setSystemTime(T0 + 10);
    createPlainBase(store, hex(3));
    createPlainBase(store, hex(2));
    vi.setSystemTime(T0);
    createPlainBase(store, hex(4));
    createPlainBase(store, hex(1), "u2");
    expect(store.listBases("u1").map((base) => base.id)).toEqual([hex(4), hex(2), hex(3)]);
    expect(store.listBases("u2").map((base) => base.id)).toEqual([hex(1)]);
    expect(store.listBases("u3")).toEqual([]);
  });

  it("按 owner 计数供 50 上限用：第 50 个之后计数恰为 50，别的账号不计入", () => {
    const { store } = fresh();
    for (let n = 1; n <= 50; n += 1) createPlainBase(store, hex(n));
    createPlainBase(store, hex(51), "u2");
    expect(store.countBasesByOwner("u1")).toBe(50);
    expect(store.countBasesByOwner("u2")).toBe(1);
    expect(store.countBasesByOwner("u3")).toBe(0);
    expect(store.countBases()).toBe(51);
  });

  it("compileBases 的口径：开编译的库含重建中与重建失败，四个库里计 3", () => {
    const { db, store } = fresh();
    insertRow(db, "knowledge_bases", COMPILE_ROW);
    const graph = { id: hex(2), name: "图谱", raptor: 0, graph: 1, state: "rebuilding" };
    insertRow(db, "knowledge_bases", { ...COMPILE_ROW, ...graph });
    const both = { id: hex(3), name: "都开", graph: 1, state: "rebuild_failed" };
    insertRow(db, "knowledge_bases", { ...COMPILE_ROW, ...both });
    insertRow(db, "knowledge_bases", { ...BASE_ROW, id: hex(4), name: "都关" });
    expect(store.countBases()).toBe(4);
    expect(store.countCompileBases()).toBe(3);
    expect(store.countBasesInState("rebuilding")).toBe(1);
    expect(store.countBasesInState("rebuild_failed")).toBe(1);
    expect(store.countBasesInState("ready")).toBe(2);
  });

  it("删库返回被删的行，文档级联删除，别的库的文档不动；未知 id 为 undefined", () => {
    const { db, store } = fresh();
    const doomed = createPlainBase(store, hex(1));
    createPlainBase(store, hex(2));
    addUpload(store, hex(1));
    addUpload(store, hex(1), "b.txt");
    const kept = addUpload(store, hex(2));
    const seen: unknown[] = [];
    expect(store.removeBase(hex(1), (record) => seen.push(record))).toEqual(doomed);
    expect(seen).toEqual([doomed]);
    expect(store.getBase(hex(1))).toBeUndefined();
    expect(rows(db, "kb_documents").map((row) => row.id)).toEqual([kept.id]);
    expect(store.removeBase(hex(1))).toBeUndefined();
  });

  it("删库的 within 抛出：库与文档都还在", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    addUpload(store, hex(1));
    expect(() => store.removeBase(hex(1), boom)).toThrow(BOOM);
    expect(store.getBase(hex(1))).toBeDefined();
    expect(store.countDocuments(hex(1))).toBe(1);
  });
});

describe("kb store: 文档", () => {
  it("两种来源的文档读回各自的形状，id 由 store 生成", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    const upload = addUpload(store, hex(1));
    expect(upload).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      kbId: hex(1),
      ragflowDocumentId: "rf-a.txt",
      name: "a.txt",
      size: 3,
      source: "upload",
      workspaceId: null,
      sourcePath: null,
      sourceMtimeMs: null,
      createdAt: T0,
    });
    const file = addWorkspaceFile(store, hex(1), "docs/b.txt");
    expect(file).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      kbId: hex(1),
      ragflowDocumentId: "rf-docs/b.txt",
      name: "docs/b.txt",
      size: 7,
      source: "workspace",
      workspaceId: "w1",
      sourcePath: "docs/b.txt",
      sourceMtimeMs: T0,
      createdAt: T0,
    });
    expect(store.getDocument(hex(1), upload.id)).toEqual(upload);
    expect(store.getDocument(hex(1), file.id)).toEqual(file);
  });

  it("source_mtime_ms 原样保存 fstat 的小数毫秒：入库记录与 mtimeMs 比较才不会误判变更", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    const mtimeMs = 1793543912137.8687;
    const { id } = addWorkspaceFile(store, hex(1), "a.txt", "w1", mtimeMs);
    expect(store.getDocument(hex(1), id)?.sourceMtimeMs).toBe(mtimeMs);
  });

  it("getDocument 与 removeDocument 限在所属的知识库内", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    createPlainBase(store, hex(2));
    const doc = addUpload(store, hex(1));
    expect(store.getDocument(hex(2), doc.id)).toBeUndefined();
    expect(store.removeDocument(hex(2), doc.id)).toBeUndefined();
    expect(store.getDocument(hex(1), doc.id)).toEqual(doc);
    expect(store.getDocument(hex(1), "nope")).toBeUndefined();
  });

  it("按 created_at 升序列出一个库的文档，不含别的库", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    createPlainBase(store, hex(2));
    vi.setSystemTime(T0 + 10);
    const later = addUpload(store, hex(1), "later.txt");
    vi.setSystemTime(T0);
    const earlier = addUpload(store, hex(1), "earlier.txt");
    addUpload(store, hex(2), "other.txt");
    expect(store.listDocuments(hex(1)).map((doc) => doc.id)).toEqual([earlier.id, later.id]);
    expect(store.listDocuments(hex(3))).toEqual([]);
  });

  it("计数供 500 上限用：一个库 500 份恰为 500，总数含别的库", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    createPlainBase(store, hex(2));
    for (let n = 0; n < 500; n += 1) addUpload(store, hex(1), `${n}.txt`);
    addUpload(store, hex(2));
    expect(store.countDocuments(hex(1))).toBe(500);
    expect(store.countDocuments(hex(2))).toBe(1);
    expect(store.countDocuments(hex(3))).toBe(0);
    expect(store.countAllDocuments()).toBe(501);
  });

  it("(kb_id, workspace_id, source_path) 唯一；换库、换空间、换路径都可以再入库，上传不受它限制", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    createPlainBase(store, hex(2));
    const doc = addWorkspaceFile(store, hex(1), "a.txt");
    expect(store.findDocumentBySource(hex(1), "w1", "a.txt")).toEqual(doc);
    expect(store.findDocumentBySource(hex(2), "w1", "a.txt")).toBeUndefined();
    expect(store.findDocumentBySource(hex(1), "w2", "a.txt")).toBeUndefined();
    expect(() => addWorkspaceFile(store, hex(1), "a.txt")).toThrow(/UNIQUE constraint failed/);

    addWorkspaceFile(store, hex(2), "a.txt");
    addWorkspaceFile(store, hex(1), "a.txt", "w2");
    addWorkspaceFile(store, hex(1), "b.txt");
    addUpload(store, hex(1), "same.txt");
    addUpload(store, hex(1), "same.txt");
    expect(store.countDocuments(hex(1))).toBe(5);
  });

  it("工作空间删除后，文档作为入库快照照常保留", () => {
    const { db, store } = fresh();
    insertRow(db, "workspaces", { id: hex(9), owner_id: "u1", name: "w", dir: "w", created_at: 1 });
    createPlainBase(store, hex(1));
    const doc = addWorkspaceFile(store, hex(1), "a.txt", hex(9));
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(hex(9));
    expect(store.getDocument(hex(1), doc.id)).toEqual(doc);
  });

  it("写文档时 within 在 COMMIT 之前运行：抛出即回滚", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    const doc = addUpload(store, hex(1));
    const seen: unknown[] = [];
    expect(() =>
      store.addDocument(
        { kbId: hex(1), ragflowDocumentId: "r", name: "b", size: 1, source: "upload" },
        (record) => {
          seen.push(record);
          throw BOOM;
        },
      ),
    ).toThrow(BOOM);
    expect(seen).toHaveLength(1);
    expect(() => store.removeDocument(hex(1), doc.id, boom)).toThrow(BOOM);
    expect(store.listDocuments(hex(1))).toEqual([doc]);

    expect(store.removeDocument(hex(1), doc.id)).toEqual(doc);
    expect(store.listDocuments(hex(1))).toEqual([]);
  });
});

describe("kb store: 重建", () => {
  /** 一个开编译的库，代数已加一，处于 rebuilding，文档两份。 */
  function rebuilding() {
    const { db, store } = fresh();
    const base = createCompileBase(store, hex(1));
    const kept = addUpload(store, hex(1), "kept.txt");
    const gone = addUpload(store, hex(1), "gone.txt");
    startRebuild(store);
    return { db, store, base, kept, gone };
  }

  it("listBasesInState 列出处于该状态的库，供重建器续做", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    createPlainBase(store, hex(2), "u2");
    expect(store.listBasesInState("rebuilding")).toEqual([]);
    startRebuild(store);
    expect(store.listBasesInState("rebuilding").map((base) => base.id)).toEqual([hex(1), hex(2)]);
  });

  it("新一代的三列一起写入、一起置空；当前一代不动", () => {
    const { store, base } = rebuilding();
    vi.setSystemTime(T0 + 5);
    expect(store.setRebuildGeneration(hex(1), NEXT)).toMatchObject({
      datasetId: "ds-old",
      canvasId: "canvas-old",
      templateGroupId: "group-old",
      rebuildDatasetId: "ds-new",
      rebuildCanvasId: "canvas-new",
      rebuildTemplateGroupId: "group-new",
      updatedAt: T0 + 5,
    });
    expect(store.setRebuildGeneration(hex(1), null)).toMatchObject({
      datasetId: base.datasetId,
      rebuildDatasetId: null,
      rebuildCanvasId: null,
      rebuildTemplateGroupId: null,
    });
    expect(store.setRebuildGeneration(hex(2), NEXT)).toBeUndefined();
  });

  it("普通库的新一代只有数据集；开编译的库缺画布被 CHECK 拒绝，行不变", () => {
    const { store } = rebuilding();
    createPlainBase(store, hex(2));
    expect(store.setRebuildGeneration(hex(2), NEXT_PLAIN)).toMatchObject({
      rebuildDatasetId: "ds-new",
      rebuildCanvasId: null,
    });
    expect(() => store.setRebuildGeneration(hex(1), NEXT_PLAIN)).toThrow(CHECK);
    expect(store.getBase(hex(1))?.rebuildDatasetId).toBeNull();
  });

  it("重建失败写状态与固定文案，留着新一代的 id 供重试删除；within 抛出即回滚", () => {
    const { store } = rebuilding();
    store.setRebuildGeneration(hex(1), NEXT);
    expect(() => store.failRebuild(hex(1), REBUILD_FAILED, boom)).toThrow(BOOM);
    expect(store.getBase(hex(1))).toMatchObject({ state: "rebuilding", stateMessage: null });

    expect(store.failRebuild(hex(1), REBUILD_FAILED)).toMatchObject({
      state: "rebuild_failed",
      stateMessage: REBUILD_FAILED,
      rebuildDatasetId: "ds-new",
      rebuildCanvasId: "canvas-new",
      rebuildTemplateGroupId: "group-new",
    });
    expect(store.failRebuild(hex(2), REBUILD_FAILED)).toBeUndefined();
  });

  it("切换：三列整体换入并置空，代数取当前，状态 ready，被跳过的文档删除，其余换新 id", () => {
    const { store, kept, gone } = rebuilding();
    createPlainBase(store, hex(2));
    const bystander = addUpload(store, hex(2));
    store.setRebuildGeneration(hex(1), NEXT);
    vi.setSystemTime(T0 + 5);

    const seen: unknown[] = [];
    const switched = store.switchGeneration(
      hex(1),
      { replaced: [{ id: kept.id, ragflowDocumentId: "rf-new" }], skipped: [gone.id] },
      (record) => seen.push(record),
    );

    expect(switched).toMatchObject({
      datasetId: "ds-new",
      canvasId: "canvas-new",
      templateGroupId: "group-new",
      rebuildDatasetId: null,
      rebuildCanvasId: null,
      rebuildTemplateGroupId: null,
      embeddingGeneration: 1,
      state: "ready",
      stateMessage: null,
      updatedAt: T0 + 5,
    });
    expect(seen).toEqual([switched]);
    expect(store.listDocuments(hex(1))).toEqual([{ ...kept, ragflowDocumentId: "rf-new" }]);
    expect(store.listDocuments(hex(2))).toEqual([bystander]);
  });

  it("普通库切换后画布与模板组仍是 NULL", () => {
    const { store } = fresh();
    createPlainBase(store, hex(1));
    startRebuild(store);
    store.setRebuildGeneration(hex(1), NEXT_PLAIN);
    expect(store.switchGeneration(hex(1), { replaced: [], skipped: [] })).toMatchObject({
      datasetId: "ds-new",
      canvasId: null,
      templateGroupId: null,
      rebuildDatasetId: null,
      embeddingGeneration: 1,
      state: "ready",
    });
  });

  it("切换的 within 抛出：库行与文档都回到切换之前", () => {
    const { db, store, kept, gone } = rebuilding();
    store.setRebuildGeneration(hex(1), NEXT);
    const before = baseRow(db, hex(1));
    expect(() =>
      store.switchGeneration(
        hex(1),
        { replaced: [{ id: kept.id, ragflowDocumentId: "rf-new" }], skipped: [gone.id] },
        boom,
      ),
    ).toThrow(BOOM);
    expect(baseRow(db, hex(1))).toEqual(before);
    expect(store.listDocuments(hex(1))).toEqual(
      [gone, kept].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  it("没有新一代时不能切换：库行不变", () => {
    const { db, store, kept, gone } = rebuilding();
    const before = baseRow(db, hex(1));
    expect(() =>
      store.switchGeneration(hex(1), {
        replaced: [{ id: kept.id, ragflowDocumentId: "rf-new" }],
        skipped: [gone.id],
      }),
    ).toThrow(/no rebuild generation/);
    expect(baseRow(db, hex(1))).toEqual(before);
    expect(() => store.switchGeneration(hex(2), { replaced: [], skipped: [] })).toThrow(
      /no rebuild generation/,
    );
  });

  it("文档清单与该库的行对不上时不切换：漏掉一份、混入别的库的文档、重复列出或两单交叠都整体回滚", () => {
    const { db, store, kept, gone } = rebuilding();
    createPlainBase(store, hex(2));
    const foreign = addUpload(store, hex(2));
    store.setRebuildGeneration(hex(1), NEXT);
    const before = baseRow(db, hex(1));
    const documents = store.listDocuments(hex(1));
    const replaced = [{ id: kept.id, ragflowDocumentId: "rf-new" }];
    expect(() => store.switchGeneration(hex(1), { replaced, skipped: [] })).toThrow(
      /document set mismatch/,
    );
    expect(() =>
      store.switchGeneration(hex(1), {
        replaced: [...replaced, { id: foreign.id, ragflowDocumentId: "rf-x" }],
        skipped: [gone.id],
      }),
    ).toThrow(/document set mismatch/);
    expect(() =>
      store.switchGeneration(hex(1), { replaced, skipped: [gone.id, foreign.id] }),
    ).toThrow(/document set mismatch/);
    expect(() => store.switchGeneration(hex(1), { replaced, skipped: [gone.id, gone.id] })).toThrow(
      /document set mismatch/,
    );
    expect(() => store.switchGeneration(hex(1), { replaced, skipped: [kept.id, gone.id] })).toThrow(
      /document set mismatch/,
    );
    expect(() =>
      store.switchGeneration(hex(1), {
        replaced: [...replaced, { id: gone.id, ragflowDocumentId: "rf-gone" }],
        skipped: [gone.id],
      }),
    ).toThrow(/document set mismatch/);
    expect(() =>
      store.switchGeneration(hex(1), {
        replaced: [...replaced, { id: kept.id, ragflowDocumentId: "rf-again" }],
        skipped: [],
      }),
    ).toThrow(/document set mismatch/);
    expect(baseRow(db, hex(1))).toEqual(before);
    expect(store.listDocuments(hex(1))).toEqual(documents);
    expect(store.listDocuments(hex(2))).toEqual([foreign]);
  });
});

describe("kb store: 边界", () => {
  it("只依赖 node:crypto 与 node:sqlite：不 import 任何出站模块", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/kb/store.ts", import.meta.url)),
      "utf8",
    );
    expect([...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort()).toEqual([
      "node:crypto",
      "node:sqlite",
    ]);
  });
});
