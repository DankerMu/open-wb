/**
 * Issue #527 fork inherits session metadata (parent s1c-session-metadata-presentation tasks 4.4,
 * design D14). Every world is the production createApp → registerSessions assembly over real
 * fake-omp `branch` children (one extra `--branch-entry QUESTION`, so a three-turn source forks at
 * its third user message) on a real in-memory SQLite, driven through `app.inject()`. Workspaces
 * are created over `POST /api/workspaces` (the sandbox root is created first: the workspace store
 * realpaths it); the source is created over `POST /api/sessions {workspaceId?, scene}` and pinned
 * over `PATCH /api/sessions/:id {pinned:true}`; its history is written through the store
 * (`seedTwoTurns`), its steps and the `thinking`/`changes` columns by direct SQL. Oracles: the
 * fork 201 body, `GET /api/sessions`, the public snapshot, SQLite columns (with `typeof`), the
 * admin `GET /api/audit` view, spawn argv and the probe turn's reported `cwd=`. Paths are compared
 * through realpath (macOS tmpdir is /var → /private/var).
 *
 * Issue #1007 (s1g-composer-capabilities task 8.4, design D5/D6): the fork copies the source's
 * three RAW composer columns. Those worlds open the same assembly with the three-model whitelist
 * and an approval cap; the source's columns come from `POST /api/sessions` with the three keys or,
 * for values REST refuses, from a direct `UPDATE`. Oracles: the 201 view and list entry, the three
 * columns with `typeof`, the account's last-choice row and the `session.permission` row count.
 * The temp process's argv and the frames before the fork's first prompt are task group 9.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { auditCount, REAL, settle } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { forkWorlds, openForkWorld, type Seeded, seedTwoTurns } from "./session-fork-helpers.js";
import { SESSION_VIEW_KEYS, THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import { QUESTION, type RegenWorld, sendPrompt } from "./session-regenerate-helpers.js";
import { cookieFor, getSessionMessages } from "./session-rest-helpers.js";
import {
  type OpenSessionOptions,
  OWNER_ID,
  requiredCall,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { seedUnboundSession } from "./support/temporary-workspace.js";

const JSON_TYPE = "application/json";
const UNBOUND_SOURCE = "7".repeat(32);
/** Copied assistant a1's thinking: multi-byte on purpose (CJK and an astral emoji). */
const THINKING = "先读 README，再改 src/app.ts 🤔";
const CHANGES_A1 = [
  { path: "src/app.ts", added: 3, removed: 1, kind: "edit" },
  { path: "notes/计划.md", added: null, removed: null, kind: "write" },
];
const CHANGES_A2 = [{ path: "README.md", added: 12, removed: 0, kind: "edit" }];

const worlds = forkWorlds();
const probeDirs: string[] = [];

