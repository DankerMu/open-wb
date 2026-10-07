/**
 * Issue #942 snapshot-registration rows at the unit seam: `store-undo.ts` over real SQLite with every
 * migration applied (workspace-snapshots「受理时做快照」for the `skipped` shape and the stored
 * `todo`,「迁移 039 回合快照登记表」Scenario「级联」as seen through the module's readers). Oracles are
 * the module's return values and the raw `chat_turn_snapshots` / `chat_sessions` columns; expected
 * values are literals written here, not derived from the module.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import {
  insertTurnSnapshot,
  latestOkTurnSnapshot,
  listSessionTurnSnapshots,
  readTurnSnapshot,
  type SkippedPath,
  type TurnSnapshotOutcome,
} from "../src/sessions/store-undo.js";
import {
  S_A,
  S_B,
  S_C,
  seedPopulated035,
  W_MISSING,
  W_U1,
  W_U1_SPARE,
  W_U2,
} from "./core-db-session-fixture.js";

const NOW = 1_760_000_000_000;
const OUTCOMES: TurnSnapshotOutcome[] = ["ok", "too_large", "failed", "command"];
const THREE_SKIPPED: SkippedPath[] = [
  { path: "node_modules", reason: "excluded" },
  { path: "数据/大文件.bin", reason: "too_large" },
  { path: "locked", reason: "unreadable" },
];
const THREE_SKIPPED_TEXT =
  '{"count":3,"paths":[{"path":"node_modules","reason":"excluded"},{"path":"数据/大文件.bin","reason":"too_large"},{"path":"locked","reason":"unreadable"}]}';
/**
 * A task list as an out-of-band writer could have left it: interior spaces, a `é` escape, an
 * escaped solidus, a raw non-BMP character and a key order `JSON.stringify` would not produce.
 * Parsing and re-serialising it yields different bytes.
 */
const TODO_RAW = String.raw`{ "phases":[{"tasks":[{"status":"pending","content":"café \/ 读取需求 🧠"}],"name":"准备"}] }`;
const opened: DatabaseSync[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) {
    db.close();
  }
});

/** Fixture sessions: S_A (u1) is bound to W_U1, S_C (u2) to W_U2, S_B (u1) is unbound. */
function open(): DatabaseSync {
  const db = openDb(":memory:");
  opened.push(db);
  seedPopulated035(db);
  return db;
}

function userMessage(db: DatabaseSync, sessionId: string, createdAt: number): number {
  const receipt = db
    .prepare(
      "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'user', 'q', 'done', ?)",
    )
    .run(sessionId, createdAt);
  return Number(receipt.lastInsertRowid);
}

function write(
  db: DatabaseSync,
  messageId: number,
  workspaceId: string,
  outcome: TurnSnapshotOutcome,
  createdAt = NOW,
): void {
  insertTurnSnapshot(db, { messageId, workspaceId, outcome, skipped: [], todo: null, createdAt });
}

function rawColumn(db: DatabaseSync, column: "skipped" | "todo", messageId: number): unknown {
  return db
    .prepare(`SELECT ${column} AS value FROM chat_turn_snapshots WHERE message_id = ?`)
    .get(messageId)?.value;
}

function manySkipped(total: number): SkippedPath[] {
  return Array.from({ length: total }, (_unused, index) => ({
    path: `dir/f${index}`,
    reason: index % 2 === 0 ? "too_large" : "special",
  }));
}

describe("turn snapshot registration rows", () => {
  it.each(OUTCOMES)("outcome %s round-trips with every column", (outcome) => {
    const db = open();
    const messageId = userMessage(db, S_A, 10);
    insertTurnSnapshot(db, {
      messageId,
      workspaceId: W_U1,
      outcome,
      skipped: [],
      todo: null,
      createdAt: NOW,
    });
    expect(readTurnSnapshot(db, messageId)).toEqual({
      messageId,
      workspaceId: W_U1,
      outcome,
      skipped: null,
      todo: null,
      createdAt: NOW,
    });
    expect(
      db.prepare("SELECT * FROM chat_turn_snapshots WHERE message_id = ?").get(messageId),
    ).toEqual({
      message_id: messageId,
      workspace_id: W_U1,
      outcome,
      skipped: null,
      todo: null,
      created_at: NOW,
    });
  });

  it("reads undefined for a message without a row", () => {
    const db = open();
    expect(readTurnSnapshot(db, 1)).toBeUndefined();
    expect(readTurnSnapshot(db, 999)).toBeUndefined();
  });

  it("a second write for the same message throws and leaves the first row", () => {
    const db = open();
    write(db, 1, W_U1, "ok", 5);
    expect(() => write(db, 1, W_U1, "failed", 6)).toThrow(
      /UNIQUE constraint failed: chat_turn_snapshots\.message_id/,
    );
    expect(readTurnSnapshot(db, 1)).toMatchObject({ outcome: "ok", createdAt: 5 });
  });

  it("a write naming a missing message or workspace throws and stores nothing", () => {
    const db = open();
    expect(() => write(db, 999, W_U1, "ok")).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => write(db, 1, W_MISSING, "ok")).toThrow(/FOREIGN KEY constraint failed/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_turn_snapshots").get()).toEqual({ n: 0 });
  });
});

