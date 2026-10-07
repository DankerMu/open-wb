/**
 * Issue #949 the undo transaction at the unit seam: `commitUndo` of `store-undo.ts` over real SQLite
 * with every migration applied (message-undo「对话原地回退」step 5 and Scenarios「剩余历史的状态」
 * 「任务清单回到当时」「最终事务复核失败」;「撤回审计与通知」Scenarios「审计形状」「审计失败则不回退」;
 * session-todo Scenario「快照步骤只读、撤回写回」). Oracles are raw `SELECT *` dumps of every `chat_*`
 * table and `audit_events`; expected values are literals written here.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { openDb } from "../src/core/db/index.js";
import { commitUndo, insertTurnSnapshot, type UndoCommit } from "../src/sessions/store-undo.js";
import { S_A, seedPopulated035, W_U1, W_U1_SPARE } from "./core-db-session-fixture.js";
import { expectHttpError } from "./session-store-helpers.js";

const NOW = 1_760_000_000_000;
const S = "e".repeat(32);
const NEW_FILE = "/sessions/after-branch.jsonl";
/** Not what `JSON.stringify` would produce: a parse and re-serialise changes the bytes. */
const T1 = String.raw`{ "phases":[{"tasks":[{"status":"pending","content":"café \/ 读取 🧠"}],"name":"准备"}] }`;
const T2 = '{"phases":[{"name":"后来","tasks":[]}]}';
const TABLES = [
  ["chat_sessions", "id"],
  ["chat_messages", "id"],
  ["chat_steps", "id"],
  ["chat_approvals", "id"],
  ["chat_turn_snapshots", "message_id"],
  ["audit_events", "id"],
] as const;
type Table = (typeof TABLES)[number][0];
type Row = Record<string, unknown>;
type Dump = Record<Table, Row[]>;
type AssistantStatus = "done" | "failed" | "stopped";

const opened: DatabaseSync[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) {
    db.close();
  }
});

