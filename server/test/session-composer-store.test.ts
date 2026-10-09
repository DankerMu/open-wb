/**
 * Issue #1004 (s1g-composer-capabilities tasks 8.1 + 8.6): the read half of the three composer
 * settings — every session view carries `approvalMode` / `modelId` / `reasoningEffort` as the
 * effective values of the three raw columns, and `runtimeState` reports the raw columns.
 * No writer exists yet, so non-NULL columns are planted by SQL. Real SQLite, real stores; the
 * configuration is passed in, never read from the environment. Oracles: the spec's key order and
 * session-composer-settings「有效值解析」(夹取与回落), written here as literals.
 *
 * Issue #1005 (task 8.2) adds the store half of the creation writer: (g) the last-choice upsert
 * touches only the given columns, (h) a failing `session.permission` audit rolls the whole
 * creation back on both paths, (i) invalid values are refused before the temporary workspace is
 * made. The REST scenarios are in session-composer-rest.test.ts.
 *
 * Issue #1006 (task 8.3): the `yolo` row of (c) is written by `patchSession`, not planted.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
  type SessionMetadataStoreOptions,
} from "../src/sessions/store-metadata.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { TEST_COMPOSER, THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
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
const CATALOG = THREE_MODEL_CATALOG;

type Composer = { approvalMode: string; modelId: string; reasoningEffort: string | null };

interface Stores {
  store: SessionStore;
  metadata: SessionMetadataStore;
  sandboxRoot: string;
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

/**
 * Both stores over `db`, each handed `composer` directly; closed (store) after the test.
 * `port` replaces the metadata store's `emit` / `createTemporaryWorkspace`, given the real one.
 */
function openStores(
  db: DatabaseSync,
  composer: ComposerConfig,
  port: (
    real: Pick<SessionMetadataStoreOptions, "emit" | "createTemporaryWorkspace">,
  ) => Partial<SessionMetadataStoreOptions> = () => ({}),
): Stores {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "workbuddy-composer-store-"));
  const store = createSessionStore(db, { onFlushError() {}, emit, composer });
  const metadata = createSessionMetadataStore(db, {
    emit,
    sandboxRoot,
    createTemporaryWorkspace: temporaryWorkspacePort(db, sandboxRoot),
    composer,
    ...port({ emit, createTemporaryWorkspace: temporaryWorkspacePort(db, sandboxRoot) }),
  });
  cleanups.push(() => {
    store.close();
    rmSync(sandboxRoot, { recursive: true, force: true });
  });
  return { store, metadata, sandboxRoot };
}

function prefsRows(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      "SELECT account_id, approval_mode, model_id, reasoning_effort, updated_at FROM account_composer_prefs ORDER BY account_id",
    )
    .all();
}

function count(db: DatabaseSync, table: "chat_sessions" | "workspaces" | "audit_events"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return Number(row.n);
}