afterEach(() => {
  for (const dir of probeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Scene = "office" | "code" | "design";

interface SessionView {
  id: string;
  title: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  scene: Scene | null;
  workspaceId: string | null;
  pinnedAt: number | null;
  approvalMode: string;
  modelId: string;
  reasoningEffort: string | null;
}

/** The three composer settings: the request keys of a creation, or the three raw columns. */
interface Composer {
  approvalMode: string | null;
  modelId: string | null;
  reasoningEffort: string | null;
}

/** How a composer case lays its world and source out; `{}` is the single-model, cap-`yolo` world. */
interface ComposerSetup {
  assembly?: NonNullable<OpenSessionOptions["assembly"]>;
  /** Sent with the source's `POST /api/sessions`. */
  create?: Composer;
  /** Written over the source's three columns by SQL after its creation (values REST refuses). */
  raw?: Composer;
}

interface PublicHistory {
  messages: Array<{
    role: string;
    thinking: string | null;
    steps: Array<{ ordinal: number; changes: unknown }>;
  }>;
}

interface Workspace {
  id: string;
  root: string;
}

interface ForkWorld {
  world: RegenWorld;
  /** `<realpath(sandboxRoot)>/u1`: the unbound session cwd. */
  ownerRoot: string;
  workspace: Workspace | null;
  source: SessionView;
  /** The source's view (list entry) and the admin audit view, both read right before the fork. */
  sourceBefore: SessionView;
  auditBefore: unknown[];
  /** `audit_events` row count right before the fork. */
  auditRows: number;
  /** The owner's last-choice row and the `session.permission` row count right before the fork. */
  prefsBefore: unknown;
  permissionRows: number;
  fork: LightMyRequestResponse;
}

function inject(world: RegenWorld, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  return world.fixture.app.inject({
    method,
    url,
    headers:
      body === undefined
        ? { cookie: world.cookie }
        : { cookie: world.cookie, "content-type": JSON_TYPE },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function listed(world: RegenWorld): Promise<SessionView[]> {
  const response = await inject(world, "GET", "/api/sessions");
  expect(response.statusCode).toBe(200);
  return (response.json() as { sessions: SessionView[] }).sessions;
}

async function listedOf(world: RegenWorld, id: string): Promise<SessionView | undefined> {
  return (await listed(world)).find((session) => session.id === id);
}

async function adminAudit(world: RegenWorld): Promise<Array<{ kind: string }>> {
  const response = await world.fixture.app.inject({
    method: "GET",
    url: "/api/audit?limit=200",
    headers: { cookie: await cookieFor(world.fixture.app, "lisi") },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { events: Array<{ kind: string }> }).events;
}

function sessionMeta(db: DatabaseSync, id: string) {
  return db
    .prepare("SELECT workspace_id, scene, pinned_at FROM chat_sessions WHERE id = ?")
    .get(id);
}

/** The three raw composer columns of `id`, each with its SQLite storage class. */
function composerColumns(db: DatabaseSync, id: string) {
  return db
    .prepare(
      "SELECT approval_mode, typeof(approval_mode) AS approval_type, model_id, typeof(model_id) AS model_type, reasoning_effort, typeof(reasoning_effort) AS effort_type FROM chat_sessions WHERE id = ?",
    )
    .get(id);
}

/** What `composerColumns` reads for a row storing `raw`. */
function storedAs(raw: Composer) {
  const type = (value: string | null) => (value === null ? "null" : "text");
  return {
    approval_mode: raw.approvalMode,
    approval_type: type(raw.approvalMode),
    model_id: raw.modelId,
    model_type: type(raw.modelId),
    reasoning_effort: raw.reasoningEffort,
    effort_type: type(raw.reasoningEffort),
  };
}

/** The owner's whole `account_composer_prefs` row (`updated_at` included); undefined when none. */
function ownerPrefs(db: DatabaseSync) {
  return db.prepare("SELECT * FROM account_composer_prefs WHERE account_id = ?").get(OWNER_ID);
}

function permissionCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE kind = 'session.permission'")
    .get() as { count: number };
  return Number(row.count);
}

function composerOf(view: SessionView | undefined) {
  return {
    approvalMode: view?.approvalMode,
    modelId: view?.modelId,
    reasoningEffort: view?.reasoningEffort,
  };
}

/** `thinking` of every message of `session`, in snapshot order, with its SQLite storage class. */
function thinkingColumn(db: DatabaseSync, session: string) {
  return db
    .prepare(
      "SELECT thinking, typeof(thinking) AS type FROM chat_messages WHERE session_id = ? ORDER BY created_at, id",
    )
    .all(session);
}

/** `changes` of every step of `session`, message then ordinal order, with its storage class. */
function changesColumn(db: DatabaseSync, session: string) {
  return db
    .prepare(
      "SELECT s.ordinal, s.changes, typeof(s.changes) AS type FROM chat_steps AS s JOIN chat_messages AS m ON m.id = s.message_id WHERE m.session_id = ? ORDER BY m.created_at, m.id, s.ordinal",
    )
    .all(session);
}

function insertStep(db: DatabaseSync, messageId: number, ordinal: number, changes: string | null) {
  db.prepare(
    "INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at, ended_at, output, changes) VALUES (?, ?, 'bash', '{\"command\":\"ls\"}', 'done', 10, 20, 'ok', ?)",
  ).run(messageId, ordinal, changes);
}

/**
 * u1 → a1 → u2 → a2 → u3 (QUESTION) → a3 through the store; a1 carries THINKING and two steps
 * (CHANGES_A1, then NULL), a2 a NULL thinking and one CHANGES_A2 step; a3 (after the fork point)
 * carries its own thinking and step, which must stay behind.
 */
function seedHistory(world: RegenWorld, session: string): Seeded {
  const { db } = world.fixture;
  const seeded = seedTwoTurns(world, { extraTurn: true }, session);
  const setThinking = db.prepare("UPDATE chat_messages SET thinking = ? WHERE id = ?");
  expect(Number(setThinking.run(THINKING, seeded.a1).changes)).toBe(1);
  insertStep(db, seeded.a1, 0, JSON.stringify(CHANGES_A1));
  insertStep(db, seeded.a1, 1, null);
  insertStep(db, seeded.a2, 0, JSON.stringify(CHANGES_A2));
  const a3 = db
    .prepare("SELECT MAX(id) AS id FROM chat_messages WHERE session_id = ? AND role = 'assistant'")
    .get(session) as { id: number };
  setThinking.run("after the fork point", a3.id);
  insertStep(
    db,
    a3.id,
    0,
    JSON.stringify([{ path: "late.ts", added: 1, removed: 1, kind: "edit" }]),
  );
  return seeded;
}

/**
 * A real `branch` world (sandbox root created) whose source is created with `body`, optionally
 * pinned, seeded with the three-turn history above and forked over REST at u3. Nothing about the
 * inherited columns is asserted here: each case owns its own column family. `composer` picks the
 * world's whitelist and cap and the source's three settings (#1007).
 */
async function forkSource(
  body: { workspace: boolean; scene: Scene },
  pin: boolean,
  composer: ComposerSetup = {},
): Promise<ForkWorld> {
  const world = worlds.track(
    await openForkWorld({
      entries: [QUESTION],
      ...(composer.assembly === undefined ? {} : { assembly: composer.assembly }),
    }),
  );
  const sandboxRoot = world.rt.runtime.sandboxRoot;
  mkdirSync(sandboxRoot, { recursive: true });
  const ownerRoot = join(realpathSync(sandboxRoot), OWNER_ID);
  let workspace: Workspace | null = null;
  if (body.workspace) {
    const made = await inject(world, "POST", "/api/workspaces", { name: "proj", dir: "proj" });
    expect(made.statusCode).toBe(201);
    workspace = made.json() as Workspace;
  }
  let source: SessionView;
  if (workspace === null) {
    // REST no longer creates an unbound session (#930): the legacy row is written directly.
    const id = seedUnboundSession(world.fixture.db, OWNER_ID, UNBOUND_SOURCE, {
      scene: body.scene,
    });
    const seededView = await listedOf(world, id);
    if (seededView === undefined) {
      throw new Error("seeded unbound source missing from the list");
    }
    source = seededView;
  } else {
    const created = await inject(world, "POST", "/api/sessions", {
      workspaceId: workspace.id,
      scene: body.scene,
      ...composer.create,
    });
    expect(created.statusCode).toBe(201);
    source = created.json() as SessionView;
  }
  if (composer.raw !== undefined) {
    const { approvalMode, modelId, reasoningEffort } = composer.raw;
    const written = world.fixture.db
      .prepare(
        "UPDATE chat_sessions SET approval_mode = ?, model_id = ?, reasoning_effort = ? WHERE id = ?",
      )
      .run(approvalMode, modelId, reasoningEffort, source.id);
    expect(Number(written.changes)).toBe(1);
  }
  if (pin) {
    const pinned = await inject(world, "PATCH", `/api/sessions/${source.id}`, { pinned: true });
    expect(pinned.statusCode).toBe(200);
    source = pinned.json() as SessionView;
    expect(source.pinnedAt).toEqual(expect.any(Number));
  }
  const seeded = seedHistory(world, source.id);
  const sourceBefore = await listedOf(world, source.id);
  if (sourceBefore === undefined) {
    throw new Error("source missing from the list");
  }
  const auditBefore = await adminAudit(world);
  const auditRows = auditCount(world.fixture.db);
  const prefsBefore = ownerPrefs(world.fixture.db);
  const permissionRows = permissionCount(world.fixture.db);
  const fork = await postSessionAction(world.fixture.app, "fork", source.id, world.cookie, {
    name: "fork body",
    payload: JSON.stringify({ messageId: seeded.u3 }),
    contentType: JSON_TYPE,
  });
  expect([fork.statusCode, fork.headers["cache-control"]]).toEqual([201, "no-store"]);
  expect(world.rt.calls).toHaveLength(1);
  return {
    world,
    ownerRoot,
    workspace,
    source,
    sourceBefore,
    auditBefore,
    auditRows,
    prefsBefore,
    permissionRows,
    fork,
  };
}

/** The 201 `session`: exactly the fourteen view keys in wire order, draft = the u3 text. */
function forkedSession(fork: LightMyRequestResponse): SessionView {
  const body = fork.json() as { session: SessionView; draft: string };
  expect(Object.keys(body)).toEqual(["session", "draft"]);
  expect(Object.keys(body.session)).toEqual([...SESSION_VIEW_KEYS]);
  expect(body.draft).toBe(QUESTION);
  return body.session;
}

/**
 * Forks the bound, pinned `code` source; returns the copy's public messages and the source's
 * copied prefix (its first four messages), both read over `GET /api/sessions/:id/messages`.
 */
async function copiedHistories() {
  const { world, source, fork } = await forkSource({ workspace: true, scene: "code" }, true);
  const fresh = forkedSession(fork).id;
  const read = async (session: string) => {
    const response = await getSessionMessages(world.fixture.app, session, world.cookie);
    expect(response.statusCode).toBe(200);
    return (response.json() as PublicHistory).messages;
  };
  const copy = await read(fresh);
  const original = (await read(source.id)).slice(0, 4);
  return { db: world.fixture.db, source: source.id, fresh, copy, original };
}

function cwdArg(args: readonly string[]): string | undefined {
  const at = args.indexOf("--cwd");
  return at === -1 ? undefined : args[at + 1];
}

/** One REST probe turn on `session` to done; returns the child's reported `cwd=` (last field). */
async function probeTurn(world: RegenWorld, session: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "open-wb-527-probe-"));
  probeDirs.push(dir);
  const message = `probe:${String(process.pid)}:${join(dir, "out.txt")}`;
  expect((await sendPrompt(world, message, session)).statusCode).toBe(202);
  const tree = await waitForTurn(world.fixture, session, "done");
  await settle();
  const report = tree.messages.at(-1)?.content ?? "";
  const at = report.lastIndexOf(" cwd=");
  expect(at).toBeGreaterThan(0);
  return report.slice(at + " cwd=".length);
}

describe("fork inherits workspace and scene but not pin", () => {
  it(
    "the new session row and 201 view carry W and `code`, pinnedAt null; source pin and audit unchanged",
    REAL,
    async () => {
      const forked = await forkSource({ workspace: true, scene: "code" }, true);
      const { world, workspace, source, sourceBefore, auditBefore, auditRows, fork } = forked;
      const { db } = world.fixture;
      const workspaceId = workspace?.id ?? "";

      const session = forkedSession(fork);

      expect(session).toMatchObject({ workspaceId, scene: "code", pinnedAt: null });
      expect(session.id).not.toBe(source.id);
      expect(sessionMeta(db, session.id)).toEqual({
        workspace_id: workspaceId,
        scene: "code",
        pinned_at: null,
      });
      expect(sourceBefore.pinnedAt).toBe(source.pinnedAt);
      expect(await listedOf(world, source.id)).toEqual(sourceBefore);
      expect(sessionMeta(db, source.id)).toEqual({
        workspace_id: workspaceId,
        scene: "code",
        pinned_at: source.pinnedAt,
      });
      const auditAfter = await adminAudit(world);
      expect(auditAfter).toEqual(auditBefore);
      expect(auditAfter.filter((event) => event.kind === "session.bind")).toHaveLength(1);
      expect(auditCount(db)).toBe(auditRows);
    },
  );

  it(
    "every copied message's thinking equals the source's verbatim, NULL staying null",
    REAL,
    async () => {
      const { db, source, fresh, copy, original } = await copiedHistories();

      expect(copy.map((m) => [m.role, m.thinking])).toEqual([
        ["user", null],
        ["assistant", THINKING],
        ["user", null],
        ["assistant", null],
      ]);
      expect(copy.map((m) => m.thinking)).toEqual(original.map((m) => m.thinking));
      const column = thinkingColumn(db, fresh);
      expect(column).toEqual([
        { thinking: null, type: "null" },
        { thinking: THINKING, type: "text" },
        { thinking: null, type: "null" },
        { thinking: null, type: "null" },
      ]);
      expect(column).toEqual(thinkingColumn(db, source).slice(0, 4));
    },
  );

  it(
    "every copied step's changes equals the source's verbatim, in order, NULL staying null",
    REAL,
    async () => {
      const { db, source, fresh, copy, original } = await copiedHistories();

      const stepChanges = (messages: PublicHistory["messages"]) =>
        messages.map((m) => m.steps.map((step) => [step.ordinal, step.changes]));
      expect(stepChanges(copy)).toEqual([
        [],
        [
          [0, CHANGES_A1],
          [1, null],
        ],
        [],
        [[0, CHANGES_A2]],
      ]);
      expect(stepChanges(copy)).toEqual(stepChanges(original));
      const column = changesColumn(db, fresh);
      expect(column).toEqual([
        { ordinal: 0, changes: JSON.stringify(CHANGES_A1), type: "text" },
        { ordinal: 1, changes: null, type: "null" },
        { ordinal: 0, changes: JSON.stringify(CHANGES_A2), type: "text" },
      ]);
      expect(column).toEqual(changesColumn(db, source).slice(0, 3));
    },
  );

  it(
    "a prompt on the fork runs its child with --cwd and probe cwd at W's root, not the owner root",
    REAL,
    async () => {
      const { world, ownerRoot, workspace, fork } = await forkSource(
        { workspace: true, scene: "code" },
        true,
      );
      const root = realpathSync(workspace?.root ?? "");
      const fresh = forkedSession(fork).id;

      const reported = await probeTurn(world, fresh);

      expect(world.rt.calls).toHaveLength(2);
      const call = requiredCall(world.rt.calls, 1);
      expect(call.args).toContain("--resume");
      expect(realpathSync(cwdArg(call.args) ?? "")).toBe(root);
      expect(reported).toBe(root);
      expect(root).not.toBe(ownerRoot);
      expect(reported).not.toBe(ownerRoot);
    },
  );
});

describe("the fork response view equals the list entry", () => {
  it(
    "a bound, pinned `design` source forks to a fourteen-key view equal to its list entry",
    REAL,
    async () => {
      const { world, workspace, fork } = await forkSource(
        { workspace: true, scene: "design" },
        true,
      );

      const session = forkedSession(fork);

      expect(session).toMatchObject({
        workspaceId: workspace?.id,
        scene: "design",
        pinnedAt: null,
      });
      const entry = await listedOf(world, session.id);
      expect(entry).toEqual(session);
      expect(Object.keys(entry ?? {})).toEqual([...SESSION_VIEW_KEYS]);
    },
  );
});

describe("an unbound source with a scene", () => {
  it(
    "forks to workspaceId null and scene `office`; the fork's prompt runs in the owner root",
    REAL,
    async () => {
      const { world, ownerRoot, auditRows, fork } = await forkSource(
        { workspace: false, scene: "office" },
        false,
      );
      const { db } = world.fixture;

      const session = forkedSession(fork);

      expect(session).toMatchObject({ workspaceId: null, scene: "office", pinnedAt: null });
      expect(sessionMeta(db, session.id)).toEqual({
        workspace_id: null,
        scene: "office",
        pinned_at: null,
      });
      const reported = await probeTurn(world, session.id);
      expect(realpathSync(cwdArg(requiredCall(world.rt.calls, 1).args) ?? "")).toBe(ownerRoot);
      expect(reported).toBe(ownerRoot);
      expect(auditCount(db)).toBe(auditRows);
    },
  );
});

describe("fork inherits the three composer settings (#1007)", () => {
  it(
    "a `yolo`/`m3`/`low` source forks to the same view and raw columns; last choice and audit untouched",
    REAL,
    async () => {
      const chosen = { approvalMode: "yolo", modelId: "m3", reasoningEffort: "low" };
      const forked = await forkSource({ workspace: true, scene: "code" }, false, {
        assembly: { modelCatalog: THREE_MODEL_CATALOG, approvalMaxMode: "yolo" },
        create: chosen,
      });
      const { world, source, auditRows, prefsBefore, permissionRows, fork } = forked;
      const { db } = world.fixture;

      const session = forkedSession(fork);

      expect(composerOf(source)).toEqual(chosen);
      expect(composerOf(session)).toEqual(chosen);
      expect(await listedOf(world, session.id)).toEqual(session);
      expect(composerColumns(db, source.id)).toEqual(storedAs(chosen));
      expect(composerColumns(db, session.id)).toEqual(composerColumns(db, source.id));
      // The source's creation wrote the last-choice row and one `session.permission`; the fork
      // adds to neither.
      expect(prefsBefore).toEqual({
        account_id: OWNER_ID,
        approval_mode: "yolo",
        model_id: "m3",
        reasoning_effort: "low",
        updated_at: source.createdAt,
      });
      expect(ownerPrefs(db)).toEqual(prefsBefore);
      expect([permissionRows, permissionCount(db)]).toEqual([1, 1]);
      expect(auditCount(db)).toBe(auditRows);
    },
  );

  it(
    "raw values above the cap or off the whitelist are copied raw; the view clamps like the source's",
    REAL,
    async () => {
      const raw = { approvalMode: "yolo", modelId: "gone", reasoningEffort: "xhigh" };
      const { world, source, sourceBefore, fork } = await forkSource(
        { workspace: true, scene: "code" },
        false,
        { assembly: { modelCatalog: THREE_MODEL_CATALOG, approvalMaxMode: "write" }, raw },
      );
      const { db } = world.fixture;

      const session = forkedSession(fork);

      expect(composerColumns(db, session.id)).toEqual(storedAs(raw));
      expect(composerColumns(db, source.id)).toEqual(storedAs(raw));
      expect(composerOf(session)).toEqual({
        approvalMode: "write",
        modelId: "m1",
        reasoningEffort: "xhigh",
      });
      expect(composerOf(session)).toEqual(composerOf(sourceBefore));
      expect(await listedOf(world, session.id)).toEqual(session);
    },
  );

  it(
    "three NULL columns stay NULL on the fork; its view reads the default effective values",
    REAL,
    async () => {
      const unset = { approvalMode: null, modelId: null, reasoningEffort: null };
      const { world, source, prefsBefore, permissionRows, fork } = await forkSource(
        { workspace: true, scene: "code" },
        false,
        { assembly: { modelCatalog: THREE_MODEL_CATALOG, approvalMaxMode: "yolo" } },
      );
      const { db } = world.fixture;

      const session = forkedSession(fork);

      expect(composerColumns(db, source.id)).toEqual(storedAs(unset));
      expect(composerColumns(db, session.id)).toEqual(storedAs(unset));
      expect(composerOf(session)).toEqual({
        approvalMode: "write",
        modelId: "m1",
        reasoningEffort: "high",
      });
      expect(composerOf(session)).toEqual(composerOf(source));
      expect([prefsBefore, ownerPrefs(db)]).toEqual([undefined, undefined]);
      expect([permissionRows, permissionCount(db)]).toEqual([0, 0]);
    },
  );
});
