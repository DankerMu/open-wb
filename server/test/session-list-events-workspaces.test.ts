/**
 * Issue #934 list event trigger points of the workspace routes (S1f task 6.5): `POST
 * /api/workspaces` and `POST /api/workspaces/:id/promote` on the production createApp assembly with
 * a real listener; each list connection is a real HTTP client whose bytes are read natively.
 *
 * Silence and "everything written so far has arrived" are both proven with the heartbeat: the
 * injected clock writes one comment line per connection, after whatever was written before it.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createWorkspaceStore } from "../src/workspaces/store.js";
import { BAD_REQUEST_ENVELOPE, NOT_FOUND_ENVELOPE } from "./session-db-helpers.js";
import {
  accountOf,
  changed,
  changedSince,
  drainedBy,
  expectOnlyChangedFrames,
  HEARTBEAT_FRAME,
  type ListClient,
  type ListTarget,
  openList,
} from "./session-list-events-helpers.js";
import {
  createRealFakeRuntime,
  openBareSession,
  type SupervisorApp,
  waitFor,
} from "./session-supervisor-helpers.js";
import type { TestClock } from "./support/omp-runtime.js";
import { seedTemporaryWorkspaceSession } from "./support/temporary-workspace.js";

const JSON_TYPE = "application/json";
const CLIENT_HEADER = "x-list-client";
const CONFLICT_ENVELOPE = { error: { code: "conflict", message: "同名资源已存在" } };
const MALFORMED_JSON = '{"name": ';
const OWNER_SESSION = "5".repeat(32);
const OTHER_SESSION = "6".repeat(32);
const UNKNOWN_ID = "e".repeat(32);

interface Account {
  cookie: string;
  id: string;
}

interface Workspace {
  id: string;
  name: string;
}

interface World extends ListTarget {
  fixture: SupervisorApp;
  clock: TestClock;
  zhangsan: Account;
  lisi: Account;
  /** A second store over the same database and sandbox root: only seeds temporary workspaces. */
  store: ReturnType<typeof createWorkspaceStore>;
  /** zhangsan's two list connections and lisi's one. */
  mine: [ListClient, ListClient];
  theirs: ListClient;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function openWorld(): Promise<World> {
  const rt = createRealFakeRuntime();
  // The workspace store wants an existing sandbox root named canonically (macOS tmpdir is a symlink).
  rt.runtime.sandboxRoot = join(realpathSync(dirname(rt.runtime.sandboxRoot)), "sandbox");
  mkdirSync(rt.runtime.sandboxRoot, { recursive: true });
  const { fixture } = await openBareSession(rt.runtime, {
    configureApp(app) {
      // The `throwing` connection's transport fails every write, like a socket that went away.
      app.addHook("onRequest", (request, reply, done) => {
        if (request.headers[CLIENT_HEADER] === "throwing") {
          reply.raw.write = (() => {
            throw new Error("controlled list event writer failure");
          }) as typeof reply.raw.write;
        }
        done();
      });
    },
  });
  const clients: ListClient[] = [];
  cleanups.push(async () => {
    for (const client of clients) {
      client.req.destroy();
    }
    await fixture.close().catch(() => undefined);
  });
  const origin = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
  const target = { origin, clients };
  const zhangsan = await accountOf(fixture.app, "zhangsan");
  const lisi = await accountOf(fixture.app, "lisi");
  expect(lisi.id).not.toBe(zhangsan.id);
  const store = createWorkspaceStore(fixture.db, {
    sandboxRoot: rt.runtime.sandboxRoot,
    ensureSharedDir,
    emit,
  });
  const mine: [ListClient, ListClient] = [
    await openList(target, zhangsan.cookie),
    await openList(target, zhangsan.cookie),
  ];
  const theirs = await openList(target, lisi.cookie);
  return { ...target, fixture, clock: rt.clock, zhangsan, lisi, store, mine, theirs };
}

function post(world: World, url: string, cookie: string, payload: string) {
  return world.fixture.app.inject({
    method: "POST",
    url,
    headers: { "content-type": JSON_TYPE, cookie },
    payload,
  });
}

function create(world: World, name: string, cookie = world.zhangsan.cookie) {
  return post(world, "/api/workspaces", cookie, JSON.stringify({ name }));
}

function promote(world: World, id: string, name: string, cookie = world.zhangsan.cookie) {
  return post(world, `/api/workspaces/${id}/promote`, cookie, JSON.stringify({ name }));
}

