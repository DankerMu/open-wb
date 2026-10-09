/**
 * Issue #946 (s1f-session-list-temp-space tasks 10.6 + 10.9): the `undo` key of the message view
 * and of the prompt's 202 — message-undo「可撤回状态」(both scenarios), chat-sessions「User messages
 * carry an undo state」, turn-control「分叉共用临时空间且不带快照」(the snapshot half) and the leftover
 * of PR #1191 (building the app creates no `snapshots` directory).
 *
 * The world is prompt-snapshot.test.ts's: production `createApp`, real SQLite, real fake-omp
 * children, real snapshots. Every value is reached the way production reaches it; the only
 * injected thing is a `take` that rejects. Oracles: the spec's literals and SQL read straight from
 * the database.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { ompAgentDir } from "../src/sessions/omp/state-layout.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import {
  accepted,
  closeWorldsAfterEach,
  heldService,
  open,
  put,
  rows,
  send,
  statusOf,
  type World,
} from "./prompt-snapshot-helpers.js";
import { REAL } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { getSessionMessages } from "./session-rest-helpers.js";
import { createRealFakeRuntime, OWNER_ID, waitFor } from "./session-supervisor-helpers.js";
import { seedUnboundSession } from "./support/temporary-workspace.js";

/** The message view's keys, in the order chat-sessions「User messages carry an undo state」gives. */
const MESSAGE_KEYS = [
  "id",
  "role",
  "content",
  "thinking",
  "status",
  "createdAt",
  "approvals",
  "undo",
  "attachments",
  "steps",
];

interface Viewed {
  id: number;
  role: string;
  status: string;
  undo: string | null;
}

closeWorldsAfterEach();

/** The session's messages as the history route serves them, each with exactly `MESSAGE_KEYS`. */
async function viewed(world: World, session = world.session): Promise<Viewed[]> {
  const response = await getSessionMessages(world.fixture.app, session, world.cookie);
  expect(response.statusCode).toBe(200);
  const { messages } = response.json() as { messages: Viewed[] };
  for (const message of messages) {
    expect(Object.keys(message)).toEqual(MESSAGE_KEYS);
  }
  return messages;
}

/** `[role, undo]` of every message, in history order. */
async function undoOf(world: World, session = world.session): Promise<Array<[string, unknown]>> {
  return (await viewed(world, session)).map((message) => [message.role, message.undo]);
}

/** One whole turn; returns the 202's `[userMessageId, undo]`. */
async function turnUndo(
  world: World,
  message: string,
  session = world.session,
  status = "done",
): Promise<[number, string]> {
  const body = accepted(await send(world, message, session));
  await waitFor(() => (statusOf(world, session) === status ? true : undefined), `turn ${status}`);
  return [body.userMessageId, body.undo];
}

/** A turn written through the store alone, as one accepted before this change: no registration. */
function legacyTurn(world: World, text: string, session = world.session): void {
  const { store } = world.fixture;
  store.finishTurn(store.acceptPrompt(session, OWNER_ID, text).assistantMessageId, "done");
}

