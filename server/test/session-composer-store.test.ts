/**
 * Issue #1004 (s1g-composer-capabilities tasks 8.1 + 8.6): the read half of the three composer
 * settings — every session view carries `approvalMode` / `modelId` / `reasoningEffort` as the
 * effective values of the three raw columns, and `runtimeState` reports the raw columns.
 * No writer exists yet, so non-NULL columns are planted by SQL. Real SQLite, real stores; the
 * configuration is passed in, never read from the environment. Oracles: the spec's key order and
 * session-composer-settings「有效值解析」(夹取与回落), written here as literals.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { emit } from "../src/core/audit/index.js";
import { openDb } from "../src/core/db/index.js";
import { createSessionStore, type SessionStore } from "../src/sessions/store.js";
import type { ComposerConfig } from "../src/sessions/store-composer.js";
import {
  createSessionMetadataStore,
  type SessionMetadataStore,
} from "../src/sessions/store-metadata.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { TEST_COMPOSER } from "./session-meta-fixtures.js";
import { cookieFor, SESSION_NOW, withSessionRest } from "./session-rest-helpers.js";
import { createControlledRuntime } from "./session-supervisor-helpers.js";
import { temporaryWorkspacePort } from "./support/temporary-workspace.js";
import { insertWorkspace } from "./workspaces-http-helpers.js";

const FOURTEEN_KEYS = [
  "id",
  "title",
  "status",
  "createdAt",
  "updatedAt",
  "scene",
  "workspaceId",
  "pinnedAt",
  "archivedAt",
  "pendingApproval",
  "temporaryWorkspace",
  "approvalMode",
  "modelId",
  "reasoningEffort",
];
const NOW = 1_740_000_000_000;
const HEX32 = /^[0-9a-f]{32}$/u;
const WORKSPACE = "a".repeat(32);
/** session-composer-settings「有效值解析」的白名单：缺省模型 `m1`，`m2` 不支持推理。 */
const CATALOG: ComposerConfig["modelCatalog"] = {
  models: [
    {
      id: "m1",
      name: "M One",
      reasoning: true,
      vision: false,
      efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    },
    { id: "m2", name: "M Two", reasoning: false, vision: false },
    { id: "m3", name: "M Three", reasoning: true, vision: true, efforts: ["low", "high"] },
  ],
  defaultModelId: "m1",
};

type Composer = { approvalMode: string; modelId: string; reasoningEffort: string | null };

interface Stores {
  store: SessionStore;
  metadata: SessionMetadataStore;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function openDatabase(): DatabaseSync {
  const db = openDb(":memory:");
  cleanups.push(() => {
    db.close();
  });
  return db;
}

/** Both stores over `db`, each handed `composer` directly; closed (store) after the test. */
function openStores(db: DatabaseSync, composer: ComposerConfig): Stores {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "workbuddy-composer-store-"));
  const store = createSessionStore(db, { onFlushError() {}, emit, composer });
  const metadata = createSessionMetadataStore(db, {
    emit,
    sandboxRoot,
    createTemporaryWorkspace: temporaryWorkspacePort(db, sandboxRoot),
    composer,
  });
  cleanups.push(() => {
    store.close();
    rmSync(sandboxRoot, { recursive: true, force: true });
  });
  return { store, metadata };
}

function plant(
  db: DatabaseSync,
  sessionId: string,
  approvalMode: string | null,
  modelId: string | null,
  reasoningEffort: string | null,
): void {
  const receipt = db
    .prepare(
      "UPDATE chat_sessions SET approval_mode = ?, model_id = ?, reasoning_effort = ? WHERE id = ?",
    )
    .run(approvalMode, modelId, reasoningEffort, sessionId);
  expect(receipt.changes).toBe(1);
}

function rawColumns(db: DatabaseSync, sessionId: string): unknown {
  return db
    .prepare("SELECT approval_mode, model_id, reasoning_effort FROM chat_sessions WHERE id = ?")
    .get(sessionId);
}