describe("turn snapshot skipped list", () => {
  it("an empty list is stored as NULL", () => {
    const db = open();
    write(db, 1, W_U1, "ok");
    expect(rawColumn(db, "skipped", 1)).toBeNull();
    expect(readTurnSnapshot(db, 1)?.skipped).toBeNull();
  });

  it("three items are stored whole as {count, paths}", () => {
    const db = open();
    insertTurnSnapshot(db, {
      messageId: 1,
      workspaceId: W_U1,
      outcome: "ok",
      skipped: THREE_SKIPPED,
      todo: null,
      createdAt: NOW,
    });
    expect(rawColumn(db, "skipped", 1)).toBe(THREE_SKIPPED_TEXT);
    expect(readTurnSnapshot(db, 1)?.skipped).toEqual({ count: 3, paths: THREE_SKIPPED });
  });

  it("exactly 200 items are stored whole", () => {
    const db = open();
    const skipped = manySkipped(200);
    insertTurnSnapshot(db, {
      messageId: 1,
      workspaceId: W_U1,
      outcome: "ok",
      skipped,
      todo: null,
      createdAt: NOW,
    });
    const read = readTurnSnapshot(db, 1)?.skipped;
    expect(read?.count).toBe(200);
    expect(read?.paths).toHaveLength(200);
    expect(read?.paths[199]).toEqual({ path: "dir/f199", reason: "special" });
  });

  it.each([201, 500])("%i items keep the total in count and the first 200 in order", (total) => {
    const db = open();
    const skipped = manySkipped(total);
    insertTurnSnapshot(db, {
      messageId: 1,
      workspaceId: W_U1,
      outcome: "ok",
      skipped,
      todo: null,
      createdAt: NOW,
    });

    const stored = String(rawColumn(db, "skipped", 1));
    expect(
      stored.startsWith(`{"count":${total},"paths":[{"path":"dir/f0","reason":"too_large"},`),
    ).toBe(true);
    const parsed = JSON.parse(stored) as { count: number; paths: SkippedPath[] };
    expect(Object.keys(parsed)).toEqual(["count", "paths"]);
    expect(parsed.count).toBe(total);
    expect(parsed.paths).toHaveLength(200);
    expect(parsed.paths.map((entry) => entry.path)).toEqual(
      Array.from({ length: 200 }, (_unused, index) => `dir/f${index}`),
    );
    expect(parsed.paths[199]).toEqual({ path: "dir/f199", reason: "special" });
    expect(readTurnSnapshot(db, 1)?.skipped).toEqual(parsed);
    // The caller's list is not truncated in place.
    expect(skipped).toHaveLength(total);
  });

  it("only path and reason of each item are stored", () => {
    const db = open();
    // What `take` hands over may carry more than the two keys (structurally still a SkippedPath).
    const entry = { path: "a", reason: "special", size: 9 };
    const skipped: SkippedPath[] = [entry];
    insertTurnSnapshot(db, {
      messageId: 1,
      workspaceId: W_U1,
      outcome: "ok",
      skipped,
      todo: null,
      createdAt: NOW,
    });
    expect(rawColumn(db, "skipped", 1)).toBe(
      '{"count":1,"paths":[{"path":"a","reason":"special"}]}',
    );
  });

  it.each([
    ["text that is not JSON", "{"],
    ["a JSON value of another shape", '{"count":"1","paths":[]}'],
    ["an item without a reason", '{"count":1,"paths":[{"path":"a"}]}'],
    ["an item that is not an object", '{"count":1,"paths":[7]}'],
    ["a JSON array", "[]"],
  ])("a stored skipped column holding %s reads null instead of throwing", (_name, text) => {
    const db = open();
    write(db, 1, W_U1, "ok");
    db.prepare("UPDATE chat_turn_snapshots SET skipped = ? WHERE message_id = 1").run(text);
    expect(readTurnSnapshot(db, 1)).toMatchObject({ messageId: 1, outcome: "ok", skipped: null });
  });
});

