/**
 * Issue #864 task list across fork and regenerate (session-todo「分叉为空、重新生成与终态不清空」,
 * chat-sessions fork/regenerate): real fake-omp `branch` children over the REST routes on the
 * production assembly. The source's list T is written straight into `chat_sessions.todo`; oracles
 * are that raw column and the snapshot route.
 */
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { REAL } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { forkWorlds, messagesOf, openForkWorld, seedTwoTurns } from "./session-fork-helpers.js";
import { answered, openRegenWorld } from "./session-regenerate-helpers.js";
import { getSessionMessages } from "./session-rest-helpers.js";
import { type RecordingWorld, waitForTurn } from "./session-supervisor-helpers.js";

const T = {
  phases: [{ name: "准备", tasks: [{ content: "读取需求", status: "in_progress" }] }],
};
const T_TEXT =
  '{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"in_progress"}]}]}';

const worlds = forkWorlds();

function storeList(db: DatabaseSync, session: string): void {
  db.prepare("UPDATE chat_sessions SET todo = ? WHERE id = ?").run(T_TEXT, session);
}

function todoColumn(db: DatabaseSync, session: string): unknown {
  return db.prepare("SELECT todo FROM chat_sessions WHERE id = ?").get(session)?.todo;
}

async function snapshotTodo(world: RecordingWorld, session: string): Promise<unknown> {
  const response = await getSessionMessages(world.fixture.app, session, world.cookie);
  expect(response.statusCode).toBe(200);
  const body = response.json() as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["session", "messages", "streamCursor", "todo"]);
  return body.todo;
}

describe("fork", () => {
  it("the new session has no list; the source keeps its own", REAL, async () => {
    const world = worlds.track(await openForkWorld());
    const { db, app } = world.fixture;
    const seeded = seedTwoTurns(world);
    storeList(db, world.session);

    const response = await postSessionAction(app, "fork", world.session, world.cookie, {
      name: "fork body",
      payload: JSON.stringify({ messageId: seeded.u2 }),
      contentType: "application/json",
    });

    expect(response.statusCode).toBe(201);
    const fresh = (response.json() as { session: Record<string, unknown> }).session;
    expect(Object.keys(fresh)).not.toContain("todo");
    const forked = String(fresh.id);
    expect(messagesOf(db, forked).length).toBeGreaterThan(0);
    expect(todoColumn(db, forked)).toBeNull();
    expect(await snapshotTodo(world, forked)).toBeNull();
    expect(todoColumn(db, world.session)).toBe(T_TEXT);
    expect(await snapshotTodo(world, world.session)).toEqual(T);
  });
});

describe("regenerate", () => {
  it("the regenerated turn leaves the stored list in place", REAL, async () => {
    const world = worlds.track(await openRegenWorld());
    const { db, app } = world.fixture;
    await answered(world);
    storeList(db, world.session);

    const response = await postSessionAction(app, "regenerate", world.session, world.cookie);

    expect(response.statusCode).toBe(202);
    expect(todoColumn(db, world.session)).toBe(T_TEXT);
    await waitForTurn(world.fixture, world.session, "done");
    expect(todoColumn(db, world.session)).toBe(T_TEXT);
    expect(await snapshotTodo(world, world.session)).toEqual(T);
  });
});