function composerOf(view: unknown): unknown {
  const { approvalMode, modelId, reasoningEffort } = view as Record<string, unknown>;
  return { approvalMode, modelId, reasoningEffort };
}

/** The three exits of the session store read the same view of `sessionId`. */
function readEverywhere(store: SessionStore, sessionId: string): unknown[] {
  return [
    store.list("u1").find((view) => view.id === sessionId),
    store.getMessages(sessionId, "u1")?.session,
  ];
}

describe("会话视图发出三键：三列为 NULL 的行读成缺省有效值", () => {
  const offCatalog: ComposerConfig["modelCatalog"] = {
    models: [{ id: "solo", name: "solo", reasoning: false, vision: false }],
    defaultModelId: "solo",
  };
  const cases: Array<[string, ComposerConfig, Composer]> = [
    [
      "缺省配置",
      TEST_COMPOSER,
      { approvalMode: "write", modelId: "deepseek-v4.1-flash", reasoningEffort: "high" },
    ],
    [
      "上界 always-ask",
      { ...TEST_COMPOSER, approvalMaxMode: "always-ask" },
      { approvalMode: "always-ask", modelId: "deepseek-v4.1-flash", reasoningEffort: "high" },
    ],
    [
      "上界 write、三模型白名单",
      { approvalMaxMode: "write", modelCatalog: CATALOG },
      { approvalMode: "write", modelId: "m1", reasoningEffort: "high" },
    ],
    [
      "缺省模型不支持推理",
      { approvalMaxMode: "yolo", modelCatalog: offCatalog },
      { approvalMode: "write", modelId: "solo", reasoningEffort: null },
    ],
  ];

  it.each(cases)(
    "(a) %s：store.create 的返回值、list 项与 getMessages().session 逐键相等",
    (_name, composer, expected) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const db = openDatabase();
      const { store } = openStores(db, composer);

      const created = store.create("u1");

      expect(HEX32.test(created.id)).toBe(true);
      const view = {
        id: created.id,
        title: null,
        status: "idle",
        createdAt: NOW,
        updatedAt: NOW,
        scene: null,
        workspaceId: null,
        pinnedAt: null,
        archivedAt: null,
        pendingApproval: false,
        temporaryWorkspace: false,
        ...expected,
      };
      for (const read of [created, ...readEverywhere(store, created.id)]) {
        expect(read).toEqual(view);
        expect(Object.keys(read ?? {})).toEqual(FOURTEEN_KEYS);
      }
      expect(rawColumns(db, created.id)).toEqual({
        approval_mode: null,
        model_id: null,
        reasoning_effort: null,
      });
    },
  );

  it.each(cases)(
    "(a) %s：metadata 的两种创建与 PATCH 返回同一个十四键视图",
    (_name, composer, expected) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const db = openDatabase();
      insertWorkspace(db, WORKSPACE, "u1", "周报空间", "weekly", NOW);
      const { store, metadata } = openStores(db, composer);

      const temporary = metadata.createSession("u1", {});
      const bound = metadata.createSession("u1", { workspaceId: WORKSPACE, scene: "code" });
      vi.setSystemTime(NOW + 5);
      const patched = metadata.patchSession("u1", bound.id, { pinned: true });

      const base = {
        title: null,
        status: "idle",
        createdAt: NOW,
        updatedAt: NOW,
        pinnedAt: null,
        archivedAt: null,
        pendingApproval: false,
      };
      const temporaryView = {
        id: temporary.id,
        ...base,
        scene: null,
        workspaceId: expect.stringMatching(HEX32),
        temporaryWorkspace: true,
        ...expected,
      };
      const boundView = {
        id: bound.id,
        ...base,
        scene: "code",
        workspaceId: WORKSPACE,
        temporaryWorkspace: false,
        ...expected,
      };
      expect(temporary).toEqual(temporaryView);
      expect(bound).toEqual(boundView);
      expect(patched).toEqual({ ...boundView, pinnedAt: NOW + 5 });
      for (const view of [temporary, bound, patched]) {
        expect(Object.keys(view ?? {})).toEqual(FOURTEEN_KEYS);
      }
      expect(readEverywhere(store, temporary.id)).toEqual([temporary, temporary]);
      expect(readEverywhere(store, bound.id)).toEqual([patched, patched]);
    },
  );
});