async function workspaces(world: World, cookie = world.zhangsan.cookie): Promise<Workspace[]> {
  const response = await world.fixture.app.inject({
    method: "GET",
    url: "/api/workspaces",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ workspaces: Workspace[] }>().workspaces;
}

function all(world: World): ListClient[] {
  return [...world.mine, world.theirs];
}

/**
 * After a committed write of zhangsan: each of his connections has at least one more
 * `sessions.changed` than at its mark; lisi's connection carries nothing but the two sentinels.
 */
async function expectOwnerNotified(world: World, marks: number[], what: string): Promise<void> {
  for (const [index, client] of world.mine.entries()) {
    await changed(client, marks[index] ?? 0, what);
  }
  await drainedBy(world.clock, all(world));
  expect(world.theirs.text().slice(marks[2] ?? 0)).toBe(HEARTBEAT_FRAME);
  for (const client of all(world)) {
    expectOnlyChangedFrames(client);
  }
}

/** A rejected request: one heartbeat later no connection carries anything but that heartbeat. */
async function expectSilent(
  world: World,
  request: () => Promise<LightMyRequestResponse>,
  status: number,
  envelope: object,
): Promise<void> {
  const clients = all(world);
  const marks = await drainedBy(world.clock, clients);
  const response = await request();
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual(envelope);
  await drainedBy(world.clock, clients);
  for (const [index, client] of clients.entries()) {
    expect(changedSince(client, marks[index] ?? 0)).toBe(0);
    expect(client.text().slice(marks[index] ?? 0)).toBe(HEARTBEAT_FRAME);
  }
}

describe("session list events: workspace trigger points", () => {
  it("每个触发点各自通知 — POST /api/workspaces: every connection of the owner gets sessions.changed, the other account none", {
    timeout: 15_000,
  }, async () => {
    const world = await openWorld();
    const marks = await drainedBy(world.clock, all(world));

    const created = await create(world, "项目A");
    expect(created.statusCode).toBe(201);
    const { id } = created.json<Workspace>();

    await expectOwnerNotified(world, marks, "POST /api/workspaces");
    // After the notification the write is readable: the notification followed the commit.
    expect((await workspaces(world)).map((workspace) => workspace.id)).toEqual([id]);
    expect(await workspaces(world, world.lisi.cookie)).toEqual([]);
  });

  it("每个触发点各自通知 — 临时空间转正: sessions.changed after the commit, the promoted workspace is listed", {
    timeout: 15_000,
  }, async () => {
    const world = await openWorld();
    const temporary = seedTemporaryWorkspaceSession(
      world.fixture.db,
      world.store,
      world.zhangsan.id,
      OWNER_SESSION,
    );
    expect(await workspaces(world)).toEqual([]);
    const marks = await drainedBy(world.clock, all(world));

    const promoted = await promote(world, temporary.id, "调研资料");
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json<Workspace>()).toMatchObject({ id: temporary.id, name: "调研资料" });

    await expectOwnerNotified(world, marks, "promote");
    expect(
      (await workspaces(world)).map((workspace) => ({ id: workspace.id, name: workspace.name })),
    ).toEqual([{ id: temporary.id, name: "调研资料" }]);
  });

  it("被拒绝的写入不通知: 409, 400, 404 and malformed bodies on both routes leave every connection silent", async () => {
    const world = await openWorld();
    const formal = (await create(world, "项目A")).json<Workspace>();
    const temporary = seedTemporaryWorkspaceSession(
      world.fixture.db,
      world.store,
      world.zhangsan.id,
      OWNER_SESSION,
    );
    const foreign = seedTemporaryWorkspaceSession(
      world.fixture.db,
      world.store,
      world.lisi.id,
      OTHER_SESSION,
    );
    const before = await workspaces(world);
    expect(before.map((workspace) => workspace.id)).toEqual([formal.id]);
    const { cookie } = world.zhangsan;

    await expectSilent(world, () => create(world, "项目A"), 409, CONFLICT_ENVELOPE);
    await expectSilent(world, () => create(world, ""), 400, BAD_REQUEST_ENVELOPE);
    await expectSilent(
      world,
      () => post(world, "/api/workspaces", cookie, MALFORMED_JSON),
      400,
      BAD_REQUEST_ENVELOPE,
    );
    await expectSilent(
      world,
      () => post(world, "/api/workspaces", cookie, JSON.stringify({ name: "项目B", extra: 1 })),
      400,
      BAD_REQUEST_ENVELOPE,
    );
    // A formal workspace is not temporary: `promote` answers null → 400.
    await expectSilent(
      world,
      () => promote(world, formal.id, "调研资料"),
      400,
      BAD_REQUEST_ENVELOPE,
    );
    await expectSilent(
      world,
      () => promote(world, foreign.id, "调研资料"),
      404,
      NOT_FOUND_ENVELOPE,
    );
    await expectSilent(
      world,
      () => promote(world, UNKNOWN_ID, "调研资料"),
      404,
      NOT_FOUND_ENVELOPE,
    );
    await expectSilent(world, () => promote(world, temporary.id, "项目A"), 409, CONFLICT_ENVELOPE);
    await expectSilent(world, () => promote(world, temporary.id, ""), 400, BAD_REQUEST_ENVELOPE);
    await expectSilent(
      world,
      () => post(world, `/api/workspaces/${temporary.id}/promote`, cookie, MALFORMED_JSON),
      400,
      BAD_REQUEST_ENVELOPE,
    );

    expect(await workspaces(world)).toEqual(before);
    for (const client of all(world)) {
      expectOnlyChangedFrames(client);
    }
  });

  it("一条连接写失败不影响请求: a broken list connection of the owner leaves the POST at 201 and the others notified", {
    timeout: 15_000,
  }, async () => {
    const world = await openWorld();
    const broken = await openList(world, world.zhangsan.cookie, { [CLIENT_HEADER]: "throwing" });
    const marks = await drainedBy(world.clock, world.mine);

    const created = await create(world, "项目A");
    expect(created.statusCode).toBe(201);
    expect(created.json<Workspace>().name).toBe("项目A");

    for (const [index, client] of world.mine.entries()) {
      await changed(client, marks[index] ?? 0, "POST /api/workspaces beside a broken connection");
      expect(client.closed()).toBe(false);
    }
    await waitFor(() => (broken.closed() ? true : undefined), "broken connection closed");
    expect(broken.text()).toBe("");
  });
});
