/**
 * Issue #927 (s1f-session-list-temp-space task 4.2): `POST /api/workspaces/:id/promote` through the
 * REST seam — temporary-workspaces 「转正」 (原地转正 / 运行中也可转正 / 冲突、非法与重复 / 鉴权),
 * the promote half of http-service-skeleton 「撤回与转正路由属于归属集」 and the second half of
 * workspaces 「临时空间不在列表里，转正后出现」. Real `createApp`, real SQLite, real directories; the
 * two cases that need a process (probe cwd, a turn in flight) run real fake-omp children. T comes
 * from the 3.2 helper over a second store on the same database and sandbox root. Oracles: the
 * spec's literals, the bytes written here and the values read before the request.
 */
import { Buffer } from "node:buffer";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createWorkspaceStore } from "../src/workspaces/store.js";
import { removeTempDirs } from "./core-db-helpers.js";
import { REAL, settle } from "./session-approval-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import {
  heldLine,
  openRegenWorld,
  type RegenWorld,
  regenWorlds,
  sendPrompt,
  waitDead,
} from "./session-regenerate-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import { IDLE_MS, OWNER_ID, waitForTurn } from "./session-supervisor-helpers.js";
import { seedTemporaryWorkspaceSession } from "./support/temporary-workspace.js";
import { withWorkspacesApp } from "./workspaces-http-helpers.js";

const JSON_TYPE = "application/json";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const OWNER = "u1";
const OTHER = "u2";
const OWNER_SESSION = "5".repeat(32);
const OTHER_SESSION = "6".repeat(32);
const UNKNOWN_ID = "e".repeat(32);
const FIVE_KEYS = ["id", "name", "dir", "root", "createdAt"];
const NOTES = Buffer.from("调研笔记\n", "utf8");
const BODY_LIMIT = 16 * 1024;
const CONFLICT_ENVELOPE = { error: { code: "conflict", message: "同名资源已存在" } };
const VALID_BODY = JSON.stringify({ name: "调研资料" });
const MALFORMED_JSON = '{"name": ';

interface Workspace {
  id: string;
  name: string;
  dir: string;
  root: string;
  createdAt: number;
}

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  sandboxRoot: string;
  owner: string;
  other: string;
  /** The owner's ordinary workspace `项目A`, older than every temporary workspace. */
  normal: Workspace;
  /** The owner's temporary workspace T with session S bound to it. */
  temporary: Workspace;
  /** A temporary workspace of the other account. */
  foreignTemporary: Workspace;
}

interface Body {
  payload: string;
  /** Omitted → `application/json`; null → no Content-Type header at all. */
  contentType?: string | null;
}

const worlds = regenWorlds();
const probeDirs: string[] = [];

afterEach(() => {
  for (const dir of probeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  removeTempDirs();
});

async function withWorld(action: (world: World) => Promise<void>): Promise<void> {
  await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
    const owner = await cookieFor(app, "zhangsan");
    const other = await cookieFor(app, "zhaoliu");
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { "content-type": JSON_TYPE, cookie: owner },
      payload: JSON.stringify({ name: "项目A", dir: "project-a" }),
    });
    expect(created.statusCode).toBe(201);
    const normal = { ...(created.json() as Workspace), createdAt: 1 };
    // The list orders by creation time: pin 项目A before T instead of racing the clock.
    db.prepare("UPDATE workspaces SET created_at = 1 WHERE id = ?").run(normal.id);
    const store = createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit });
    const temporary = seedTemporaryWorkspaceSession(db, store, OWNER, OWNER_SESSION);
    const foreignTemporary = seedTemporaryWorkspaceSession(db, store, OTHER, OTHER_SESSION);
    expect(temporary.root).toBe(join(sandboxRoot, OWNER, `tmp-${temporary.id}`));
    await action({ app, db, sandboxRoot, owner, other, normal, temporary, foreignTemporary });
  });
}

