/**
 * Issue #864 task-list persistence at the unit seam: `persistEvent` over a real `SessionStore` on
 * in-memory SQLite, with a collecting warn sink (session-todo「任务清单来源与归一化」「任务清单持久化」
 * 「todo.updated 事件」). Oracles are the published return value, the raw `chat_sessions` row and
 * the warn records; expected values are literals from those scenarios.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import type { ChatEvent } from "../src/sessions/events.js";
import { createSessionStore, type SessionStore } from "../src/sessions/store.js";
import type { TodoRejection } from "../src/sessions/store-todo.js";
import { persistEvent } from "../src/sessions/turn-control.js";
import { TEST_COMPOSER } from "./session-meta-fixtures.js";

const OWNER = "u1";
const PHASES = [
  {
    name: "准备",
    tasks: [
      { content: "读取需求", status: "in_progress", note: "x" },
      { content: "列出要点", status: "pending" },
    ],
  },
  { name: "交付", tasks: [{ content: "输出结论", status: "blocked", blocker: "等待评审" }] },
];
const STORED =
  '{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"in_progress"},{"content":"列出要点","status":"pending"}]},{"name":"交付","tasks":[{"content":"输出结论","status":"blocked"}]}]}';
const SECRET = "任务文本-864";
/** session-todo「结构不合规整帧丢弃」的五种候选（任务文本换成 SECRET 以验证日志不含它）。 */
const INVALID: Array<[string, unknown]> = [
  ["an unknown status", [{ name: "A", tasks: [{ content: SECRET, status: "done" }] }]],
  ["a non-array", { name: SECRET }],
  ["a task without content", [{ name: SECRET, tasks: [{ status: "pending" }] }]],
  ["a non-string name", [{ name: 7, tasks: [] }]],
  ["a non-object task", [{ name: "A", tasks: [{ content: SECRET, status: "pending" }, null] }]],
];

interface World {
  db: DatabaseSync;
  store: SessionStore;
  warns: TodoRejection[];
  session: string;
  assistant: number;
  /** One raw candidate through `persistEvent`, as the supervisor's #commit calls it. */
  persist(todo: unknown, messageId?: number): ChatEvent<number> | undefined;
}

const opened: World[] = [];

afterEach(() => {
  for (const world of opened.splice(0)) {
    world.store.close();
    world.db.close();
  }
});

function open(warn?: (record: TodoRejection) => void): World {
  const db = openDb(":memory:");
  const warns: TodoRejection[] = [];
  const store = createSessionStore(db, {
    onFlushError: () => {},
    warn: warn ?? ((record) => warns.push(record)),
    composer: TEST_COMPOSER,
  });
  const session = store.create(OWNER).id;
  const assistant = store.acceptPrompt(session, OWNER, "列个清单").assistantMessageId;
  const world: World = {
    db,
    store,
    warns,
    session,
    assistant,
    persist: (todo, messageId = assistant) =>
      persistEvent(
        store,
        messageId,
        { type: "todo.updated", data: { messageId, todo } },
        new Map(),
        () => 1,
        [],
        null,
      ),
  };
  opened.push(world);
  return world;
}

function row(db: DatabaseSync, session: string): Record<string, unknown> {
  const found = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(session);
  if (found === undefined) {
    throw new Error("missing session row");
  }
  return { ...found };
}

function column(world: World): unknown {
  return row(world.db, world.session).todo;
}

describe("a valid candidate is normalised, stored and returned for publication", () => {
  it("stores the compact JSON text and returns todo.updated with the normalised list", () => {
    const world = open();
    expect(column(world)).toBeNull();

    const published = world.persist(PHASES);

    expect(column(world)).toBe(STORED);
    expect(published).toEqual({
      type: "todo.updated",
      data: { messageId: world.assistant, todo: JSON.parse(STORED) },
    });
    expect(JSON.stringify(published)).not.toContain("blocker");
    expect(world.store.readTodo(world.session, OWNER)).toEqual(JSON.parse(STORED));
    expect(world.warns).toEqual([]);
  });

  it("changes the todo column only: updated_at, status, title and every other column stay", () => {
    const world = open();
    world.db
      .prepare("UPDATE chat_sessions SET updated_at = 5, title = '旧标题' WHERE id = ?")
      .run(world.session);
    const before = row(world.db, world.session);

    world.persist(PHASES);

    const after = row(world.db, world.session);
    expect(after).toEqual({ ...before, todo: STORED });
    expect(after.updated_at).toBe(5);
    expect(after.status).toBe("running");
    expect(after.title).toBe("旧标题");
  });

  it("another owner reads no list", () => {
    const world = open();
    world.persist(PHASES);
    expect(world.store.readTodo(world.session, "u2")).toBeNull();
  });
});

