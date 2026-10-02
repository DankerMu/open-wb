/**
 * Issue #522 unit layer of the `files.changed` publication: the `persistEvent` branch (ownership
 * judgment → `setStepChanges` → the event to publish) over a recording store double, and
 * `SessionStore.setStepChanges` over a real in-memory SQLite. `node:fs` is passed through a call
 * recorder (behaviour untouched) so "no filesystem access" is an observation, not an inference.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { FileChange } from "../src/sessions/file-changes.js";
import type { SessionStore, SettledApproval } from "../src/sessions/store.js";
import { persistEvent } from "../src/sessions/turn-control.js";
import { withSessionStore } from "./session-store-helpers.js";

/** Names of the `node:fs` functions called through a named import, in call order. */
const fsCalls = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const recorded: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    recorded[name] =
      typeof value === "function"
        ? new Proxy(value, {
            apply(target, self, args) {
              fsCalls.push(name);
              return Reflect.apply(target, self, args);
            },
          })
        : value;
  }
  return recorded;
});

const MESSAGE_ID = 41;
const STEP_ID = 7;
const CALL_ID = "tool-edit-1";
const ROW_RECEIPT = "step changes must change exactly 1 row";
/** The stored text of the two-file event below: spec key order, relative paths. */
const TWO_FILES_TEXT =
  '[{"path":"notes.md","added":2,"removed":1,"kind":"edit"},' +
  '{"path":"out/report.html","added":null,"removed":null,"kind":"write"}]';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A canonical workspace root holding `notes.md` and `out/report.html`. */
function openRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-522-persist-")));
  roots.push(root);
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "notes.md"), "a\nb\nd\n");
  writeFileSync(join(root, "out", "report.html"), "<html></html>");
  return root;
}

function filesChanged(files: FileChange[], stepId = CALL_ID): ChatEvent<string> {
  return { type: "files.changed", data: { messageId: MESSAGE_ID, stepId, files } };
}

function notesEdit(root: string): FileChange {
  return { path: join(root, "notes.md"), added: 2, removed: 1, kind: "edit" };
}

interface Recorder {
  store: SessionStore;
  /** Every property read on the store. */
  touched: string[];
  /** Every call made through such a property: `[method, ...arguments]`. */
  calls: unknown[][];
}

/** A store double that records reads and calls; every method throws `failure` when given. */
function recorder(failure?: Error): Recorder {
  const touched: string[] = [];
  const calls: unknown[][] = [];
  const handler: ProxyHandler<object> = {
    get(_target, key) {
      const method = String(key);
      touched.push(method);
      return (...args: unknown[]) => {
        calls.push([method, ...args]);
        if (failure !== undefined) {
          throw failure;
        }
      };
    },
  };
  return { store: new Proxy({}, handler) as unknown as SessionStore, touched, calls };
}

/** One `persistEvent` call for a turn whose only registered tool call is CALL_ID → STEP_ID. */
function persist(event: ChatEvent<string>, workspaceRoot: string | null, double = recorder()) {
  const toolIds = new Map([[CALL_ID, STEP_ID]]);
  const ordinals = vi.fn(() => 1);
  const settled: SettledApproval[] = [];
  fsCalls.length = 0;
  const published = persistEvent(
    double.store,
    MESSAGE_ID,
    event,
    toolIds,
    ordinals,
    settled,
    workspaceRoot,
  );
  const accessed = [...fsCalls];
  expect([...toolIds]).toEqual([[CALL_ID, STEP_ID]]);
  expect(ordinals).not.toHaveBeenCalled();
  expect(settled).toEqual([]);
  return { published, touched: double.touched, calls: double.calls, accessed };
}