function dump(db: DatabaseSync): Dump {
  const all = {} as Dump;
  for (const [table, key] of TABLES) {
    all[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all() as Row[];
  }
  return all;
}

function message(db: DatabaseSync, role: string, status: string, createdAt: number): number {
  return Number(
    db
      .prepare(
        "INSERT INTO chat_messages(session_id, role, content, status, created_at, thinking) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(S, role, `${role} at ${createdAt} ✓`, status, createdAt, role === "user" ? null : "想")
      .lastInsertRowid,
  );
}

function stepAndApproval(db: DatabaseSync, messageId: number): void {
  db.prepare(
    "INSERT INTO chat_steps(message_id, ordinal, name, detail, output, status, started_at, ended_at) VALUES (?, 0, 'bash', '{\"cmd\":\"ls\"}', 'a\nb', 'done', 1, 2)",
  ).run(messageId);
  db.prepare(
    "INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at, decision, decided_at) VALUES (?, ?, 'bash', 'run ls', 3, 60003, 'allow', 4)",
  ).run(messageId, `r-${messageId}`);
}

interface History {
  db: DatabaseSync;
  u1: number;
  a1: number;
  u2: number;
  a2: number;
  u3: number;
  a3: number;
  input: UndoCommit;
}

/**
 * Session S of u1, bound to W_U1_SPARE, `done`, task list T2: u1→a1→u2→a2→u3→a3, every assistant
 * with a step and an `allow` approval; registrations u1 `ok`, u2 `ok` (task list `todoAtU2`), u3
 * `too_large`. The fixture's own sessions (S_A … S_D, with steps and approvals) are the bystanders.
 */
function history(
  options: { a1?: AssistantStatus; todoAtU2?: string | null; times?: number[] } = {},
): History {
  const db = openDb(":memory:");
  opened.push(db);
  seedPopulated035(db);
  db.prepare(
    "INSERT INTO chat_sessions(id, owner_id, title, status, omp_session_file, stream_epoch, created_at, updated_at, parent_session_id, workspace_id, scene, pinned_at, todo) VALUES (?, 'u1', '标题 🚀', 'done', '/sessions/old.jsonl', 4, 1000, 2000, ?, ?, 'code', 1500, ?)",
  ).run(S, S_A, W_U1_SPARE, T2);
  const [t1, t2, t3, t4, t5, t6] = options.times ?? [10, 20, 30, 40, 50, 60];
  const u1 = message(db, "user", "done", t1 as number);
  const a1 = message(db, "assistant", options.a1 ?? "done", t2 as number);
  const u2 = message(db, "user", "done", t3 as number);
  const a2 = message(db, "assistant", "failed", t4 as number);
  const u3 = message(db, "user", "done", t5 as number);
  const a3 = message(db, "assistant", "done", t6 as number);
  for (const id of [a1, a2, a3]) {
    stepAndApproval(db, id);
  }
  const base = { workspaceId: W_U1_SPARE, skipped: [], createdAt: 7 };
  insertTurnSnapshot(db, { ...base, messageId: u1, outcome: "ok", todo: null });
  insertTurnSnapshot(db, {
    ...base,
    messageId: u2,
    outcome: "ok",
    todo: options.todoAtU2 === undefined ? T1 : options.todoAtU2,
  });
  insertTurnSnapshot(db, {
    ...base,
    messageId: u3,
    outcome: "too_large",
    todo: T2,
  });
  const input: UndoCommit = {
    ownerId: "u1",
    sessionId: S,
    messageId: u2,
    expectedLastAssistantId: a3,
    ompSessionFile: NEW_FILE,
    files: "force",
    now: NOW,
  };
  return { db, u1, a1, u2, a2, u3, a3, input };
}

/** `before` minus the rows of the removed messages, the session row and the audit table left out. */
function expectOnlyRemoved(before: Dump, after: Dump, removed: number[]): void {
  const kept = (rows: Row[], key: string) =>
    rows.filter((row) => !removed.includes(row[key] as number));
  expect(after.chat_messages).toEqual(kept(before.chat_messages, "id"));
  expect(after.chat_steps).toEqual(kept(before.chat_steps, "message_id"));
  expect(after.chat_approvals).toEqual(kept(before.chat_approvals, "message_id"));
  expect(after.chat_turn_snapshots).toEqual(kept(before.chat_turn_snapshots, "message_id"));
  const others = (rows: Row[]) => rows.filter((row) => row.id !== S);
  expect(others(after.chat_sessions)).toEqual(others(before.chat_sessions));
}

function sessionOf(all: Dump): Row {
  const row = all.chat_sessions.find((candidate) => candidate.id === S);
  if (row === undefined) {
    throw new Error("session row missing");
  }
  return row;
}

function idsOfS(all: Dump): unknown[] {
  return all.chat_messages.filter((row) => row.session_id === S).map((row) => row.id);
}

describe("undo transaction: delete range", () => {
  it("removes the user message and everything after it, with their steps, approvals and registrations", () => {
    const h = history();
    const before = dump(h.db);

    commitUndo(h.db, emit, h.input);

    const after = dump(h.db);
    expect(idsOfS(after)).toEqual([h.u1, h.a1]);
    expectOnlyRemoved(before, after, [h.u2, h.a2, h.u3, h.a3]);
    // The fixture really had dependent rows to cascade: one step and one approval per assistant.
    expect(before.chat_steps.length - after.chat_steps.length).toBe(2);
    expect(before.chat_approvals.length - after.chat_approvals.length).toBe(2);
    expect(before.chat_turn_snapshots.length - after.chat_turn_snapshots.length).toBe(2);
    expect(after.chat_steps.filter((row) => row.message_id === h.a1)).toHaveLength(1);
    expect(after.chat_approvals.filter((row) => row.message_id === h.a1)).toEqual([
      expect.objectContaining({ decision: "allow", request_id: `r-${h.a1}` }),
    ]);
  });

  it("breaks an equal created_at by id on both sides of the undone message", () => {
    // a1, u2 and a2 share one millisecond: a1 (lower id) stays, u2 itself and a2 (higher id) go.
    const h = history({ times: [10, 30, 30, 30, 50, 60] });
    const before = dump(h.db);

    commitUndo(h.db, emit, h.input);

    const after = dump(h.db);
    expect(idsOfS(after)).toEqual([h.u1, h.a1]);
    expectOnlyRemoved(before, after, [h.u2, h.a2, h.u3, h.a3]);
  });

  it("undoing the first message leaves no message and an idle session", () => {
    const h = history();
    const before = dump(h.db);

    const result = commitUndo(h.db, emit, { ...h.input, messageId: h.u1 });

    const after = dump(h.db);
    expect(idsOfS(after)).toEqual([]);
    expectOnlyRemoved(before, after, [h.u1, h.a1, h.u2, h.a2, h.u3, h.a3]);
    expect(sessionOf(after).status).toBe("idle");
    expect(result.removedMessages).toBe(6);
  });
});

describe("undo transaction: session row", () => {
  it.each(["done", "failed", "stopped"] as const)(
    "status becomes the remaining last assistant's %s",
    (status) => {
      // The session itself is `done` and the removed assistants are `failed` and `done`.
      const h = history({ a1: status });
      commitUndo(h.db, emit, h.input);
      expect(sessionOf(dump(h.db)).status).toBe(status);
    },
  );

  it("writes omp_session_file, status, updated_at and todo and no other column", () => {
    const h = history({ a1: "stopped" });
    const before = sessionOf(dump(h.db));

    commitUndo(h.db, emit, h.input);

    const after = sessionOf(dump(h.db));
    expect(after).toEqual({
      ...before,
      omp_session_file: NEW_FILE,
      status: "stopped",
      updated_at: NOW,
      todo: T1,
    });
    // The seven the spec names, by literal, so a fixture that left them NULL could not pass.
    expect(after).toMatchObject({
      title: "标题 🚀",
      scene: "code",
      pinned_at: 1500,
      archived_at: null,
      workspace_id: W_U1_SPARE,
      stream_epoch: 4,
      parent_session_id: S_A,
    });
  });

  it("restores the registered task list byte for byte, as text", () => {
    const h = history();
    const stored = () =>
      h.db
        .prepare(
          "SELECT CAST(todo AS BLOB) AS bytes, typeof(todo) AS type FROM chat_sessions WHERE id = ?",
        )
        .get(S) as { bytes: Uint8Array; type: string };
    expect(Buffer.from(stored().bytes).toString("utf8")).toBe(T2);

    commitUndo(h.db, emit, h.input);

    expect(Buffer.from(stored().bytes).equals(Buffer.from(T1, "utf8"))).toBe(true);
    expect(stored().type).toBe("text");
  });

  it("a registered NULL task list becomes SQL NULL", () => {
    const h = history({ todoAtU2: null });

    commitUndo(h.db, emit, h.input);

    expect(
      h.db
        .prepare(
          "SELECT todo IS NULL AS empty, typeof(todo) AS type FROM chat_sessions WHERE id = ?",
        )
        .get(S),
    ).toEqual({ empty: 1, type: "null" });
  });
});

describe("undo transaction: compare-and-set", () => {
  /** Runs a direct write and overrides nothing of the input. */
  const direct = (h: History, sql: string): Partial<UndoCommit> => {
    h.db.exec(sql);
    return {};
  };
  const cases: Array<[string, (h: History) => Partial<UndoCommit>]> = [
    [
      "the session is running",
      (h) => direct(h, `UPDATE chat_sessions SET status = 'running' WHERE id = '${S}'`),
    ],
    [
      "the session is archived",
      (h) => direct(h, `UPDATE chat_sessions SET archived_at = 5 WHERE id = '${S}'`),
    ],
    ["the last assistant is another one", (h) => ({ expectedLastAssistantId: h.a2 })],
    ["the caller saw no assistant but one exists", () => ({ expectedLastAssistantId: null })],
    ["the user message is gone", (h) => direct(h, `DELETE FROM chat_messages WHERE id = ${h.u2}`)],
    [
      "the message belongs to another session",
      (h) => {
        // Message 1 is S_A's user message, same owner; registered, so only the session differs.
        insertTurnSnapshot(h.db, {
          messageId: 1,
          workspaceId: W_U1,
          outcome: "ok",
          skipped: [],
          todo: null,
          createdAt: 7,
        });
        return { messageId: 1 };
      },
    ],
    ["the owner is another account", () => ({ ownerId: "u2" })],
    [
      "the message is an assistant message",
      (h) => {
        // Registered out of band, so only the role differs.
        insertTurnSnapshot(h.db, {
          messageId: h.a2,
          workspaceId: W_U1_SPARE,
          outcome: "ok",
          skipped: [],
          todo: null,
          createdAt: 7,
        });
        return { messageId: h.a2 };
      },
    ],
    [
      "the message has no registration row",
      (h) => direct(h, `DELETE FROM chat_turn_snapshots WHERE message_id = ${h.u2}`),
    ],
    ["the session does not exist", () => ({ sessionId: "f".repeat(32) })],
  ];

  it.each(cases)("session_busy and nothing written when %s", (_name, arrange) => {
    const h = history();
    const override = arrange(h);
    const before = dump(h.db);

    expectHttpError(() => commitUndo(h.db, emit, { ...h.input, ...override }), "session_busy");

    expect(dump(h.db)).toEqual(before);
    expect(h.db.isTransaction).toBe(false);
  });

  it("accepts a null expected last assistant when the session has none", () => {
    const h = history();
    h.db.prepare("DELETE FROM chat_messages WHERE session_id = ? AND role = 'assistant'").run(S);

    const result = commitUndo(h.db, emit, {
      ...h.input,
      expectedLastAssistantId: null,
    });

    expect(result.removedMessages).toBe(2);
    const after = dump(h.db);
    expect(idsOfS(after)).toEqual([h.u1]);
    expect(sessionOf(after).status).toBe("idle");
  });

  it("refuses to leave a running assistant as the session's last one", () => {
    // Not reachable through the store (a running assistant means a running session); a corrupt
    // row must not make the session `running` with no process behind it.
    const h = history();
    h.db.prepare("UPDATE chat_messages SET status = 'running' WHERE id = ?").run(h.a1);
    const before = dump(h.db);

    expect(() => commitUndo(h.db, emit, h.input)).toThrow("undo leaves a running assistant");

    expect(dump(h.db)).toEqual(before);
  });
});

describe("undo transaction: audit and return value", () => {
  it("writes one session.undo row in the audit shape", () => {
    const h = history();
    const before = dump(h.db).audit_events.length;

    commitUndo(h.db, emit, h.input);

    const rows = dump(h.db).audit_events;
    expect(rows).toHaveLength(before + 1);
    const row = rows.at(-1) as Row;
    expect({ ...row, detail: JSON.parse(row.detail as string) }).toEqual({
      id: expect.any(Number),
      ts: NOW,
      actor_id: "u1",
      kind: "session.undo",
      title: "撤回消息",
      workspace_id: W_U1_SPARE,
      detail: {
        sessionId: S,
        messageId: h.u2,
        removedMessages: 4,
        files: "force",
      },
    });
  });

  it("an unbound session's audit row has no workspace", () => {
    const h = history();
    // Registrations keep their own workspace; only the session row is unbound here.
    h.db.prepare("UPDATE chat_sessions SET workspace_id = NULL WHERE id = ?").run(S);

    commitUndo(h.db, emit, { ...h.input, files: "keep" });

    const row = dump(h.db).audit_events.at(-1) as Row;
    expect(row.workspace_id).toBeNull();
    expect(JSON.parse(row.detail as string).files).toBe("keep");
  });

  it("a failing audit rolls the whole undo back", () => {
    const h = history();
    const before = dump(h.db);
    const failure = new Error("audit down");

    expect(() =>
      commitUndo(
        h.db,
        () => {
          throw failure;
        },
        h.input,
      ),
    ).toThrow(failure);

    expect(dump(h.db)).toEqual(before);
    expect(h.db.isTransaction).toBe(false);
  });

  it("returns the registrations of every removed user message, read before the delete", () => {
    const h = history();

    expect(commitUndo(h.db, emit, h.input)).toEqual({
      removedMessages: 4,
      snapshots: [
        { messageId: h.u2, workspaceId: W_U1_SPARE, outcome: "ok" },
        { messageId: h.u3, workspaceId: W_U1_SPARE, outcome: "too_large" },
      ],
    });
  });
});