describe("a value equal to the stored one is neither written nor published", () => {
  it("the same list twice writes once and publishes once", () => {
    const world = open();
    let writes = 0;
    world.db.setAuthorizer((action, table, columnName) => {
      // 23 = SQLITE_UPDATE
      if (action === 23 && table === "chat_sessions" && columnName === "todo") {
        writes += 1;
      }
      return 0;
    });

    const first = world.persist(PHASES);
    const second = world.persist(structuredClone(PHASES));
    world.db.setAuthorizer(null);

    expect(first?.type).toBe("todo.updated");
    expect(second).toBeUndefined();
    expect(writes).toBe(1);
    expect(column(world)).toBe(STORED);
  });

  it("clearing publishes null once and stores SQL NULL; a second empty list is dropped", () => {
    const world = open();
    world.persist(PHASES);

    const cleared = world.persist([{ name: "准备", tasks: [] }]);
    const again = world.persist([]);

    expect(cleared).toEqual({
      type: "todo.updated",
      data: { messageId: world.assistant, todo: null },
    });
    expect(column(world)).toBeNull();
    expect(again).toBeUndefined();
    expect(world.warns).toEqual([]);
  });

  it("an empty list on a session without a list is dropped", () => {
    const world = open();
    expect(world.persist([])).toBeUndefined();
    expect(column(world)).toBeNull();
  });
});

describe("a structurally invalid candidate is dropped with exactly one warn", () => {
  it.each(INVALID)("%s: nothing stored or published, one warn without task text", (_name, bad) => {
    const world = open();
    world.persist(PHASES);

    expect(world.persist(bad)).toBeUndefined();

    expect(column(world)).toBe(STORED);
    expect(world.warns).toEqual([
      { level: "warn", event: "session_todo_rejected", assistantMessageId: world.assistant },
    ]);
    expect(JSON.stringify(world.warns)).not.toContain(SECRET);
  });

  it("a throwing warn sink does not turn the drop into a fault", () => {
    const world = open(() => {
      throw new Error("sink down");
    });
    expect(world.persist({ name: "A" })).toBeUndefined();
    expect(column(world)).toBeNull();
  });
});

describe("a failed write publishes nothing and throws to the owned error path", () => {
  it("a SQLite failure on the todo column throws and leaves the stored list", () => {
    const world = open();
    world.persist(PHASES);
    world.db.exec(`CREATE TEMP TRIGGER reject_todo BEFORE UPDATE OF todo ON chat_sessions
      BEGIN SELECT RAISE(ABORT, 'todo write sentinel'); END`);

    expect(() => world.persist([])).toThrow("todo write sentinel");
    expect(column(world)).toBe(STORED);
    expect(world.warns).toEqual([]);
  });

  it("an assistant message without a session row throws", () => {
    const world = open();
    expect(() => world.persist(PHASES, 9_999)).toThrow("no session for the assistant message");
    expect(column(world)).toBeNull();
  });
});

// session-todo「任务清单快照」「存量坏值降级为 null」: only an out-of-band write can leave such a value.
describe("a stored value that is not a normalised list reads as null and is left alone", () => {
  it.each([
    ["text that is not JSON", "{not json"],
    ["JSON whose phases is not a list", '{"phases":"x"}'],
    ["JSON that is not an object", "null"],
  ])("%s", (_label, tampered) => {
    const world = open();
    world.db.prepare("UPDATE chat_sessions SET todo = ? WHERE id = ?").run(tampered, world.session);

    expect(world.store.readTodo(world.session, OWNER)).toBeNull();

    expect(column(world)).toBe(tampered);
    expect(world.warns).toEqual([]);
  });
});

describe("the stored list survives terminal settlement and startup reconciliation", () => {
  it.each(["stopped", "failed"] as const)("a turn ending %s keeps the list", (status) => {
    const world = open();
    world.persist(PHASES);
    world.store.finishTurn(world.assistant, status);
    expect(row(world.db, world.session).status).toBe(status);
    expect(column(world)).toBe(STORED);
  });

  it("a running session reconciled at startup keeps the list", () => {
    const db = openDb(":memory:");
    try {
      const before = createSessionStore(db, { onFlushError: () => {}, composer: TEST_COMPOSER });
      const session = before.create(OWNER).id;
      db.prepare("UPDATE chat_sessions SET status = 'running', todo = ? WHERE id = ?").run(
        STORED,
        session,
      );
      const restarted = createSessionStore(db, { onFlushError: () => {}, composer: TEST_COMPOSER });
      restarted.reconcileOnStartup();
      expect(row(db, session).status).not.toBe("running");
      expect(row(db, session).todo).toBe(STORED);
    } finally {
      db.close();
    }
  });
});