describe("会话视图发出三键：原始列经夹取与回落后进入视图", () => {
  it.each<[string, [string, string, string], ComposerConfig["approvalMaxMode"], Composer]>([
    [
      "档位被上界夹取，集合外的强度原样保留",
      ["yolo", "m3", "xhigh"],
      "write",
      { approvalMode: "write", modelId: "m3", reasoningEffort: "xhigh" },
    ],
    [
      "不在白名单的模型回落到缺省模型",
      ["write", "gone", "medium"],
      "yolo",
      { approvalMode: "write", modelId: "m1", reasoningEffort: "medium" },
    ],
    [
      "不支持推理的模型强度为 null",
      ["always-ask", "m2", "high"],
      "yolo",
      { approvalMode: "always-ask", modelId: "m2", reasoningEffort: null },
    ],
  ])("(b) %s", (_name, raw, approvalMaxMode, expected) => {
    const db = openDatabase();
    const { store, metadata } = openStores(db, { approvalMaxMode, modelCatalog: CATALOG });
    const session = store.create("u1").id;
    plant(db, session, ...raw);

    const [listed, snapshot] = readEverywhere(store, session);
    const patched = metadata.patchSession("u1", session, { pinned: true });

    expect(composerOf(listed)).toEqual(expected);
    expect(composerOf(snapshot)).toEqual(expected);
    expect(composerOf(patched)).toEqual(expected);
    expect(Object.keys(listed ?? {})).toEqual(FOURTEEN_KEYS);
    // 只读：视图层不回写原始列。
    expect(rawColumns(db, session)).toEqual({
      approval_mode: raw[0],
      model_id: raw[1],
      reasoning_effort: raw[2],
    });
  });

  it("(c) 调低上界：同一库先后以 yolo、write、yolo 开 store，视图读 yolo / write / yolo，列值不变", () => {
    const db = openDatabase();
    const session = openStores(db, TEST_COMPOSER).store.create("u1").id;
    plant(db, session, "yolo", null, null);
    const read: unknown[] = [];

    for (const approvalMaxMode of ["yolo", "write", "yolo"] as const) {
      const { store } = openStores(db, { ...TEST_COMPOSER, approvalMaxMode });
      const [listed, snapshot] = readEverywhere(store, session);
      expect(snapshot).toEqual(listed);
      read.push((listed as { approvalMode: string }).approvalMode);
      read.push((rawColumns(db, session) as { approval_mode: string }).approval_mode);
    }

    expect(read).toEqual(["yolo", "yolo", "write", "yolo", "yolo", "yolo"]);
  });
});

describe("runtimeState 报出三个原始列", () => {
  it("(d) NULL 行报三个 null；写库后原样报出，不夹取、不回落", () => {
    const db = openDatabase();
    const { store } = openStores(db, { approvalMaxMode: "always-ask", modelCatalog: CATALOG });
    const session = store.create("u1").id;

    expect(store.runtimeState(session)).toEqual({
      ownerId: "u1",
      ompSessionFile: null,
      streamEpoch: 0,
      activeTurn: null,
      workspaceId: null,
      composer: { approvalMode: null, modelId: null, reasoningEffort: null },
    });

    plant(db, session, "yolo", "gone", "xhigh");

    expect(store.runtimeState(session)?.composer).toEqual({
      approvalMode: "yolo",
      modelId: "gone",
      reasoningEffort: "xhigh",
    });
    expect(store.runtimeState("f".repeat(32))).toBeNull();
  });
});