describe("turn snapshot todo", () => {
  function sessionTodo(db: DatabaseSync, sessionId: string): string | null {
    const row = db.prepare("SELECT todo FROM chat_sessions WHERE id = ?").get(sessionId);
    return row?.todo as string | null;
  }
  const hex = (db: DatabaseSync, sql: string, key: string | number) =>
    db.prepare(sql).get(key)?.hex;

  it("a NULL session todo is stored and read as NULL", () => {
    const db = open();
    expect(sessionTodo(db, S_A)).toBeNull();
    insertTurnSnapshot(db, {
      messageId: 1,
      workspaceId: W_U1,
      outcome: "ok",
      skipped: [],
      todo: sessionTodo(db, S_A),
      createdAt: NOW,
    });
    expect(rawColumn(db, "todo", 1)).toBeNull();
    expect(readTurnSnapshot(db, 1)?.todo).toBeNull();
  });

  it("the stored todo is byte-for-byte the text chat_sessions.todo holds", () => {
    const db = open();
    db.prepare("UPDATE chat_sessions SET todo = ? WHERE id = ?").run(TODO_RAW, S_A);
    // The fixture text is one a parse → stringify round trip would rewrite.
    expect(JSON.stringify(JSON.parse(TODO_RAW))).not.toBe(TODO_RAW);

    insertTurnSnapshot(db, {
      messageId: 1,
      workspaceId: W_U1,
      outcome: "ok",
      skipped: [],
      todo: sessionTodo(db, S_A),
      createdAt: NOW,
    });

    const expected = Buffer.from(TODO_RAW, "utf8").toString("hex").toUpperCase();
    expect(hex(db, "SELECT hex(todo) AS hex FROM chat_sessions WHERE id = ?", S_A)).toBe(expected);
    expect(
      hex(db, "SELECT hex(todo) AS hex FROM chat_turn_snapshots WHERE message_id = ?", 1),
    ).toBe(expected);
    expect(readTurnSnapshot(db, 1)?.todo).toBe(TODO_RAW);
    expect(listSessionTurnSnapshots(db, S_A).map((row) => row.todo)).toEqual([TODO_RAW]);
    expect(latestOkTurnSnapshot(db, W_U1)?.todo).toBe(TODO_RAW);
  });

  it("an empty-string todo stays an empty string, not NULL", () => {
    const db = open();
    insertTurnSnapshot(db, {
      messageId: 1,
      workspaceId: W_U1,
      outcome: "ok",
      skipped: [],
      todo: "",
      createdAt: NOW,
    });
    expect(rawColumn(db, "todo", 1)).toBe("");
    expect(readTurnSnapshot(db, 1)?.todo).toBe("");
  });
});

describe("latest ok turn snapshot of a workspace", () => {
  it("is the ok row with the highest message id, whatever the timestamps say", () => {
    const db = open();
    const first = userMessage(db, S_A, 10);
    const second = userMessage(db, S_A, 11);
    const third = userMessage(db, S_B, 12);
    const failed = userMessage(db, S_A, 13);
    const command = userMessage(db, S_A, 14);
    const other = userMessage(db, S_C, 15);
    expect([first, second, third, failed, command, other]).toEqual([8, 9, 10, 11, 12, 13]);
    // Two sessions share W_U1. The newest ok row carries the oldest created_at; the two before
    // it tie on created_at.
    write(db, first, W_U1, "ok", 500);
    write(db, second, W_U1, "ok", 500);
    write(db, third, W_U1, "ok", 400);
    write(db, failed, W_U1, "failed", 900);
    write(db, command, W_U1, "command", 901);
    write(db, other, W_U2, "ok", 902);

    expect(latestOkTurnSnapshot(db, W_U1)).toEqual({
      messageId: third,
      workspaceId: W_U1,
      outcome: "ok",
      skipped: null,
      todo: null,
      createdAt: 400,
    });
    expect(latestOkTurnSnapshot(db, W_U2)?.messageId).toBe(other);
  });

  it("is undefined for a workspace with no ok row", () => {
    const db = open();
    write(db, 1, W_U1, "too_large");
    write(db, 2, W_U1, "failed");
    write(db, 3, W_U1, "command");
    write(db, 5, W_U2, "ok");
    expect(latestOkTurnSnapshot(db, W_U1)).toBeUndefined();
    expect(latestOkTurnSnapshot(db, W_U1_SPARE)).toBeUndefined();
    expect(latestOkTurnSnapshot(db, W_MISSING)).toBeUndefined();
  });
});