function installSkill(world: World, name: string): void {
  const dir = join(ompAgentDir(world.rt.runtime.stateDir), "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n正文\n`);
}

/** How many registration rows point at a message of `session`. */
function registrationsOf(world: World, session: string): number {
  const row = world.db
    .prepare(
      "SELECT count(*) AS n FROM chat_turn_snapshots AS t JOIN chat_messages AS m ON m.id = t.message_id WHERE m.session_id = ?",
    )
    .get(session) as { n: number };
  return Number(row.n);
}

describe("message-undo 可撤回状态 (#946)", () => {
  it(
    "各取值: available, command (/todo and /skill:…), too_large, failed and unbound in the 202, and the same values in the history, with null on every assistant message",
    REAL,
    async () => {
      const refused = new Error("take refused");
      const failing = { on: false };
      const world = await open({
        scenario: "slash",
        settings: { snapshotMaxTotalBytes: 16 },
        service: (real) => ({
          ...real,
          take: (...args) => (failing.on ? Promise.reject(refused) : real.take(...args)),
        }),
      });
      put(world, "a.txt", "1");
      installSkill(world, "weekly-report");

      const plain = await turnUndo(world, "an ordinary prompt");
      const todo = await turnUndo(world, "/todo");
      const skill = await turnUndo(world, "/skill:weekly-report 写周报");
      put(world, "big.txt", "x".repeat(17));
      const large = await turnUndo(world, "over the total limit");
      rmSync(join(world.root, "big.txt"));
      failing.on = true;
      const failed = await turnUndo(world, "take is refused");
      const legacy = seedUnboundSession(world.db, OWNER_ID, "7".repeat(32));
      const unbound = await turnUndo(world, "no workspace", legacy);

      const sent = [plain, todo, skill, large, failed];
      expect([...sent, unbound].map(([, undo]) => undo)).toEqual([
        "available",
        "command",
        "command",
        "too_large",
        "failed",
        "unbound",
      ]);
      const bound = await viewed(world);
      expect(bound.map((message) => message.role)).toEqual(
        sent.flatMap(() => ["user", "assistant"]),
      );
      expect(
        bound.filter((message) => message.role === "user").map(({ id, undo }) => [id, undo]),
      ).toEqual(sent);
      expect(
        bound.filter((message) => message.role === "assistant").map((message) => message.undo),
      ).toEqual(sent.map(() => null));
      expect(await undoOf(world, legacy)).toEqual([
        ["user", unbound[1]],
        ["assistant", null],
      ]);
      expect(world.errors).toEqual([refused]);
    },
  );

  it(
    "User messages carry an undo state: one turn on a body-less created session reads available on the user message and null on the assistant, with exactly the ten keys in order",
    REAL,
    async () => {
      const world = await open();

      const [id, undo] = await turnUndo(world, "hello");

      expect(undo).toBe("available");
      const messages = await viewed(world);
      expect(messages.map(({ id: at, role, undo: state }) => [at, role, state])).toEqual([
        [id, "user", "available"],
        [expect.any(Number), "assistant", null],
      ]);
    },
  );

  it(
    "分叉拷贝与存量消息: the messages a fork copied read none and have no registration row, a prompt sent in the new session is available again, and the source is unchanged",
    REAL,
    async () => {
      const world = await open({ scenario: "branch" });
      put(world, "a.txt", "1");
      // The fake's `branch` list is these two texts; fork finds its entry by them.
      await turnUndo(world, "first question");
      const [second] = await turnUndo(world, "second question");
      const source = await undoOf(world);
      expect(source).toEqual([
        ["user", "available"],
        ["assistant", null],
        ["user", "available"],
        ["assistant", null],
      ]);
      const before = rows(world.db);
      const ownerRoot = join(world.rt.runtime.sandboxRoot, OWNER_ID);
      const directories = readdirSync(ownerRoot).sort();

      const response = await postSessionAction(
        world.fixture.app,
        "fork",
        world.session,
        world.cookie,
        {
          name: "fork body",
          payload: JSON.stringify({ messageId: second }),
          contentType: "application/json",
        },
      );

      expect(response.statusCode).toBe(201);
      const forked = (response.json() as { session: Record<string, unknown> }).session;
      const copy = String(forked.id);
      expect([forked.workspaceId, forked.temporaryWorkspace]).toEqual([world.workspaceId, true]);
      expect(readdirSync(ownerRoot).sort()).toEqual(directories);
      expect(await undoOf(world, copy)).toEqual([
        ["user", "none"],
        ["assistant", null],
      ]);
      expect(registrationsOf(world, copy)).toBe(0);
      expect(rows(world.db)).toEqual(before);

      const [, fresh] = await turnUndo(world, "asked in the fork", copy);
      expect(fresh).toBe("available");
      expect(await undoOf(world, copy)).toEqual([
        ["user", "none"],
        ["assistant", null],
        ["user", "available"],
        ["assistant", null],
      ]);
      expect(registrationsOf(world, copy)).toBe(1);
      expect(await undoOf(world)).toEqual(source);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "分叉拷贝与存量消息: on a bound session the messages accepted before this change read none, beside a new one that reads available",
    REAL,
    async () => {
      const world = await open();
      legacyTurn(world, "第一轮");
      legacyTurn(world, "第二轮");

      const [, undo] = await turnUndo(world, "after the upgrade");

      expect(undo).toBe("available");
      expect(await undoOf(world)).toEqual([
        ["user", "none"],
        ["assistant", null],
        ["user", "none"],
        ["assistant", null],
        ["user", "available"],
        ["assistant", null],
      ]);
    },
  );

  it(
    "a legacy unbound session reads unbound on every user message, old and new",
    REAL,
    async () => {
      const world = await open();
      const legacy = seedUnboundSession(world.db, OWNER_ID, "7".repeat(32));
      legacyTurn(world, "第一轮", legacy);

      const [, undo] = await turnUndo(world, "after the upgrade", legacy);

      expect(undo).toBe("unbound");
      expect(await undoOf(world, legacy)).toEqual([
        ["user", "unbound"],
        ["assistant", null],
        ["user", "unbound"],
        ["assistant", null],
      ]);
      expect(rows(world.db)).toEqual([]);
    },
  );

  it(
    "a registration row that could not be written reads none, in the 202 and in the history",
    REAL,
    async () => {
      const world = await open();
      put(world, "a.txt", "1");
      world.db.exec(
        "CREATE TEMP TRIGGER refuse_registration BEFORE INSERT ON chat_turn_snapshots BEGIN SELECT RAISE(ABORT, 'registration refused'); END",
      );

      const [, undo] = await turnUndo(world, "carry on");

      expect(undo).toBe("none");
      expect(await undoOf(world)).toEqual([
        ["user", "none"],
        ["assistant", null],
      ]);
      expect(world.errors.map((error) => error.message)).toEqual(["registration refused"]);
    },
  );

  it(
    "a stopped turn follows its registration row, not the turn's status: available",
    REAL,
    async () => {
      const held = heldService();
      const world = await open({ scenario: "abort-ok", service: held.service });
      put(world, "a.txt", "1");

      const prompting = send(world, "stop me during the snapshot");
      await held.entered;
      const stopped = await postSessionAction(
        world.fixture.app,
        "stop",
        world.session,
        world.cookie,
      );
      expect(stopped.statusCode).toBe(202);
      held.release();
      const body = accepted(await prompting);
      await waitFor(() => (statusOf(world) === "stopped" ? true : undefined), "the stopped turn");

      expect(body.undo).toBe("available");
      expect((await viewed(world)).map(({ role, status, undo }) => [role, status, undo])).toEqual([
        ["user", "done", "available"],
        ["assistant", "stopped", null],
      ]);
    },
  );

  it(
    "regenerate changes no undo value and leaves the number of registration rows unchanged",
    REAL,
    async () => {
      const world = await open({ scenario: "branch" });
      put(world, "a.txt", "1");
      // The fake's `branch` list ends with this text; regenerate looks the user message up by it.
      await turnUndo(world, "second question");
      const before = await viewed(world);
      expect(before.map(({ role, undo }) => [role, undo])).toEqual([
        ["user", "available"],
        ["assistant", null],
      ]);
      expect(rows(world.db)).toHaveLength(1);

      const response = await postSessionAction(
        world.fixture.app,
        "regenerate",
        world.session,
        world.cookie,
      );
      expect(response.statusCode).toBe(202);
      const { assistantMessageId } = response.json() as { assistantMessageId: number };
      await waitFor(() => (statusOf(world) === "done" ? true : undefined), "the regenerated turn");

      const after = await viewed(world);
      // The answer is a new message; the user message and its undo value are the same.
      expect(after.map(({ id, role, undo }) => [id, role, undo])).toEqual([
        [before[0]?.id, "user", "available"],
        [assistantMessageId, "assistant", null],
      ]);
      expect(assistantMessageId).not.toBe(before[1]?.id);
      expect(rows(world.db)).toHaveLength(1);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("http-service-skeleton Shared agent module assembly: building touches no disk (#946)", () => {
  it("createApp on a state dir nobody laid out creates no snapshots directory", async () => {
    const rt = createRealFakeRuntime();
    // Not the runtime's own state dir: that one was laid out when the runtime was made.
    const stateDir = mkdtempSync(join(tmpdir(), "open-wb-946-state-"));
    const db = openDb(":memory:");
    const app = createApp({
      db,
      authRuntime: fixedRuntime(() => FIXED_NOW),
      assembly: {
        tokens: new TokenRegistry(),
        runtime: { ...rt.runtime, stateDir },
        onError: () => {},
      },
    });
    try {
      await app.ready();
      expect(existsSync(join(stateDir, "snapshots"))).toBe(false);
    } finally {
      await app.close();
      db.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
