/**
 * Issue #465 regenerate over real fake-omp `branch` children (production createApp assembly,
 * real SQLite): the normal regenerate with its cascade and new session file (R1), a reclaimed
 * session acquiring a normal generation (R2), the control claim in every holdable RPC gap (R3),
 * text mismatch (R4), transaction write fault before (R5) and after (R5b) the delete, CAS recheck failure (R6), prechecks (R7),
 * stop and the claim (R8, R8d its synchronous throw), idle-reclaim re-admission (R9), shutdown before the commit (R10) and
 * shutdown mid-command (G). Oracles: SQL rows, per-child stdin frames and stdout replies, spawn
 * argv, published events and the public supervisor surface.
 */
import { describe, expect, it, vi } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { RetainedEvent } from "../src/sessions/stream/ring-buffer.js";
import { REAL, settle, spawnedAt } from "./session-approval-helpers.js";
import { A_PDF_STORED, A_PDF_SUFFIX, attach, messagesOf } from "./session-fork-helpers.js";
import {
  answered,
  count,
  epochOf,
  HOLD,
  held,
  heldLine,
  type LineMatch,
  openRegenWorld,
  P,
  promptsAgain,
  QUESTION,
  regenerate,
  regenWorlds,
  rejectedCode,
  seedDone,
  sendPrompt,
  sessionFile,
  snapshot,
  types,
  waitDead,
} from "./session-regenerate-helpers.js";
import { SESSION_BUSY_ENVELOPE } from "./session-rest-helpers.js";
import { heldTurn, openStopWorld } from "./session-stop-helpers.js";
import {
  assistantIdFor,
  createSession,
  IDLE_MS,
  OWNER_ID,
  requiredCall,
  resumePath,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

const worlds = regenWorlds();

/** A seeded done session whose regenerate is pending with the first child's `hold` line held. */
async function heldRegenerate(hold: LineMatch) {
  const world = worlds.track(await openRegenWorld({ hold }));
  seedDone(world);
  const work = regenerate(world);
  await heldLine(world);
  return { world, db: world.fixture.db, work };
}

function withoutResume(args: readonly string[]): string[] {
  const index = args.indexOf("--resume");
  return index === -1 ? [...args] : [...args.slice(0, index), ...args.slice(index + 2)];
}

function lastStateReply(replies: readonly OmpFrame[] | undefined): OmpFrame | undefined {
  return (replies ?? []).filter((f) => f.type === "response" && f.command === "get_state").at(-1);
}

describe("regenerate over real fake-omp branch children (#465)", () => {
  it(
    "R1 regenerates the last answer, cascades its rows and moves to the branch file",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld());
      const { db } = world.fixture;
      await answered(world);
      const old = assistantIdFor(world.fixture, world.session);
      const stepsOf = "SELECT COUNT(*) AS count FROM chat_steps WHERE message_id = ?";
      const approvalsOf = "SELECT COUNT(*) AS count FROM chat_approvals WHERE message_id = ?";
      expect(count(db, stepsOf, old)).toBeGreaterThan(0);
      db.prepare(
        "INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at, decision, decided_at) VALUES (?, 'r9', 'bash', 'run ls', 70, 60070, 'allow', 80)",
      ).run(old);
      expect(count(db, approvalsOf, old)).toBe(1);
      const first = spawnedAt(world, 0);
      const sentBefore = first.stdin.length;

      const result = await regenerate(world);

      expect(Object.keys(result)).toEqual(["assistantMessageId"]);
      const fresh = result.assistantMessageId;
      expect(fresh).toBeGreaterThan(old);
      const sent = first.stdin.slice(sentBefore);
      expect(types(sent)).toEqual(["get_branch_messages", "branch", "get_state", "prompt"]);
      expect(sent[1]).toMatchObject({ type: "branch", entryId: "fake-entry-2" });
      expect(sent[3]).toMatchObject({ type: "prompt", message: QUESTION });
      expect(count(db, "SELECT COUNT(*) AS count FROM chat_messages WHERE id = ?", old)).toBe(0);
      expect(count(db, stepsOf, old)).toBe(0);
      expect(count(db, approvalsOf, old)).toBe(0);
      const file = sessionFile(db, world.session);
      expect(file).toMatch(/branch-.*\.jsonl$/u);
      expect(lastStateReply(world.replies[0])?.data).toMatchObject({ sessionFile: file });
      const tree = await waitForTurn(world.fixture, world.session, "done");
      expect(tree.messages.map((m) => ({ role: m.role, status: m.status }))).toEqual([
        { role: "user", status: "done" },
        { role: "assistant", status: "done" },
      ]);
      expect(tree.messages[0]?.content).toBe(QUESTION);
      expect(tree.messages[1]?.id).toBe(fresh);

      await settle();
      world.clock.advance(IDLE_MS);
      await waitDead(world, 0);
      await promptsAgain(world, "after regenerate", file);
      expect(world.rt.calls).toHaveLength(2);
    },
  );

  it("R2 a reclaimed session acquires one normal generation on the prompt path", REAL, async () => {
    const world = worlds.track(await openRegenWorld());
    const { db, supervisor } = world.fixture;
    seedDone(world);
    const epoch = supervisor.streamCursor(world.session).epoch;
    expect(supervisor.streamCursor(world.session)).toEqual({ epoch, seq: null });
    const live: RetainedEvent[] = [];
    const subscription = supervisor.subscribe(world.session, null, (event) => {
      live.push(event);
    });

    const { assistantMessageId } = await regenerate(world);

    expect(world.rt.calls).toHaveLength(1);
    expect(resumePath(requiredCall(world.rt.calls, 0).args)).toBe(P);
    expect(epochOf(db, world.session)).toBe(epoch + 1);
    await waitForTurn(world.fixture, world.session, "done");
    await waitFor(() => (live.some((e) => e.type === "turn.end") ? true : undefined), "turn.end");
    expect(live[0]).toMatchObject({ type: "turn.start" });
    expect(live.at(-1)).toMatchObject({
      type: "turn.end",
      data: { messageId: assistantMessageId, status: "done" },
    });
    expect(live.filter((e) => e.type === "turn.start")).toHaveLength(1);
    expect(supervisor.streamCursor(world.session).epoch).toBe(epoch + 1);
    expect(epochOf(db, world.session)).toBe(epoch + 1);
    subscription.unsubscribe();

    await settle();
    world.clock.advance(IDLE_MS);
    await waitDead(world, 0);
    expect((await sendPrompt(world, "plain prompt")).statusCode).toBe(202);
    const regenerated = requiredCall(world.rt.calls, 0);
    const prompted = requiredCall(world.rt.calls, 1);
    expect(withoutResume(prompted.args)).toEqual(withoutResume(regenerated.args));
    expect(Object.keys(prompted.env).sort()).toEqual(Object.keys(regenerated.env).sort());
    await waitForTurn(world.fixture, world.session, "done");
  });

  const gaps = [
    ["ready not yet arrived", HOLD.ready],
    ["get_branch_messages reply not yet arrived", HOLD.messages],
    ["branch reply not yet arrived", HOLD.branch],
    ["post-branch get_state reply not yet arrived", HOLD.state],
  ] as const;
  for (const [gap, hold] of gaps) {
    it(`R3 claim rejects regenerate and prompt with ${gap}`, REAL, async () => {
      const { world, db, work: original } = await heldRegenerate(hold);
      const child = spawnedAt(world, 0);
      const before = snapshot(db, world.session, true);
      const frames = child.stdin.length;
      const spawns = world.rt.calls.length;

      expect(await rejectedCode(regenerate(world))).toBe("session_busy");
      const injected = await sendPrompt(world, "injected");
      expect(injected.statusCode).toBe(409);
      expect(injected.json()).toEqual(SESSION_BUSY_ENVELOPE);
      await settle();

      expect(snapshot(db, world.session, true)).toEqual(before);
      expect(child.stdin).toHaveLength(frames);
      expect(world.rt.calls).toHaveLength(spawns);
      child.gate.release();
      const { assistantMessageId } = await original;
      const tree = await waitForTurn(world.fixture, world.session, "done");
      expect(tree.messages.at(-1)?.id).toBe(assistantMessageId);
      expect(held(world)).toBe(false);
    });
  }

  it("R4 a branch text mismatch sends no branch, changes nothing and releases", REAL, async () => {
    const world = worlds.track(await openRegenWorld({ entries: ["other"] }));
    const { db } = world.fixture;
    seedDone(world);
    const before = snapshot(db, world.session);

    expect(await rejectedCode(regenerate(world))).toBe("agent_unavailable");

    expect(types(spawnedAt(world, 0).stdin)).not.toContain("branch");
    expect(snapshot(db, world.session)).toEqual(before);
    await waitDead(world, 0);
    expect(held(world)).toBe(false);
    await promptsAgain(world, "after mismatch");
  });

  it(
    "R5 a transaction write fault is agent_unavailable and keeps rows and file",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld());
      const { db } = world.fixture;
      seedDone(world);
      db.exec(
        "CREATE TRIGGER r5_no_delete BEFORE DELETE ON chat_messages BEGIN SELECT RAISE(ABORT, 'x'); END",
      );
      const before = snapshot(db, world.session);

      expect(await rejectedCode(regenerate(world))).toBe("agent_unavailable");

      expect(snapshot(db, world.session)).toEqual(before);
      expect(sessionFile(db, world.session)).toBe(P);
      await waitDead(world, 0);
      db.exec("DROP TRIGGER r5_no_delete");
      await promptsAgain(world, "after fault");
    },
  );

  it(
    "R5b an insert fault after the delete rolls the whole CAS back on a live slot",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld());
      const { db } = world.fixture;
      await answered(world);
      const old = assistantIdFor(world.fixture, world.session);
      const file = sessionFile(db, world.session);
      const stepsOf = "SELECT COUNT(*) AS count FROM chat_steps WHERE message_id = ?";
      expect(count(db, stepsOf, old)).toBeGreaterThan(0);
      db.prepare(
        "INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at, decision, decided_at) VALUES (?, 'r5b', 'bash', 'run ls', 70, 60070, 'allow', 80)",
      ).run(old);
      db.exec(
        "CREATE TRIGGER r5b_no_insert BEFORE INSERT ON chat_messages WHEN NEW.role = 'assistant' AND NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'r5b'); END",
      );
      const before = snapshot(db, world.session, true);

      expect(await rejectedCode(regenerate(world))).toBe("agent_unavailable");

      expect(snapshot(db, world.session, true)).toEqual(before);
      expect(types(spawnedAt(world, 0).stdin)).toContain("branch");
      await waitDead(world, 0);
      expect(held(world)).toBe(false);
      db.exec("DROP TRIGGER r5b_no_insert");
      await promptsAgain(world, "after insert fault", file);
    },
  );

  const rewrites = [
    [
      "status rewritten to running",
      (db: import("node:sqlite").DatabaseSync, session: string) => {
        db.prepare("UPDATE chat_sessions SET status = 'running' WHERE id = ?").run(session);
        return () => {
          db.prepare("UPDATE chat_sessions SET status = 'done' WHERE id = ?").run(session);
        };
      },
    ],
    [
      "a newer assistant inserted",
      (db: import("node:sqlite").DatabaseSync, session: string) => {
        const inserted = db
          .prepare(
            "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'assistant', 'newer', 'done', ?)",
          )
          .run(session, Date.now() + 60_000).lastInsertRowid;
        return () => {
          db.prepare("DELETE FROM chat_messages WHERE id = ?").run(inserted);
        };
      },
    ],
  ] as const;
  for (const [name, rewrite] of rewrites) {
    it(`R6 the CAS recheck fails with ${name}: session_busy, retired, released`, REAL, async () => {
      const { world, db, work } = await heldRegenerate(HOLD.state);
      const undo = rewrite(db, world.session);
      const rewritten = snapshot(db, world.session);
      spawnedAt(world, 0).gate.release();

      expect(await rejectedCode(work)).toBe("session_busy");

      expect(snapshot(db, world.session)).toEqual(rewritten);
      await waitDead(world, 0);
      expect(held(world)).toBe(false);
      undo();
      await promptsAgain(world, "after recheck");
    });
  }

  it("R7 prechecks reject without spawn, rows or a synchronous throw", REAL, async () => {
    const world = worlds.track(await openRegenWorld());
    const { app, db, store, supervisor } = world.fixture;
    const running = world.session;
    store.acceptPrompt(running, OWNER_ID, QUESTION);
    const idle = await createSession(app, world.cookie);
    const lastUser = await createSession(app, world.cookie);
    db.prepare(
      "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'user', 'q', 'done', 1)",
    ).run(lastUser);
    db.prepare("UPDATE chat_sessions SET status = 'done' WHERE id = ?").run(lastUser);
    const foreign = await createSession(app, world.cookie);
    seedDone(world, foreign);
    const cases = [
      [running, OWNER_ID, "session_busy"],
      [idle, OWNER_ID, "bad_request"],
      [lastUser, OWNER_ID, "bad_request"],
      [foreign, "someone-else", "not_found"],
      ["f".repeat(32), OWNER_ID, "not_found"],
    ] as const;
    for (const [session, owner, code] of cases) {
      const before = snapshot(db, session, true);
      let work: Promise<unknown> = Promise.resolve();
      expect(() => {
        work = supervisor.regenerate(session, owner);
      }).not.toThrow();
      expect(await rejectedCode(work)).toBe(code);
      expect(snapshot(db, session, true)).toEqual(before);
    }
    expect(world.rt.calls).toHaveLength(0);

    await worlds.closing(world);
    let closed: Promise<unknown> = Promise.resolve();
    expect(() => {
      closed = supervisor.regenerate(foreign, OWNER_ID);
    }).not.toThrow();
    expect(await rejectedCode(closed)).toBe("agent_unavailable");
    expect(world.rt.calls).toHaveLength(0);
  });

  it("R8a stop holds the claim for exactly its call", REAL, async () => {
    const world = worlds.track(await openStopWorld("abort-ok"));
    await heldTurn(world);
    const stopping = world.fixture.supervisor.stop(world.session);
    expect(held(world)).toBe(true);
    await stopping;
    expect(held(world)).toBe(false);
  });

  it(
    "R8b a stop inside a held regenerate returns, writes nothing and keeps its claim",
    REAL,
    async () => {
      const { world, work } = await heldRegenerate(HOLD.branch);
      const child = spawnedAt(world, 0);
      const frames = child.stdin.length;

      await world.fixture.supervisor.stop(world.session);
      await settle();

      expect(child.stdin).toHaveLength(frames);
      expect(held(world)).toBe(true);
      child.gate.release();
      await work;
      expect(held(world)).toBe(false);
      await waitForTurn(world.fixture, world.session, "done");
    },
  );

  it("R8c a regenerate while a stop is in flight is session_busy", REAL, async () => {
    const world = worlds.track(await openRegenWorld());
    seedDone(world);
    const stopping = world.fixture.supervisor.stop(world.session);
    const rejected = regenerate(world);
    expect(await rejectedCode(rejected)).toBe("session_busy");
    await stopping;
    expect(held(world)).toBe(false);
    await regenerate(world);
    await waitForTurn(world.fixture, world.session, "done");
    expect(world.rt.calls).toHaveLength(1);
  });

  it("R8d a synchronous stop fault is rethrown as is and releases the claim", REAL, async () => {
    const world = worlds.track(await openRegenWorld());
    const { store, supervisor } = world.fixture;
    seedDone(world);
    vi.spyOn(store, "runtimeState").mockImplementationOnce(() => {
      throw new Error("r8d");
    });

    expect(() => supervisor.stop(world.session)).toThrow("r8d");

    expect(held(world)).toBe(false);
    expect((await sendPrompt(world, "after stop fault")).statusCode).toBe(202);
    await waitForTurn(world.fixture, world.session, "done");
  });

  it("R9 a regenerate racing idle retirement is re-admitted once", REAL, async () => {
    const world = worlds.track(await openRegenWorld({ scenario: "hang-eof" }));
    const { db } = world.fixture;
    await answered(world);
    const file = sessionFile(db, world.session);
    const epoch = epochOf(db, world.session);
    const first = spawnedAt(world, 0).child;
    world.clock.advance(IDLE_MS);
    await waitFor(() => (first.stdin.writableEnded ? true : undefined), "idle stdin EOF");
    world.rt.setScenario("branch");

    const work = regenerate(world);
    const observed = observePromise(work);
    await settle();
    expect(observed.outcome).toBe("pending");
    expect(world.rt.calls).toHaveLength(1);
    world.clock.advance(5_000);
    await work;

    expect(world.rt.calls).toHaveLength(2);
    expect(resumePath(requiredCall(world.rt.calls, 1).args)).toBe(file);
    expect(epochOf(db, world.session)).toBe(epoch + 1);
    await waitForTurn(world.fixture, world.session, "done");
  });

  it("G shutdown during a held command rejects and leaves no process", REAL, async () => {
    const { world, work } = await heldRegenerate(HOLD.messages);
    const closing = worlds.closing(world);
    spawnedAt(world, 0).gate.release();
    expect(await rejectedCode(work)).toBe("agent_unavailable");
    await expect(closing).resolves.toBeUndefined();
    expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
  });

  it("R10 shutdown before the commit keeps every row and the file", REAL, async () => {
    const { world, db, work } = await heldRegenerate(HOLD.state);
    const before = snapshot(db, world.session, true);
    let atClose: ReturnType<typeof snapshot> | undefined;
    const realClose = db.close.bind(db);
    db.close = () => {
      atClose = snapshot(db, world.session, true);
      realClose();
    };
    const child = spawnedAt(world, 0);
    const closing = worlds.closing(world);
    await waitFor(() => (child.child.stdin.writableEnded ? true : undefined), "shutdown stdin EOF");
    child.gate.release();

    expect(await rejectedCode(work)).toBe("agent_unavailable");
    await expect(closing).resolves.toBeUndefined();
    expect(atClose).toEqual(before);
    expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
  });
});