function promote(
  app: FastifyInstance,
  workspaceId: string,
  cookie: string | undefined,
  body: Body = { payload: VALID_BODY },
): Promise<LightMyRequestResponse> {
  const contentType = body.contentType === undefined ? JSON_TYPE : body.contentType;
  return app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/promote`,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(contentType === null ? {} : { "content-type": contentType }),
    },
    payload: body.payload,
  });
}

function get(app: FastifyInstance, url: string, cookie: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: "GET", url, headers: { cookie } });
}

function wireShape(response: LightMyRequestResponse) {
  return {
    status: response.statusCode,
    cacheControl: response.headers["cache-control"],
    contentType: response.headers["content-type"],
    contentLength: response.headers["content-length"],
    body: response.payload,
  };
}

function envelopeShape(status: number, envelope: object) {
  const body = JSON.stringify(envelope);
  return {
    status,
    cacheControl: "no-store",
    contentType: JSON_CONTENT_TYPE,
    contentLength: String(Buffer.byteLength(body, "utf8")),
    body,
  };
}

const BAD_REQUEST = envelopeShape(400, BAD_REQUEST_ENVELOPE);
const NOT_FOUND = envelopeShape(404, NOT_FOUND_ENVELOPE);
const UNAUTHORIZED = envelopeShape(401, UNAUTHORIZED_ENVELOPE);
const CONFLICT = envelopeShape(409, CONFLICT_ENVELOPE);

/** Every row and directory entry a promote could touch, verbatim. */
function state(db: DatabaseSync, sandboxRoot: string) {
  const owners = readdirSync(sandboxRoot).toSorted();
  return {
    workspaces: db.prepare("SELECT * FROM workspaces ORDER BY id").all(),
    sessions: db.prepare("SELECT * FROM chat_sessions ORDER BY id").all(),
    audits: db.prepare("SELECT CAST(id AS TEXT) AS id, kind FROM audit_events ORDER BY id").all(),
    dirs: owners.map((entry) => [entry, readdirSync(join(sandboxRoot, entry)).toSorted()]),
  };
}

function workspaceRow(db: DatabaseSync, workspaceId: string): unknown {
  return db
    .prepare("SELECT owner_id, name, dir, temporary, created_at FROM workspaces WHERE id = ?")
    .get(workspaceId);
}

async function listedWorkspaces(app: FastifyInstance, cookie: string): Promise<Workspace[]> {
  const response = await get(app, "/api/workspaces", cookie);
  expect(response.statusCode).toBe(200);
  return (response.json() as { workspaces: Workspace[] }).workspaces;
}

async function sessionView(app: FastifyInstance, cookie: string, sessionId: string) {
  const response = await get(app, "/api/sessions", cookie);
  expect(response.statusCode).toBe(200);
  const sessions = (response.json() as { sessions: Array<Record<string, unknown>> }).sessions;
  return sessions.find((session) => session.id === sessionId);
}

/** A JSON object body of exactly `bytes` bytes whose only key is `name`. */
function paddedBody(name: string, bytes: number): string {
  const head = `{"name":${JSON.stringify(name)}`;
  const body = `${head}${" ".repeat(bytes - Buffer.byteLength(head, "utf8") - 1)}}`;
  expect(Buffer.byteLength(body, "utf8")).toBe(bytes);
  return body;
}

describe("转正：原地转正", () => {
  it("200 与五键对象；目录、notes.md、会话行都不动；列表出现该空间，会话读作非临时，审计为 workspace.promote", async () => {
    await withWorld(async ({ app, db, sandboxRoot, owner, normal, temporary }) => {
      const notes = join(temporary.root, "notes.md");
      writeFileSync(notes, NOTES);
      const inodes = { root: lstatSync(temporary.root).ino, notes: lstatSync(notes).ino };
      const before = state(db, sandboxRoot);
      const dir = `tmp-${temporary.id}`;
      // 「临时空间不在列表里」: the list is 项目A alone, and S reads as temporary.
      expect(await listedWorkspaces(app, owner)).toEqual([normal]);
      expect(await sessionView(app, owner, OWNER_SESSION)).toMatchObject({
        workspaceId: temporary.id,
        temporaryWorkspace: true,
      });

      const response = await promote(app, temporary.id, owner, {
        payload: JSON.stringify({ name: "  调研资料  " }),
      });

      const expected = {
        id: temporary.id,
        name: "调研资料",
        dir,
        root: temporary.root,
        createdAt: temporary.createdAt,
      };
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toBe(JSON_CONTENT_TYPE);
      expect(response.json()).toEqual(expected);
      expect(Object.keys(response.json() as object)).toEqual(FIVE_KEYS);
      expect(workspaceRow(db, temporary.id)).toEqual({
        owner_id: OWNER,
        name: "调研资料",
        dir,
        temporary: 0,
        created_at: temporary.createdAt,
      });

      // Nothing on disk moved, was renamed or rewritten.
      const after = state(db, sandboxRoot);
      expect(after.dirs).toEqual(before.dirs);
      expect(readdirSync(temporary.root)).toEqual(["notes.md"]);
      expect(lstatSync(temporary.root).ino).toBe(inodes.root);
      expect(lstatSync(notes).ino).toBe(inodes.notes);
      expect(readFileSync(notes).equals(NOTES)).toBe(true);
      // No session row changed.
      expect(after.sessions).toEqual(before.sessions);

      // 「转正后出现」: 项目A, then 调研资料 with its `tmp-<T>` directory; five keys each.
      const listed = await listedWorkspaces(app, owner);
      expect(listed).toEqual([normal, expected]);
      expect(listed.map((workspace) => workspace.name)).toEqual(["项目A", "调研资料"]);
      for (const workspace of listed) {
        expect(Object.keys(workspace)).toEqual(FIVE_KEYS);
      }
      expect(await sessionView(app, owner, OWNER_SESSION)).toMatchObject({
        workspaceId: temporary.id,
        temporaryWorkspace: false,
      });

      const audit = await get(app, "/api/audit?limit=1", owner);
      expect(audit.statusCode).toBe(200);
      const events = (audit.json() as { events: Array<Record<string, unknown>> }).events;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "workspace.promote",
        title: "另存为工作空间 调研资料",
        actorId: OWNER,
        workspaceId: temporary.id,
        detail: { root: temporary.root },
      });
      expect(after.audits).toHaveLength(before.audits.length + 1);
      expect(after.audits.at(-1)).toMatchObject({ kind: "workspace.promote" });
    });
  });

  it("accepts a body of exactly 16 KiB", async () => {
    await withWorld(async ({ app, db, owner, temporary }) => {
      const response = await promote(app, temporary.id, owner, {
        payload: paddedBody("刚好", BODY_LIMIT),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: temporary.id, name: "刚好" });
      expect(workspaceRow(db, temporary.id)).toMatchObject({ name: "刚好", temporary: 0 });
    });
  });
});

interface ProcessWorld {
  world: RegenWorld;
  temporary: Workspace;
  session: string;
}

/** A real fake-omp world plus T and its session S, owned by the world's account. */
async function openProcessWorld(hold?: (line: string) => boolean): Promise<ProcessWorld> {
  const world = worlds.track(await openRegenWorld(hold === undefined ? {} : { hold }));
  const sandboxRoot = world.rt.runtime.sandboxRoot;
  mkdirSync(sandboxRoot, { recursive: true });
  const store = createWorkspaceStore(world.fixture.db, { sandboxRoot, ensureSharedDir, emit });
  const temporary = seedTemporaryWorkspaceSession(world.fixture.db, store, OWNER_ID, OWNER_SESSION);
  return { world, temporary, session: OWNER_SESSION };
}

/** One REST probe turn to done; returns the child's reported `cwd=` (the report's last field). */
async function probeTurn(world: RegenWorld, session: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "open-wb-927-probe-"));
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

function cwdArg(args: readonly string[]): string | undefined {
  const at = args.indexOf("--cwd");
  return at === -1 ? undefined : args[at + 1];
}

describe("转正：进程与工作目录", () => {
  it(
    "原地转正：S 随后的 prompt 其进程 probe 报告的 cwd 仍是同一根，同一进程与重新启动的进程都是",
    REAL,
    async () => {
      const { world, temporary, session } = await openProcessWorld();
      const { app, supervisor } = world.fixture;
      const notes = join(temporary.root, "notes.md");
      writeFileSync(notes, NOTES);
      const inode = lstatSync(notes).ino;
      const root = realpathSync(temporary.root);
      expect(await probeTurn(world, session)).toBe(root);

      const response = await promote(app, temporary.id, world.cookie);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ dir: `tmp-${temporary.id}`, root: temporary.root });
      // The live process was not retired: the next turn runs in it, in the same directory.
      expect(supervisor.liveProcessCount()).toBe(1);
      expect(await probeTurn(world, session)).toBe(root);
      expect(world.rt.calls).toHaveLength(1);

      // A process started after the promotion gets the same root.
      world.rt.clock.advance(IDLE_MS);
      await waitDead(world, 0);
      await settle();
      expect(supervisor.liveProcessCount()).toBe(0);
      expect(await probeTurn(world, session)).toBe(root);
      expect(world.rt.calls).toHaveLength(2);
      expect(cwdArg(world.rt.calls[1]?.args ?? [])).toBe(cwdArg(world.rt.calls[0]?.args ?? []));
      expect(cwdArg(world.rt.calls[1]?.args ?? [])).toBe(temporary.root);
      expect(lstatSync(notes).ino).toBe(inode);
      expect(readFileSync(notes).equals(NOTES)).toBe(true);
    },
  );

  it("运行中也可转正：200，回合照常结束，没有进程被退役", REAL, async () => {
    const { world, temporary, session } = await openProcessWorld((line) =>
      line.includes('"type":"agent_end"'),
    );
    const { app, db, supervisor } = world.fixture;
    expect((await sendPrompt(world, "进行中的回合", session)).statusCode).toBe(202);
    await heldLine(world);
    const statusOf = () =>
      db.prepare("SELECT status FROM chat_sessions WHERE id = ?").get(session) as {
        status: string;
      };
    expect(statusOf()).toEqual({ status: "running" });
    expect(supervisor.liveProcessCount()).toBe(1);

    const response = await promote(app, temporary.id, world.cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: temporary.id, name: "调研资料" });
    expect(statusOf()).toEqual({ status: "running" });
    expect(supervisor.liveProcessCount()).toBe(1);

    world.spawned[0]?.gate.release();
    const tree = await waitForTurn(world.fixture, session, "done");
    await settle();
    expect(tree.messages.at(-1)).toMatchObject({ role: "assistant", status: "done" });
    expect(world.rt.calls).toHaveLength(1);
    expect(supervisor.liveProcessCount()).toBe(1);
    expect(world.spawned[0]?.child.exitCode).toBeNull();
    expect(world.errors).toEqual([]);
  });
});

describe("转正：冲突、非法与重复", () => {
  it("依次 409、四次 400、对正式空间 400、成功后再次 400；除成功的那一次外行与审计都不变", async () => {
    await withWorld(async ({ app, db, sandboxRoot, owner, normal, temporary }) => {
      const before = state(db, sandboxRoot);

      expect(
        wireShape(
          await promote(app, temporary.id, owner, { payload: JSON.stringify({ name: "项目A" }) }),
        ),
      ).toEqual(CONFLICT);
      expect(state(db, sandboxRoot)).toEqual(before);

      for (const payload of ['{"name":""}', '{"name":"x","dir":"y"}', "[]", MALFORMED_JSON]) {
        expect(wireShape(await promote(app, temporary.id, owner, { payload })), payload).toEqual(
          BAD_REQUEST,
        );
        expect(state(db, sandboxRoot), payload).toEqual(before);
      }

      // The owner's own ordinary workspace: 400, not 404 and not a rename.
      expect(
        wireShape(
          await promote(app, normal.id, owner, { payload: JSON.stringify({ name: "改名" }) }),
        ),
      ).toEqual(BAD_REQUEST);
      expect(state(db, sandboxRoot)).toEqual(before);

      const promoted = await promote(app, temporary.id, owner);
      expect(promoted.statusCode).toBe(200);
      const after = state(db, sandboxRoot);
      expect(after.audits).toHaveLength(before.audits.length + 1);

      expect(
        wireShape(
          await promote(app, temporary.id, owner, { payload: JSON.stringify({ name: "第二次" }) }),
        ),
      ).toEqual(BAD_REQUEST);
      expect(state(db, sandboxRoot)).toEqual(after);
      expect(workspaceRow(db, temporary.id)).toMatchObject({ name: "调研资料", temporary: 0 });
    });
  });

  it("另一个账号的同名空间不构成冲突", async () => {
    await withWorld(async ({ app, db, other, foreignTemporary }) => {
      const response = await promote(app, foreignTemporary.id, other, {
        payload: JSON.stringify({ name: "项目A" }),
      });

      expect(response.statusCode).toBe(200);
      expect(workspaceRow(db, foreignTemporary.id)).toMatchObject({
        owner_id: OTHER,
        name: "项目A",
        temporary: 0,
      });
    });
  });

  it.each([
    ["an empty object", "{}"],
    ["a differently cased key", '{"Name":"x"}'],
    ["an extra key", '{"name":"x","temporary":false}'],
    ["a number name", '{"name":1}'],
    ["a null name", '{"name":null}'],
    ["an array name", '{"name":["x"]}'],
    ["an object name", '{"name":{"value":"x"}}'],
    ["a JSON null", "null"],
    ["a JSON string", '"调研资料"'],
    ["an array holding the object", '[{"name":"x"}]'],
  ])("body 恰为 {name:string}：%s 是 400，无写入", async (_name, payload) => {
    await withWorld(async ({ app, db, sandboxRoot, owner, temporary }) => {
      const before = state(db, sandboxRoot);

      expect(wireShape(await promote(app, temporary.id, owner, { payload }))).toEqual(BAD_REQUEST);
      expect(state(db, sandboxRoot)).toEqual(before);
    });
  });

  // `POST /api/workspaces`'s name rule, restated from the requirement text.
  it.each([
    ["blank", "   "],
    ["65 code points", "n".repeat(65)],
    ["65 astral code points", "😀".repeat(65)],
    ["U+0000", "ok\u0000name"],
    ["U+001F", "ok\u001fname"],
    ["a line feed", "ok\nname"],
    ["U+007F", "ok\u007fname"],
    ["a lone high surrogate", "\uD800"],
    ["a lone low surrogate", "\uDC00"],
  ])("名字规则：%s 是 400，无写入", async (_name, name) => {
    await withWorld(async ({ app, db, sandboxRoot, owner, temporary }) => {
      const before = state(db, sandboxRoot);

      const response = await promote(app, temporary.id, owner, {
        payload: JSON.stringify({ name }),
      });

      expect(wireShape(response)).toEqual(BAD_REQUEST);
      expect(state(db, sandboxRoot)).toEqual(before);
    });
  });

  it("名字规则：64 个星面字符被接受", async () => {
    await withWorld(async ({ app, owner, temporary }) => {
      const name = "😀".repeat(64);

      const response = await promote(app, temporary.id, owner, {
        payload: JSON.stringify({ name }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ name, dir: `tmp-${temporary.id}` });
    });
  });
});

/** Valid, invalid, unparseable and oversized bodies: the owner check must answer before all of them. */
const ANY_BODY: ReadonlyArray<[string, Body]> = [
  ["a valid body", { payload: VALID_BODY }],
  ["an invalid name", { payload: '{"name":""}' }],
  ["an array", { payload: "[]" }],
  ["malformed JSON", { payload: MALFORMED_JSON }],
  ["an empty JSON body", { payload: "" }],
  ["text/plain", { payload: VALID_BODY, contentType: "text/plain" }],
  ["an unsupported media type", { payload: "binary", contentType: "application/octet-stream" }],
  ["a body over 16 KiB", { payload: paddedBody("x", BODY_LIMIT + 1) }],
  ["no body at all", { payload: "", contentType: null }],
];

describe("转正：鉴权", () => {
  it.each(ANY_BODY)("匿名请求带 %s 是 401，无写入", async (_name, body) => {
    await withWorld(async ({ app, db, sandboxRoot, temporary }) => {
      const before = state(db, sandboxRoot);

      expect(wireShape(await promote(app, temporary.id, undefined, body))).toEqual(UNAUTHORIZED);
      expect(state(db, sandboxRoot)).toEqual(before);
    });
  });

  it.each(ANY_BODY)(
    "第二个账号对 T 与任意账号对随机 id 带 %s 都是 404，逐字相同，无写入、无审计",
    async (_name, body) => {
      await withWorld(async ({ app, db, sandboxRoot, owner, other, temporary, normal }) => {
        const before = state(db, sandboxRoot);

        const responses = {
          foreignTemporary: await promote(app, temporary.id, other, body),
          foreignNormal: await promote(app, normal.id, other, body),
          unknownForOther: await promote(app, UNKNOWN_ID, other, body),
          unknownForOwner: await promote(app, UNKNOWN_ID, owner, body),
          malformedId: await promote(app, "abc", owner, body),
        };

        for (const [name, response] of Object.entries(responses)) {
          expect(wireShape(response), name).toEqual(NOT_FOUND);
        }
        expect(wireShape(responses.foreignTemporary)).toEqual(wireShape(responses.unknownForOther));
        expect(state(db, sandboxRoot)).toEqual(before);
      });
    },
  );

  it("所有者对他人的临时空间同样 404，该空间仍是临时的", async () => {
    await withWorld(async ({ app, db, sandboxRoot, owner, foreignTemporary }) => {
      const before = state(db, sandboxRoot);

      expect(wireShape(await promote(app, foreignTemporary.id, owner))).toEqual(NOT_FOUND);
      expect(state(db, sandboxRoot)).toEqual(before);
      expect(workspaceRow(db, foreignTemporary.id)).toMatchObject({ temporary: 1 });
    });
  });
});

describe("转正路由属于 content-parser 归属集", () => {
  it.each([
    ["malformed JSON", { payload: MALFORMED_JSON }],
    ["an empty JSON body", { payload: "" }],
    ["text/plain", { payload: VALID_BODY, contentType: "text/plain" }],
    ["text/plain that is not JSON", { payload: "x", contentType: "text/plain" }],
    ["an unsupported media type", { payload: "binary", contentType: "application/octet-stream" }],
    ["a body over 16 KiB", { payload: paddedBody("x", BODY_LIMIT + 1) }],
    ["a body over the global limit", { payload: `{"name":"${"x".repeat(1_100_000)}"}` }],
  ] as ReadonlyArray<[string, Body]>)(
    "所有者对自己的临时空间发 %s：exact 400 bad_request 与 no-store，先于任何写入",
    async (_name, body) => {
      await withWorld(async ({ app, db, sandboxRoot, owner, temporary }) => {
        writeFileSync(join(temporary.root, "notes.md"), NOTES);
        const before = state(db, sandboxRoot);

        const response = await promote(app, temporary.id, owner, body);

        expect(wireShape(response)).toEqual(BAD_REQUEST);
        expect(response.payload).not.toContain("FST_ERR");
        expect(state(db, sandboxRoot)).toEqual(before);
        expect(workspaceRow(db, temporary.id)).toMatchObject({ temporary: 1 });
        expect(readFileSync(join(temporary.root, "notes.md")).equals(NOTES)).toBe(true);
      });
    },
  );
});