describe("turn snapshots of a session", () => {
  it("lists that session's rows in history order: message created_at, then id", () => {
    const db = open();
    const late = userMessage(db, S_A, 60);
    const early = userMessage(db, S_A, 40);
    const tieLow = userMessage(db, S_A, 50);
    const tieHigh = userMessage(db, S_A, 50);
    const unregistered = userMessage(db, S_A, 55);
    const foreign = userMessage(db, S_C, 45);
    write(db, tieHigh, W_U1, "command", 1);
    write(db, late, W_U1, "ok", 2);
    write(db, tieLow, W_U1, "failed", 3);
    write(db, early, W_U1_SPARE, "too_large", 4);
    write(db, foreign, W_U2, "ok", 5);

    expect(listSessionTurnSnapshots(db, S_A)).toEqual([
      {
        messageId: early,
        workspaceId: W_U1_SPARE,
        outcome: "too_large",
        skipped: null,
        todo: null,
        createdAt: 4,
      },
      {
        messageId: tieLow,
        workspaceId: W_U1,
        outcome: "failed",
        skipped: null,
        todo: null,
        createdAt: 3,
      },
      {
        messageId: tieHigh,
        workspaceId: W_U1,
        outcome: "command",
        skipped: null,
        todo: null,
        createdAt: 1,
      },
      {
        messageId: late,
        workspaceId: W_U1,
        outcome: "ok",
        skipped: null,
        todo: null,
        createdAt: 2,
      },
    ]);
    expect(listSessionTurnSnapshots(db, S_C).map((row) => row.messageId)).toEqual([foreign]);
    expect(listSessionTurnSnapshots(db, S_B)).toEqual([]);
    expect(readTurnSnapshot(db, unregistered)).toBeUndefined();
  });
});

describe("turn snapshot rows follow their message, session and workspace", () => {
  /** S_A: messages 1 and a new one on W_U1; S_C: message 5 on W_U2. All `ok`. */
  function seeded(): { db: DatabaseSync; second: number } {
    const db = open();
    const second = userMessage(db, S_A, 20);
    write(db, 1, W_U1, "ok");
    write(db, second, W_U1, "ok");
    write(db, 5, W_U2, "ok");
    return { db, second };
  }
  const ids = (db: DatabaseSync, sessionId: string) =>
    listSessionTurnSnapshots(db, sessionId).map((row) => row.messageId);

  it("deleting a message drops its row from every reader", () => {
    const { db, second } = seeded();
    db.prepare("DELETE FROM chat_messages WHERE id = ?").run(second);
    expect(readTurnSnapshot(db, second)).toBeUndefined();
    expect(ids(db, S_A)).toEqual([1]);
    expect(latestOkTurnSnapshot(db, W_U1)?.messageId).toBe(1);
    expect(ids(db, S_C)).toEqual([5]);
  });

  it("deleting a session drops its rows and keeps another session's", () => {
    const { db, second } = seeded();
    db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(S_A);
    expect(readTurnSnapshot(db, 1)).toBeUndefined();
    expect(readTurnSnapshot(db, second)).toBeUndefined();
    expect(ids(db, S_A)).toEqual([]);
    expect(latestOkTurnSnapshot(db, W_U1)).toBeUndefined();
    expect(ids(db, S_C)).toEqual([5]);
    expect(latestOkTurnSnapshot(db, W_U2)?.messageId).toBe(5);
  });

  it("deleting a workspace drops its rows and keeps another workspace's", () => {
    const { db, second } = seeded();
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(W_U1);
    expect(readTurnSnapshot(db, 1)).toBeUndefined();
    expect(readTurnSnapshot(db, second)).toBeUndefined();
    expect(ids(db, S_A)).toEqual([]);
    expect(latestOkTurnSnapshot(db, W_U1)).toBeUndefined();
    expect(readTurnSnapshot(db, 5)?.workspaceId).toBe(W_U2);
    expect(latestOkTurnSnapshot(db, W_U2)?.messageId).toBe(5);
  });
});