/**
 * Issue #1018 (message-attachments「带附件回合的重新生成」, chat-sessions「Branch alignment of a
 * message with attachments」): the last user message stores `uploads/a.pdf`, and the fake's last
 * branch entry is the `--branch-entry` text. Regenerate compares that pair only.
 */
describe("regenerate of a turn whose user message has attachments (#1018)", () => {
  /** A seeded done session whose user message is `content` with the attachment; its row. */
  async function attached(content: string, entry: string) {
    const world = worlds.track(await openRegenWorld({ entries: [entry] }));
    const { db } = world.fixture;
    seedDone(world);
    const user = messagesOf(db, world.session)[0]?.id ?? -1;
    attach(db, user, content);
    const row = () => db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(user);
    expect(row()).toMatchObject({ role: "user", content, attachments: A_PDF_STORED });
    return { world, db, row };
  }

  const aligned = [
    ["the text followed by the suffix", "看看这个", `看看这个${A_PDF_SUFFIX}`],
    [
      "escaped `/` text followed by the suffix",
      "/etc/hosts 是什么",
      ` /etc/hosts 是什么${A_PDF_SUFFIX}`,
    ],
    ["no text: the suffix alone", "", A_PDF_SUFFIX],
  ] as const;
  for (const [name, content, entry] of aligned) {
    it(`aligns ${name} and dispatches the branch text as it is`, REAL, async () => {
      const { world, row } = await attached(content, entry);
      const before = row();

      const { assistantMessageId } = await regenerate(world);

      const sent = spawnedAt(world, 0).stdin;
      expect(sent.filter((frame) => frame.type === "branch")).toEqual([
        expect.objectContaining({ entryId: "fake-entry-3" }),
      ]);
      expect(sent.filter((frame) => frame.type === "prompt")).toEqual([
        expect.objectContaining({ message: entry }),
      ]);
      const tree = await waitForTurn(world.fixture, world.session, "done");
      expect(tree.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(tree.messages[0]?.content).toBe(content);
      expect(tree.messages[1]?.id).toBe(assistantMessageId);
      expect(row()).toEqual(before);
    });
  }

  it(
    "aligns unescaped `/` text followed by the suffix and dispatches it escaped",
    REAL,
    async () => {
      const { world, row } = await attached(
        "/etc/hosts 是什么",
        `/etc/hosts 是什么${A_PDF_SUFFIX}`,
      );
      const before = row();

      await regenerate(world);

      expect(spawnedAt(world, 0).stdin.filter((frame) => frame.type === "prompt")).toEqual([
        expect.objectContaining({ message: ` /etc/hosts 是什么${A_PDF_SUFFIX}` }),
      ]);
      await waitForTurn(world.fixture, world.session, "done");
      expect(row()).toEqual(before);
    },
  );

  const refused = [
    ["the text alone", "看看这个", "看看这个"],
    ["the suffix alone for a message with text", "看看这个", A_PDF_SUFFIX],
    ["the suffix of other paths", "看看这个", `看看这个${A_PDF_SUFFIX}\n- uploads/b.png`],
    ["the suffix without its two leading newlines", "", A_PDF_SUFFIX.slice(2)],
    ["no text at all", "", ""],
    ["the suffix after a space", "", ` ${A_PDF_SUFFIX}`],
  ] as const;
  for (const [name, content, entry] of refused) {
    it(`an entry that is ${name} is no candidate: 502 and no row changes`, REAL, async () => {
      const { world, db } = await attached(content, entry);
      const before = snapshot(db, world.session);

      expect(await rejectedCode(regenerate(world))).toBe("agent_unavailable");

      expect(types(spawnedAt(world, 0).stdin)).not.toContain("branch");
      expect(snapshot(db, world.session)).toEqual(before);
      expect(held(world)).toBe(false);
    });
  }
});