/** The `tmp-*` directories under `u1`'s account root; none when the root was never made. */
function temporaryDirs(sandboxRoot: string): string[] {
  const accountRoot = join(sandboxRoot, "u1");
  return existsSync(accountRoot)
    ? readdirSync(accountRoot).filter((name) => name.startsWith("tmp-"))
    : [];
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

  it("(c) 调低上界：PATCH 写出的 yolo 行，同一库先后以 yolo、write、yolo 开 store，视图读 yolo / write / yolo，列值与审计不变", () => {
    const db = openDatabase();
    const opened = openStores(db, TEST_COMPOSER);
    const session = opened.store.create("u1").id;
    // 未绑定空间的行：这一条 session.permission 的 workspaceId 为 null。
    expect(
      composerOf(opened.metadata.patchSession("u1", session, { approvalMode: "yolo" })),
    ).toEqual({ approvalMode: "yolo", modelId: "deepseek-v4.1-flash", reasoningEffort: "high" });
    expect(
      db.prepare("SELECT kind, actor_id, workspace_id, detail FROM audit_events").all(),
    ).toEqual([
      {
        kind: "session.permission",
        actor_id: "u1",
        workspace_id: null,
        detail: JSON.stringify({ sessionId: session, from: "write", to: "yolo" }),
      },
    ]);
    const read: unknown[] = [];

    for (const approvalMaxMode of ["yolo", "write", "yolo"] as const) {
      const { store } = openStores(db, { ...TEST_COMPOSER, approvalMaxMode });
      const [listed, snapshot] = readEverywhere(store, session);
      expect(snapshot).toEqual(listed);
      read.push((listed as { approvalMode: string }).approvalMode);
      read.push((rawColumns(db, session) as { approval_mode: string }).approval_mode);
    }

    expect(read).toEqual(["yolo", "yolo", "write", "yolo", "yolo", "yolo"]);
    // 换上界重开与读取都不是用户动作：审计仍只有 PATCH 的那一条。
    expect(count(db, "audit_events")).toBe(1);
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

describe("创建写入最近选择 (session-composer-settings「创建会话时的设置与继承」)", () => {
  it("(g) upsert 只改所给列：先两键再一键，前两列不变且 updated_at 前进；无键创建整行不变", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const db = openDatabase();
    insertWorkspace(db, WORKSPACE, "u1", "周报空间", "weekly", NOW);
    const { metadata } = openStores(db, { approvalMaxMode: "yolo", modelCatalog: CATALOG });

    const first = metadata.createSession("u1", { approvalMode: "always-ask", modelId: "m3" });

    expect(prefsRows(db)).toEqual([
      {
        account_id: "u1",
        approval_mode: "always-ask",
        model_id: "m3",
        reasoning_effort: null,
        updated_at: NOW,
      },
    ]);
    expect(rawColumns(db, first.id)).toEqual({
      approval_mode: "always-ask",
      model_id: "m3",
      reasoning_effort: null,
    });

    vi.setSystemTime(NOW + 7);
    const second = metadata.createSession("u1", { workspaceId: WORKSPACE, reasoningEffort: "low" });

    const afterSecond = {
      account_id: "u1",
      approval_mode: "always-ask",
      model_id: "m3",
      reasoning_effort: "low",
      updated_at: NOW + 7,
    };
    expect(prefsRows(db)).toEqual([afterSecond]);
    // 未给的两键照抄最近选择的原始值。
    expect(rawColumns(db, second.id)).toEqual({
      approval_mode: "always-ask",
      model_id: "m3",
      reasoning_effort: "low",
    });

    vi.setSystemTime(NOW + 20);
    const third = metadata.createSession("u1", {});
    const fourth = metadata.createSession("u1", { workspaceId: WORKSPACE, scene: "code" });

    expect(prefsRows(db)).toEqual([afterSecond]);
    for (const inherited of [third, fourth]) {
      expect(composerOf(inherited)).toEqual({
        approvalMode: "always-ask",
        modelId: "m3",
        reasoningEffort: "low",
      });
    }

    // 另一个账号不受影响：没有最近选择，三列为 NULL。
    const foreign = metadata.createSession("u2", {});
    expect(rawColumns(db, foreign.id)).toEqual({
      approval_mode: null,
      model_id: null,
      reasoning_effort: null,
    });
    expect(prefsRows(db)).toEqual([afterSecond]);
  });

  it.each<[string, string | undefined]>([
    ["绑定工作空间的创建", WORKSPACE],
    ["临时空间的创建", undefined],
  ])(
    "(h) %s：session.permission 审计失败则会话行、空间行、审计与最近选择都不落",
    (_name, workspaceId) => {
      const db = openDatabase();
      insertWorkspace(db, WORKSPACE, "u1", "周报空间", "weekly", NOW);
      const { metadata, sandboxRoot } = openStores(
        db,
        { approvalMaxMode: "yolo", modelCatalog: CATALOG },
        (real) => ({
          emit(target, event) {
            if (event.kind === "session.permission") {
              throw new Error("audit down");
            }
            return real.emit(target, event);
          },
        }),
      );
      // 先落一行最近选择（档位为 NULL，不写审计），它必须原样留下。
      metadata.createSession("u1", { workspaceId: WORKSPACE, modelId: "m3" });
      const before = {
        sessions: count(db, "chat_sessions"),
        workspaces: count(db, "workspaces"),
        audits: count(db, "audit_events"),
        prefs: prefsRows(db),
        dirs: temporaryDirs(sandboxRoot),
      };
      expect(before).toMatchObject({ sessions: 1, workspaces: 1, audits: 1, dirs: [] });

      expect(() =>
        metadata.createSession("u1", {
          ...(workspaceId === undefined ? {} : { workspaceId }),
          approvalMode: "yolo",
          reasoningEffort: "max",
        }),
      ).toThrow("audit down");

      expect({
        sessions: count(db, "chat_sessions"),
        workspaces: count(db, "workspaces"),
        audits: count(db, "audit_events"),
        prefs: prefsRows(db),
        dirs: temporaryDirs(sandboxRoot),
      }).toEqual(before);
      expect(db.isTransaction).toBe(false);
    },
  );

  it("(i) 取值不合法：先于临时空间的创建被拒绝，createTemporaryWorkspace 调用零次", () => {
    const db = openDatabase();
    const calls: string[] = [];
    const { metadata, sandboxRoot } = openStores(
      db,
      { approvalMaxMode: "write", modelCatalog: CATALOG },
      (real) => ({
        createTemporaryWorkspace(ownerId) {
          calls.push(ownerId);
          return real.createTemporaryWorkspace(ownerId);
        },
      }),
    );

    for (const input of [
      { approvalMode: "yolo" },
      { approvalMode: "nope" },
      { modelId: "gone" },
      { reasoningEffort: "auto" },
      { modelId: "m2", reasoningEffort: "high" },
    ]) {
      expect(() => metadata.createSession("u1", input)).toThrow(
        expect.objectContaining({ name: "HttpError", code: "bad_request" }),
      );
    }

    expect(calls).toEqual([]);
    expect(count(db, "chat_sessions")).toBe(0);
    expect(count(db, "workspaces")).toBe(0);
    expect(prefsRows(db)).toEqual([]);
    expect(temporaryDirs(sandboxRoot)).toEqual([]);
    expect(db.isTransaction).toBe(false);

    // 合法取值走到临时空间的创建：上面的零次不是因为端口没接上。
    metadata.createSession("u1", { approvalMode: "write" });
    expect(calls).toEqual(["u1"]);
    expect(temporaryDirs(sandboxRoot)).toHaveLength(1);
  });
});