describe("persistEvent files.changed", () => {
  it("P1 a bound, registered call stores the owned files once and returns them to publish", () => {
    const root = openRoot();
    const event = filesChanged([
      notesEdit(root),
      { path: join(root, "out", "report.html"), added: null, removed: null, kind: "write" },
      { path: "/etc/passwd", added: 9, removed: 9, kind: "edit" },
    ]);
    const input = structuredClone(event);

    const result = persist(event, root);

    expect(result.calls).toEqual([["setStepChanges", STEP_ID, TWO_FILES_TEXT]]);
    expect(result.touched).toEqual(["setStepChanges"]);
    expect(result.published).toEqual({
      type: "files.changed",
      data: {
        messageId: MESSAGE_ID,
        stepId: STEP_ID,
        files: [
          { path: "notes.md", added: 2, removed: 1, kind: "edit" },
          { path: "out/report.html", added: null, removed: null, kind: "write" },
        ],
      },
    });
    const published = result.published as Extract<ChatEvent<number>, { type: "files.changed" }>;
    expect(JSON.parse(TWO_FILES_TEXT)).toEqual(published.data.files);
    expect(JSON.stringify(published.data.files)).toBe(TWO_FILES_TEXT);
    expect(JSON.stringify([result.calls, result.published])).not.toContain(root);
    expect(event).toEqual(input);
  });

  it("P2 an unbound session returns undefined before any store or filesystem access", () => {
    const root = openRoot();
    const event = filesChanged([notesEdit(root)]);

    const unbound = persist(event, null);

    expect(unbound.published).toBeUndefined();
    expect(unbound.touched).toEqual([]);
    expect(unbound.accessed).toEqual([]);
    // The same candidate is owned once a root is bound: the null root is what dropped it.
    const bound = persist(event, root);
    expect(bound.calls).toEqual([
      ["setStepChanges", STEP_ID, '[{"path":"notes.md","added":2,"removed":1,"kind":"edit"}]'],
    ]);
    expect(bound.accessed).toContain("realpathSync");
  });

  it("P3 an unregistered call or a batch entirely outside the root stores nothing", () => {
    const root = openRoot();

    const unregistered = persist(filesChanged([notesEdit(root)], "tool-unknown"), root);
    expect(unregistered.published).toBeUndefined();
    expect(unregistered.touched).toEqual([]);
    expect(unregistered.accessed).toEqual([]);

    const outside = persist(
      filesChanged([
        { path: "/etc/passwd", added: 1, removed: 0, kind: "edit" },
        { path: "../elsewhere.md", added: null, removed: null, kind: "write" },
        { path: root, added: 1, removed: 0, kind: "edit" },
      ]),
      root,
    );
    expect(outside.published).toBeUndefined();
    expect(outside.touched).toEqual([]);

    // The registered call with the inside candidate is the control for both.
    expect(persist(filesChanged([notesEdit(root)]), root).published).toMatchObject({
      type: "files.changed",
      data: { stepId: STEP_ID },
    });
  });

  it("P4 a failing setStepChanges throws the same error and returns no event", () => {
    const root = openRoot();
    const sentinel = new Error("changes write sentinel");
    const double = recorder(sentinel);
    let published: unknown = "not returned";
    let thrown: unknown;
    try {
      published = persist(filesChanged([notesEdit(root)]), root, double).published;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(sentinel);
    expect(published).toBe("not returned");
    expect(double.calls).toEqual([
      ["setStepChanges", STEP_ID, '[{"path":"notes.md","added":2,"removed":1,"kind":"edit"}]'],
    ]);
  });

  it("P6 thinking.delta still returns undefined without touching the store", () => {
    const root = openRoot();
    const thinking: ChatEvent<string> = {
      type: "thinking.delta",
      data: { messageId: MESSAGE_ID, delta: "先读需求，" },
    };
    for (const workspaceRoot of [root, null]) {
      const result = persist(thinking, workspaceRoot);
      expect(result.published).toBeUndefined();
      expect(result.touched).toEqual([]);
      expect(result.accessed).toEqual([]);
    }
  });
});

describe("SessionStore.setStepChanges", () => {
  function changesColumn(db: DatabaseSync, stepId: number): unknown {
    const row = db.prepare("SELECT changes, status FROM chat_steps WHERE id = ?").get(stepId);
    return row === undefined ? "missing row" : { ...row };
  }

  it("P5 writes the text to a running step and to nothing else", () => {
    withSessionStore(({ db, store }) => {
      const session = store.create("u1");
      const turn = store.acceptPrompt(session.id, "u1", "edit two files");
      const start = (ordinal: number) =>
        store.startStep(turn.assistantMessageId, { ordinal, name: "edit", detail: "{}" });

      const running = start(0);
      const untouched = start(1);
      store.setStepChanges(running, TWO_FILES_TEXT);
      expect(changesColumn(db, running)).toEqual({ changes: TWO_FILES_TEXT, status: "running" });
      expect(changesColumn(db, untouched)).toEqual({ changes: null, status: "running" });

      const settled = start(2);
      expect(store.finishStep(settled, "done", "ok")).toBe(true);
      expect(() => store.setStepChanges(settled, TWO_FILES_TEXT)).toThrow(ROW_RECEIPT);
      expect(changesColumn(db, settled)).toEqual({ changes: null, status: "done" });

      const absent = settled + 1_000;
      expect(() => store.setStepChanges(absent, TWO_FILES_TEXT)).toThrow(ROW_RECEIPT);
      expect(changesColumn(db, absent)).toBe("missing row");

      // step.end keeps the stored changes; a step settled by the turn's end takes none.
      expect(store.finishStep(running, "done", "Updated notes.md")).toBe(true);
      expect(changesColumn(db, running)).toEqual({ changes: TWO_FILES_TEXT, status: "done" });
      expect(store.finishTurn(turn.assistantMessageId, "stopped", [])).toBe(true);
      expect(() => store.setStepChanges(untouched, TWO_FILES_TEXT)).toThrow(ROW_RECEIPT);
      expect(changesColumn(db, untouched)).toEqual({ changes: null, status: "stopped" });
    });
  });
});