describe("REST 出口的十四键 (chat-sessions「Session views carry the three composer settings」)", () => {
  it("(e) 缺省单模型配置：创建 201 与列表项恰十四键，三键为 write / deepseek-v4.1-flash / high", async () => {
    await withSessionRest(async ({ app, db }) => {
      const cookie = await cookieFor(app, "zhangsan");

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
      });
      const list = await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie } });

      expect(created.statusCode).toBe(201);
      const body = created.json() as Record<string, unknown>;
      const view = {
        id: expect.stringMatching(HEX32),
        title: null,
        status: "idle",
        createdAt: SESSION_NOW,
        updatedAt: SESSION_NOW,
        scene: null,
        workspaceId: expect.stringMatching(HEX32),
        pinnedAt: null,
        archivedAt: null,
        pendingApproval: false,
        temporaryWorkspace: true,
        approvalMode: "write",
        modelId: "deepseek-v4.1-flash",
        reasoningEffort: "high",
      };
      expect(body).toEqual(view);
      expect(Object.keys(body)).toEqual(FOURTEEN_KEYS);
      expect(list.statusCode).toBe(200);
      const { sessions } = list.json() as { sessions: Array<Record<string, unknown>> };
      expect(sessions).toEqual([{ ...view, id: body.id, workspaceId: body.workspaceId }]);
      expect(Object.keys(sessions[0] ?? {})).toEqual(FOURTEEN_KEYS);
      expect(rawColumns(db, String(body.id))).toEqual({
        approval_mode: null,
        model_id: null,
        reasoning_effort: null,
      });
    });
  });

  it("(f) createApp 带三模型白名单与 approvalMaxMode always-ask：创建、列表与快照读出目录缺省与 always-ask", async () => {
    const db = openDatabase();
    const defaultM3 = { ...CATALOG, defaultModelId: "m3" };
    const app = createApp({
      db,
      authRuntime: fixedRuntime(() => FIXED_NOW),
      assembly: {
        runtime: createControlledRuntime(() => {}).runtime,
        modelCatalog: defaultM3,
        approvalMaxMode: "always-ask",
      },
    });
    cleanups.push(() => app.close());
    const cookie = await cookieFor(app, "zhangsan");
    const expected = { approvalMode: "always-ask", modelId: "m3", reasoningEffort: "high" };

    const created = await app.inject({ method: "POST", url: "/api/sessions", headers: { cookie } });

    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string };
    expect(Object.keys(body)).toEqual(FOURTEEN_KEYS);
    expect(composerOf(body)).toEqual(expected);
    const list = await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie } });
    expect((list.json() as { sessions: unknown[] }).sessions).toEqual([body]);
    const snapshot = await app.inject({
      method: "GET",
      url: `/api/sessions/${body.id}/messages`,
      headers: { cookie },
    });
    expect((snapshot.json() as { session: unknown }).session).toEqual(body);
  });

  it("(f) createApp 不带白名单与上界：只有 runtime.modelId 一个模型，档位不封顶", async () => {
    const db = openDatabase();
    const controlled = createControlledRuntime(() => {});
    const app = createApp({
      db,
      authRuntime: fixedRuntime(() => FIXED_NOW),
      assembly: { runtime: controlled.runtime },
    });
    cleanups.push(() => app.close());
    const cookie = await cookieFor(app, "zhangsan");

    const created = await app.inject({ method: "POST", url: "/api/sessions", headers: { cookie } });

    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string };
    expect(composerOf(body)).toEqual({
      approvalMode: "write",
      modelId: controlled.runtime.modelId,
      reasoningEffort: "high",
    });
    plant(db, body.id, "yolo", null, null);
    const list = await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie } });
    const { sessions } = list.json() as { sessions: object[] };
    expect(composerOf(sessions[0])).toEqual({
      approvalMode: "yolo",
      modelId: controlled.runtime.modelId,
      reasoningEffort: "high",
    });
  });
});
