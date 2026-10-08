/**
 * Issue #945 (s1f-session-list-temp-space task 10.5): the per-turn workspace snapshot through the
 * REST seam — workspace-snapshots「受理时做快照」(six scenarios), chat-sessions「Snapshot precedes
 * dispatch and never blocks it」and the snapshot-service sentence of http-service-skeleton「Shared
 * agent module assembly」.
 *
 * Production `createApp`, real SQLite, real fake-omp children, a real workspace directory and a
 * real managed snapshots directory. A case that needs `take` held open or failing replaces the
 * service through the assembly's `snapshots`; every other case runs the service createApp builds.
 * Oracles: the spec's literals, the bytes written here, SQL read straight from the database, the
 * frames each child received on stdin. No sleeps: order is read at the moment a frame is written.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveServerConfig, sessionRuntimeOf } from "../src/server.js";
import type { TurnSnapshotService } from "../src/sessions/turn-snapshot.js";
import {
  accepted,
  closeWorldsAfterEach,
  framesOfType,
  heldService,
  messageCount,
  open,
  plainRow,
  put,
  rows,
  send,
  statusOf,
  turn,
  turnEnds,
} from "./prompt-snapshot-helpers.js";
import { REAL, settle } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { sendDelete } from "./session-delete-helpers.js";
import { observeDeletes } from "./session-delete-running-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE } from "./session-rest-helpers.js";
import { OWNER_ID, waitFor } from "./session-supervisor-helpers.js";
import { seedUnboundSession } from "./support/temporary-workspace.js";
import { contentsOf } from "./workspace-snapshots-helpers.js";

closeWorldsAfterEach();

describe("workspace-snapshots 受理时做快照 (#945)", () => {
  it(
    "每个回合前一份: each turn's snapshot is complete before its prompt frame, and holds the workspace as it was",
    REAL,
    async () => {
      const world = await open({ scenario: "edit-write" });
      put(world, "keep.txt", "unchanged\n");
      put(world, "notes.md", "before\n");
      const since = Date.now();

      const first = await turn(world, "write the report");
      // The fake's turn rewrote notes.md and added out/report.html in the workspace.
      const afterFirst = contentsOf(world.root);
      expect(afterFirst["notes.md"]).not.toBe("before\n");
      expect(Object.keys(afterFirst)).toEqual(["keep.txt", "notes.md", "out", "out/report.html"]);
      const second = await turn(world, "again");

      expect(rows(world.db)).toEqual([
        plainRow(world, first, "ok", since),
        plainRow(world, second, "ok", since),
      ]);
      expect(readdirSync(world.snapshots).sort()).toEqual([String(first), String(second)]);
      for (const id of [first, second]) {
        expect(readdirSync(join(world.snapshots, String(id))).sort()).toEqual([
          "manifest.json",
          "tree",
        ]);
      }
      expect(contentsOf(join(world.snapshots, String(first), "tree"))).toEqual({
        "keep.txt": "unchanged\n",
        "notes.md": "before\n",
      });
      expect(contentsOf(join(world.snapshots, String(second), "tree"))).toEqual(afterFirst);
      // One child served both turns; at each prompt frame that turn's snapshot was complete.
      expect(world.stdin).toHaveLength(1);
      expect(world.completeAtPrompt).toEqual([[String(first)], [String(first), String(second)]]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "去重: the first turn of a workspace is ok, and a file unchanged between two turns is one inode in both snapshots",
    REAL,
    async () => {
      const world = await open({ scenario: "edit-write" });
      put(world, "keep.txt", "unchanged\n");
      put(world, "notes.md", "before\n");

      const first = await turn(world, "one");
      expect(rows(world.db).map((row) => row.outcome)).toEqual(["ok"]);
      const second = await turn(world, "two");

      const kept = [first, second].map((id) =>
        lstatSync(join(world.snapshots, String(id), "tree", "keep.txt")),
      );
      expect(kept[1]?.ino).toBe(kept[0]?.ino);
      expect(kept[0]?.nlink).toBeGreaterThanOrEqual(2);
      // The rewritten file is a separate copy.
      const notes = [first, second].map(
        (id) => lstatSync(join(world.snapshots, String(id), "tree", "notes.md")).ino,
      );
      expect(notes[1]).not.toBe(notes[0]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "快照期间停止: the stop is 202 while take is held, nothing is spawned until it is released, then one prompt, one abort, one stopped end and an ok row",
    REAL,
    async () => {
      const held = heldService();
      const world = await open({ scenario: "abort-ok", service: held.service });
      put(world, "a.txt", "1");
      const since = Date.now();

      const prompting = send(world, "stop me during the snapshot");
      let promptSettled = false;
      void prompting.then(() => {
        promptSettled = true;
      });
      await held.entered;
      const stopped = await postSessionAction(
        world.fixture.app,
        "stop",
        world.session,
        world.cookie,
      );
      expect([stopped.statusCode, stopped.json()]).toEqual([202, {}]);
      // Still held: no child, no frame, no row, and the prompt has not answered.
      expect(held.released()).toBe(false);
      expect([world.rt.calls.length, world.stdin.length, promptSettled]).toEqual([0, 0, false]);
      expect(rows(world.db)).toEqual([]);

      held.release();
      const { userMessageId } = accepted(await prompting);
      await waitFor(() => (statusOf(world) === "stopped" ? true : undefined), "the stopped turn");

      expect(world.rt.calls).toHaveLength(1);
      expect([framesOfType(world, "prompt"), framesOfType(world, "abort")]).toEqual([1, 1]);
      expect(turnEnds(world)).toEqual(["stopped"]);
      expect(rows(world.db)).toEqual([plainRow(world, userMessageId, "ok", since)]);
      expect(contentsOf(join(world.snapshots, String(userMessageId), "tree"))).toEqual({
        "a.txt": "1",
      });
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "快照期间删除: the DELETE waits for the held take, answers 204 once the turn is stopped, and leaves no session, message or registration row",
    REAL,
    async () => {
      const held = heldService();
      const world = await open({ scenario: "abort-ok", service: held.service });
      put(world, "a.txt", "1");
      const deletes = observeDeletes(world.db);

      const prompting = send(world, "delete me during the snapshot");
      await held.entered;
      let deleted = false;
      const deleting = sendDelete(world.fixture.app, world.session, world.cookie).then(
        (response) => {
          deleted = true;
          return response;
        },
      );
      await settle();
      expect([deleted, world.rt.calls.length, statusOf(world)]).toEqual([false, 0, "running"]);

      held.release();
      expect((await deleting).statusCode).toBe(204);
      await prompting;

      // The row went at a moment the turn was already stopped: the delete did not cut it short.
      expect(deletes()).toEqual([
        { id: world.session, session: "stopped", assistants: "stopped", approvals: null },
      ]);
      expect(statusOf(world)).toBeUndefined();
      expect(messageCount(world.db, world.session)).toBe(0);
      expect(rows(world.db)).toEqual([]);
      // The fake held its turn until the one abort: no turn ran to completion.
      expect([framesOfType(world, "prompt"), framesOfType(world, "abort")]).toEqual([1, 1]);
      expect(turnEnds(world)).toEqual(["stopped"]);
    },
  );

  it(
    "命令回合与未绑定会话: `/todo` is registered as command with no directory; a legacy unbound session gets no row; both turns run",
    REAL,
    async () => {
      const world = await open({ scenario: "slash" });
      put(world, "a.txt", "1");
      const since = Date.now();

      const command = await turn(world, "/todo");
      expect(rows(world.db)).toEqual([plainRow(world, command, "command", since)]);
      expect(existsSync(world.snapshots)).toBe(false);

      const unbound = seedUnboundSession(world.db, OWNER_ID, "7".repeat(32));
      await turn(world, "an ordinary prompt", "done", unbound);
      expect(messageCount(world.db, unbound)).toBe(2);
      expect(rows(world.db)).toEqual([plainRow(world, command, "command", since)]);
      expect(readdirSync(join(world.rt.runtime.stateDir, "snapshots"))).toEqual([]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "快照失败不挡发送: a take that throws, and one that resolves failed, are each reported once, registered failed, and the turn completes",
    REAL,
    async () => {
      const thrown = new Error("take threw");
      const returned = new Error("take failed");
      const failures: Array<[Error, TurnSnapshotService["take"]]> = [
        [thrown, () => Promise.reject(thrown)],
        [returned, () => Promise.resolve({ outcome: "failed", error: returned })],
      ];
      for (const [error, failingTake] of failures) {
        const world = await open({ service: (real) => ({ ...real, take: failingTake }) });
        put(world, "a.txt", "1");
        const since = Date.now();

        const id = await turn(world, "carry on");

        expect(world.errors).toEqual([error]);
        expect(world.errors[0]).toBe(error);
        expect(rows(world.db)).toEqual([plainRow(world, id, "failed", since)]);
        expect(existsSync(world.snapshots)).toBe(false);
        expect(framesOfType(world, "prompt")).toBe(1);
      }
    },
  );

  it(
    "快照失败不挡发送: a workspace over the total limit is registered too_large, leaves no directory, and the turn completes",
    REAL,
    async () => {
      const world = await open({ settings: { snapshotMaxTotalBytes: 4 } });
      put(world, "five.txt", "12345");
      const since = Date.now();

      const id = await turn(world, "carry on");

      expect(rows(world.db)).toEqual([plainRow(world, id, "too_large", since)]);
      expect(readdirSync(world.snapshots)).toEqual([]);
      expect(framesOfType(world, "prompt")).toBe(1);
      // Only `failed` is reported (spec「受理时做快照」): too_large is an ordinary outcome.
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "a registration row that cannot be written is reported once and the turn completes",
    REAL,
    async () => {
      const world = await open();
      put(world, "a.txt", "1");
      world.db.exec(
        "CREATE TEMP TRIGGER refuse_registration BEFORE INSERT ON chat_turn_snapshots BEGIN SELECT RAISE(ABORT, 'registration refused'); END",
      );

      await turn(world, "carry on");

      expect(world.errors.map((error) => error.message)).toEqual(["registration refused"]);
      expect(rows(world.db)).toEqual([]);
      // Nothing would lead to the directory again, so it does not stay.
      expect(readdirSync(world.snapshots)).toEqual([]);
    },
  );

  it(
    "受理被补偿时清理: a dispatch refused with agent_unavailable after an ok snapshot is 502, and the message, its row and its directory are gone",
    REAL,
    async () => {
      // What `take` resolved with, and whether that message's snapshot stood complete right then.
      const taken: Array<[string, boolean]> = [];
      const at = { stateDir: "" };
      const world = await open({
        service: (real) => ({
          ...real,
          async take(root, workspaceId, userMessageId, previous) {
            const result = await real.take(root, workspaceId, userMessageId, previous);
            const directory = join(at.stateDir, "snapshots", workspaceId, String(userMessageId));
            taken.push([result.outcome, existsSync(join(directory, "manifest.json"))]);
            // The workspace root goes after the snapshot: the supervisor finds no cwd to spawn in.
            rmSync(root, { recursive: true });
            return result;
          },
        }),
      });
      at.stateDir = world.rt.runtime.stateDir;
      put(world, "a.txt", "1");

      const response = await send(world, "nowhere to run");

      expect([response.statusCode, response.json()]).toEqual([502, AGENT_UNAVAILABLE_ENVELOPE]);
      // The snapshot had succeeded and its directory stood before the dispatch was refused.
      expect(taken).toEqual([["ok", true]]);
      expect(messageCount(world.db, world.session)).toBe(0);
      expect(rows(world.db)).toEqual([]);
      expect(readdirSync(world.snapshots)).toEqual([]);
      expect(world.rt.calls).toHaveLength(0);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "受理被补偿时清理: a remove that fails is reported once and the 502 is unchanged",
    REAL,
    async () => {
      const removal = new Error("remove failed");
      const removed: Array<[string, number]> = [];
      const world = await open({
        service: (real) => ({
          async take(root, ...rest) {
            const result = await real.take(root, ...rest);
            rmSync(root, { recursive: true });
            return result;
          },
          remove(workspaceId, messageId) {
            removed.push([workspaceId, messageId]);
            return Promise.reject(removal);
          },
        }),
      });
      put(world, "a.txt", "1");

      const response = await send(world, "nowhere to run");

      expect([response.statusCode, response.json()]).toEqual([502, AGENT_UNAVAILABLE_ENVELOPE]);
      expect(world.errors).toEqual([removal]);
      expect(removed).toEqual([[world.workspaceId, Number(readdirSync(world.snapshots)[0])]]);
      expect(messageCount(world.db, world.session)).toBe(0);
      expect(rows(world.db)).toEqual([]);
    },
  );

  it(
    "记录当时的任务清单: the row's todo is the stored text byte for byte, and NULL for NULL",
    REAL,
    async () => {
      const world = await open();
      // Not what the store would write: spacing, a multibyte name and a trailing blank survive only
      // if the text is copied, never parsed and re-serialised.
      const stored = '{ "phases": [ { "name": "阶段 一",  "tasks": [] } ] }  \n';
      world.db.prepare("UPDATE chat_sessions SET todo = ? WHERE id = ?").run(stored, world.session);

      const withList = await turn(world, "with a list");
      world.db.prepare("UPDATE chat_sessions SET todo = NULL WHERE id = ?").run(world.session);
      const withoutList = await turn(world, "without a list");

      expect(
        rows(world.db).map((row) => [row.message_id, row.outcome, row.todo_type, row.todo_hex]),
      ).toEqual([
        [withList, "ok", "text", Buffer.from(stored, "utf8").toString("hex").toUpperCase()],
        [withoutList, "ok", "null", ""],
      ]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "regenerate takes no snapshot: the rows and the snapshot directories are the same before and after",
    REAL,
    async () => {
      const world = await open({ scenario: "branch" });
      put(world, "a.txt", "1");
      // The fake's `branch` list ends with this text; regenerate looks the user message up by it.
      await turn(world, "second question");
      const before = { rows: rows(world.db), dirs: contentsOf(world.snapshots) };
      expect(before.rows.map((row) => row.outcome)).toEqual(["ok"]);

      const response = await postSessionAction(
        world.fixture.app,
        "regenerate",
        world.session,
        world.cookie,
      );
      expect(response.statusCode).toBe(202);
      await waitFor(() => (statusOf(world) === "done" ? true : undefined), "the regenerated turn");

      expect(messageCount(world.db, world.session)).toBe(2);
      expect({ rows: rows(world.db), dirs: contentsOf(world.snapshots) }).toEqual(before);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("chat-sessions Snapshot precedes dispatch and never blocks it (#945)", () => {
  type TakeOf = (real: TurnSnapshotService) => TurnSnapshotService["take"];
  const cases: Array<[string, string, string, TakeOf]> = [
    ["a working snapshot module", "ok", "available", (real) => real.take],
    [
      "a snapshot module that throws",
      "failed",
      "failed",
      () => () => Promise.reject(new Error("boom")),
    ],
  ];
  it.each(cases)(
    "with %s the supervisor is called once, in the admission's own tick, before any take, the row is %s and the 202 says %s",
    REAL,
    async (_name, outcome, undo, takeOf) => {
      const order: string[] = [];
      const world = await open({
        service: (real) => {
          const inner = takeOf(real);
          return {
            ...real,
            take(...args) {
              order.push("take");
              return inner(...args);
            },
          };
        },
      });
      put(world, "a.txt", "1");
      const { store, supervisor } = world.fixture;
      const admit = store.acceptPrompt.bind(store);
      vi.spyOn(store, "acceptPrompt").mockImplementation((...args) => {
        const admitted = admit(...args);
        order.push("admitted");
        // Runs at the first await after admission: it must come after the supervisor call.
        queueMicrotask(() => order.push("first await after admission"));
        return admitted;
      });
      const dispatch = supervisor.prompt.bind(supervisor);
      const prompt = vi.spyOn(supervisor, "prompt").mockImplementation((...args) => {
        order.push("supervisor.prompt");
        return dispatch(...args);
      });

      const body = accepted(await send(world, "plain text"));
      await waitFor(() => (statusOf(world) === "done" ? true : undefined), "the turn");
      const id = body.userMessageId;

      expect(body.undo).toBe(undo);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt.mock.calls[0]).toEqual([world.session, "plain text", expect.any(Function)]);
      // No await between admission and the supervisor call, and no take before that call.
      expect(order.slice(0, 2)).toEqual(["admitted", "supervisor.prompt"]);
      expect(order.slice(2).sort()).toEqual(["first await after admission", "take"]);
      expect(rows(world.db).map((row) => [row.message_id, row.outcome])).toEqual([[id, outcome]]);
      expect(world.errors).toHaveLength(outcome === "ok" ? 0 : 1);
    },
  );
});

describe("http-service-skeleton Shared agent module assembly: the snapshot service (#945)", () => {
  it(
    "builds the service from the state dir's snapshots directory and the four settings of the runtime object",
    REAL,
    async () => {
      const world = await open({
        settings: { snapshotExcludeNames: ["skipme"], snapshotMaxFileBytes: 8 },
      });
      put(world, "a.txt", "small");
      put(world, "big.bin", "123456789");
      put(world, "skipme/x.txt", "left out");
      // Excluded by default; kept here because the configured list replaces the default one.
      put(world, "node_modules/m.js", "kept");

      const id = await turn(world, "snapshot with settings");

      const [row] = rows(world.db);
      expect([row?.message_id, row?.outcome]).toEqual([id, "ok"]);
      const skipped = JSON.parse(row?.skipped ?? "null") as {
        count: number;
        paths: Array<{ path: string; reason: string }>;
      };
      expect(Object.keys(skipped)).toEqual(["count", "paths"]);
      expect(skipped.count).toBe(2);
      expect(skipped.paths.sort((left, right) => left.path.localeCompare(right.path))).toEqual([
        { path: "big.bin", reason: "too_large" },
        { path: "skipme", reason: "excluded" },
      ]);
      // The managed layout's directory: <state dir>/snapshots/<workspaceId>/<userMessageId>.
      const directory = join(world.rt.runtime.stateDir, "snapshots", world.workspaceId, String(id));
      expect(contentsOf(join(directory, "tree"))).toEqual({
        "a.txt": "small",
        node_modules: "dir",
        "node_modules/m.js": "kept",
      });
      expect(world.errors).toEqual([]);
    },
  );

  it("the production runtime object carries the four resolved settings, defaults included", () => {
    const entry = pathToFileURL(
      join(
        resolve(fileURLToPath(new URL("../../", import.meta.url))),
        "server",
        "src",
        "server.ts",
      ),
    ).href;
    const configured = sessionRuntimeOf(
      resolveServerConfig(
        {
          SNAPSHOT_MAX_FILE_BYTES: "10",
          SNAPSHOT_MAX_TOTAL_BYTES: "20",
          SNAPSHOT_MAX_ENTRIES: "2",
          SNAPSHOT_EXCLUDE_NAMES: "dist,.cache",
        },
        entry,
      ),
    );
    expect(configured).toMatchObject({
      snapshotMaxFileBytes: 10,
      snapshotMaxTotalBytes: 20,
      snapshotMaxEntries: 2,
      snapshotExcludeNames: ["dist", ".cache"],
    });
    expect(sessionRuntimeOf(resolveServerConfig({}, entry))).toMatchObject({
      snapshotMaxFileBytes: 20_971_520,
      snapshotMaxTotalBytes: 524_288_000,
      snapshotMaxEntries: 50_000,
      snapshotExcludeNames: ["node_modules", ".venv", "__pycache__"],
    });
  });

  it("applies the entry limit of the runtime object", REAL, async () => {
    const world = await open({ settings: { snapshotMaxEntries: 1 } });
    put(world, "a.txt", "1");
    put(world, "b.txt", "2");

    await turn(world, "two entries");

    expect(rows(world.db).map((row) => row.outcome)).toEqual(["too_large"]);
    expect(readdirSync(world.snapshots)).toEqual([]);
  });

  it(
    "takes the default settings when the runtime object carries none: node_modules is left out",
    REAL,
    async () => {
      const world = await open();
      put(world, "a.txt", "1");
      put(world, "node_modules/m.js", "left out");

      const id = await turn(world, "defaults");

      expect(rows(world.db).map((row) => [row.outcome, row.skipped])).toEqual([
        ["ok", JSON.stringify({ count: 1, paths: [{ path: "node_modules", reason: "excluded" }] })],
      ]);
      expect(contentsOf(join(world.snapshots, String(id), "tree"))).toEqual({ "a.txt": "1" });
      expect(readFileSync(join(world.snapshots, String(id), "tree", "a.txt"), "utf8")).toBe("1");
    },
  );
});
