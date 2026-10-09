/**
 * Issue #466 fork over real fake-omp `branch` children (production createApp assembly, real
 * SQLite): the normal fork with its copied history and no generation (R1), the new session's
 * status (R2), the source process retired first at cap 1 (R3), regenerate gaps (R4) and fork gaps
 * (R5) under the claim, alignment failures (R6), prechecks (R7), a synchronous precheck fault (R8),
 * a source mid idle reclaim (R9), pid-less spawn failures (R10) and the cap invariant (G1). Oracles:
 * SQL rows, the source file's bytes and mtime, per-child stdin frames and stdout replies, spawn
 * argv/env, published events and the public supervisor surface.
 */
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { REAL, rejection, settle, spawnedAt } from "./session-approval-helpers.js";
import {
  A_PDF,
  A_PDF_STORED,
  A_PDF_SUFFIX,
  approvalsOf,
  attach,
  baseline,
  expectForkDone,
  expectForkRejected,
  expectSourceClaimed,
  FIRST,
  forkAt,
  forkWorlds,
  heldRegenerate,
  insertApproval,
  listedIds,
  messagesOf,
  openCappedWorld,
  openForkScripted,
  openForkWorld,
  realSource,
  rowCounts,
  seedTwoTurns,
  sessionRowOf,
  stepsOf,
  subscribeQuietly,
  turn,
} from "./session-fork-helpers.js";
import {
  epochOf,
  HOLD,
  held,
  heldLine,
  promptsAgain,
  QUESTION,
  regenerate,
  rejectedCode,
  scriptedAt,
  seedDone,
  sendPrompt,
  sessionFile,
  snapshot,
  types,
} from "./session-regenerate-helpers.js";
import { heldTurn, openStopWorld } from "./session-stop-helpers.js";
import {
  createSession,
  IDLE_MS,
  OWNER_ID,
  requiredCall,
  requiredToken,
  resumePath,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import {
  expectCapacity,
  expectWithinCap,
  isLive,
  presetSessionFile,
  switchSpawns,
} from "./session-supervisor-pool-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

const worlds = forkWorlds();

/** argv with the `--resume <file>` pair dropped. */
function argvBesidesResume(args: readonly string[]): string[] {
  const at = args.indexOf("--resume");
  return args.filter((_arg, index) => at === -1 || (index !== at && index !== at + 1));
}

/** The session file a child's last `get_state` response reported. */
function reportedFile(replies: readonly OmpFrame[] | undefined): unknown {
  const states = (replies ?? []).filter((f) => f.command === "get_state" && f.type === "response");
  return states.findLast(() => true)?.data;
}

/** The stdin frames a child received after its handshake (`negotiate_protocol`, `get_state`). */
function afterHandshake(frames: readonly OmpFrame[]): OmpFrame[] {
  expect(types(frames.slice(0, 2))).toEqual(["negotiate_protocol", "get_state"]);
  return frames.slice(2);
}

describe("fork over real fake-omp branch children (#466)", () => {
  it("R1 forks at u2: copies u1/a1 with steps and approvals, no generation", REAL, async () => {
    const world = worlds.track(await openForkWorld());
    const { db, supervisor } = world.fixture;
    const source = world.session;
    await turn(world, FIRST);
    await turn(world, QUESTION);
    const [u1, a1, u2] = messagesOf(db, source);
    if (u1 === undefined || a1 === undefined || u2 === undefined) {
      throw new Error("missing seeded turns");
    }
    expect(stepsOf(db, a1.id).length).toBeGreaterThan(0);
    insertApproval(db, a1.id, "r-deny", "deny", 70);
    insertApproval(db, a1.id, "r-timeout", "timeout", 90);
    const real = realSource();
    presetSessionFile(db, source, real.file);
    const received = subscribeQuietly(world);
    const before = snapshot(db, source, true);
    const events = world.events.length;
    const first = spawnedAt(world, 0);
    const sent = first.stdin.length;

    const result = await forkAt(world, u2.id);

    expect(Object.keys(result)).toEqual(["session", "draft", "attachments"]);
    expect(result.draft).toBe(QUESTION);
    expect(result.attachments).toEqual([]);
    expect(Object.keys(result.session).sort()).toEqual([
      "approvalMode",
      "archivedAt",
      "createdAt",
      "id",
      "modelId",
      "pendingApproval",
      "pinnedAt",
      "reasoningEffort",
      "scene",
      "status",
      "temporaryWorkspace",
      "title",
      "updatedAt",
      "workspaceId",
    ]);
    expect(result.session).toMatchObject({ title: FIRST, status: "done" });
    const fresh = result.session.id;
    expect(fresh).not.toBe(source);
    const row = sessionRowOf(db, fresh);
    expect(row).toMatchObject({
      owner_id: OWNER_ID,
      title: FIRST,
      status: "done",
      stream_epoch: 0,
      parent_session_id: source,
    });
    const file = String(row?.omp_session_file);
    expect(file).toMatch(/branch-.*\.jsonl$/u);
    expect(reportedFile(world.replies[1])).toMatchObject({ sessionFile: file });
    expect(supervisor.streamCursor(fresh)).toEqual({ epoch: 0, seq: null });
    const copied = messagesOf(db, fresh);
    const strip = ({ id: _id, ...rest }: { id: number }) => rest;
    expect(copied.map(strip)).toEqual([u1, a1].map(strip));
    expect(copied.some((m) => [u1.id, a1.id, u2.id].includes(m.id))).toBe(false);
    const copy = copied[1]?.id ?? -1;
    expect(stepsOf(db, copy)).toEqual(stepsOf(db, a1.id));
    const approvals = approvalsOf(db, copy) as Array<Record<string, unknown>>;
    expect(approvals).toEqual(approvalsOf(db, a1.id));
    expect(approvals.map((a) => a.decision)).toEqual(["deny", "timeout"]);
    expect(approvals.some((a) => Object.values(a).includes(null))).toBe(false);

    expect(snapshot(db, source, true)).toEqual(before);
    real.unchanged();
    expect(first.stdin).toHaveLength(sent);
    expect(isLive(first.child)).toBe(false);
    expect(received).toEqual([]);
    expect(world.events).toHaveLength(events);
    const temp = spawnedAt(world, 1);
    const frames = afterHandshake(temp.stdin);
    expect(types(frames)).toEqual(["get_branch_messages", "branch", "get_state"]);
    expect(frames[1]).toMatchObject({ type: "branch", entryId: "fake-entry-2" });
    expect(isLive(temp.child)).toBe(false);
    expect(world.liveAtSpawn[1]).toEqual([]);
    const [c0, c1] = [requiredCall(world.rt.calls, 0), requiredCall(world.rt.calls, 1)];
    expect(world.fixture.tokens.lookup(requiredToken(c1.token))).toBeNull();
    expect(argvBesidesResume(c1.args)).toEqual(argvBesidesResume(c0.args));
    expect(Object.keys(c1.env).sort()).toEqual(Object.keys(c0.env).sort());
    expect(resumePath(c1.args)).toBe(real.file);
    expect(supervisor.controlHeld(source)).toBe(false);
    expect((await listedIds(world)).sort()).toEqual([source, fresh].sort());

    expect((await sendPrompt(world, "on the fork", fresh)).statusCode).toBe(202);
    expect(resumePath(requiredCall(world.rt.calls, 2).args)).toBe(file);
    await waitForTurn(world.fixture, fresh, "done");
    expect((await sendPrompt(world, "on the source")).statusCode).toBe(202);
    expect(resumePath(requiredCall(world.rt.calls, 3).args)).toBe(real.file);
    await waitForTurn(world.fixture, source, "done");
  });

  it("R2a a fork at u1 copies nothing and is idle", REAL, async () => {
    const world = worlds.track(await openForkWorld());
    const { db } = world.fixture;
    const seeded = seedTwoTurns(world);

    const result = await forkAt(world, seeded.u1);

    expect(result.draft).toBe(FIRST);
    expect(result.session.status).toBe("idle");
    expect(messagesOf(db, result.session.id)).toEqual([]);
    expect(sessionRowOf(db, result.session.id)?.omp_session_file).toMatch(/branch-.*\.jsonl$/u);
    const frames = afterHandshake(spawnedAt(world, 0).stdin);
    expect(frames[1]).toMatchObject({ type: "branch", entryId: "fake-entry-1" });
    seeded.unchanged();
  });

  for (const status of ["stopped", "failed"] as const) {
    it(`R2b a1 ${status}: the fork is ${status} and regenerates`, REAL, async () => {
      const world = worlds.track(await openForkWorld({ entries: [FIRST] }));
      const { db } = world.fixture;
      const seeded = seedTwoTurns(world, { a1: status });

      const result = await forkAt(world, seeded.u2);

      expect(result.session.status).toBe(status);
      expect(sessionRowOf(db, result.session.id)?.status).toBe(status);
      expect(messagesOf(db, result.session.id).map((m) => m.status)).toEqual(["done", status]);
      const file = sessionFile(db, result.session.id);
      const { assistantMessageId } = await regenerate(world, result.session.id);
      expect(resumePath(requiredCall(world.rt.calls, 1).args)).toBe(file);
      const frames = afterHandshake(spawnedAt(world, 1).stdin);
      expect(frames[1]).toMatchObject({ type: "branch", entryId: "fake-entry-3" });
      const tree = await waitForTurn(world.fixture, result.session.id, "done");
      expect(tree.messages.at(-1)?.id).toBe(assistantMessageId);
    });
  }

  it("R3 at cap 1 the live source process exits before the temporary spawn", REAL, async () => {
    const world = worlds.track(await openCappedWorld(1));
    const { db, supervisor } = world.fixture;
    await turn(world, FIRST);
    await turn(world, QUESTION);
    const [u1] = messagesOf(db, world.session);
    const file = sessionFile(db, world.session);
    const epoch = epochOf(db, world.session);

    const result = await forkAt(world, u1?.id ?? -1);

    expect(supervisor.liveProcessCount()).toBe(0);
    expect(result.session.status).toBe("idle");
    expect(world.rt.calls).toHaveLength(2);
    expect(world.liveAtSpawn[1]).toEqual([]);
    expectWithinCap(world.liveAtSpawn, 1);
    await promptsAgain(world, "after fork", file, 2);
    expect(epochOf(db, world.session)).toBe(epoch + 1);
  });

  /** Each holdable RPC gap, named by the reply not yet arrived. */
  const gaps = Object.entries(HOLD);
  for (const [gap, hold] of gaps) {
    it(`R4 a fork is session_busy while a regenerate's ${gap} reply is held`, REAL, async () => {
      const { world, db, work } = await heldRegenerate(worlds, hold);
      const child = spawnedAt(world, 0);
      const [user] = messagesOf(db, world.session);
      const before = snapshot(db, world.session, true);
      const rows = rowCounts(db);
      const frames = child.stdin.length;
      const spawns = world.rt.calls.length;

      expect(await rejectedCode(forkAt(world, user?.id ?? -1))).toBe("session_busy");
      await settle();

      expect(snapshot(db, world.session, true)).toEqual(before);
      expect(rowCounts(db)).toEqual(rows);
      expect(child.stdin).toHaveLength(frames);
      expect(world.rt.calls).toHaveLength(spawns);
      child.gate.release();
      const regenerated = (await work).assistantMessageId;
      const ended = await waitForTurn(world.fixture, world.session, "done");
      expect(ended.messages.map((m) => m.id)).toContain(regenerated);
      expect(held(world)).toBe(false);
    });
  }

  for (const [gap, hold] of gaps) {
    it(`R5 the source is claimed while the fork's ${gap} reply is held`, REAL, async () => {
      const world = worlds.track(await openForkWorld({ hold }));
      const { db, supervisor } = world.fixture;
      const seeded = seedTwoTurns(world);
      const before = snapshot(db, world.session, true);
      const rows = rowCounts(db);
      const work = forkAt(world, seeded.u2);
      await heldLine(world);
      const temp = spawnedAt(world, 0);
      const frames = temp.stdin.length;
      const spawns = world.rt.calls.length;

      await expectSourceClaimed(world, seeded.u2);
      if (gap === "branch") {
        await supervisor.stop(world.session);
        expect(held(world)).toBe(true);
      }
      await settle();

      expect(snapshot(db, world.session, true)).toEqual(before);
      seeded.unchanged();
      expect(rowCounts(db)).toEqual(rows);
      expect(temp.stdin).toHaveLength(frames);
      expect(world.rt.calls).toHaveLength(spawns);
      temp.gate.release();
      await expectForkDone(world, work, rows.sessions);
    });
  }

  const misaligned = [
    ["(a) the text at the ordinal differs", ["other"], { u2Text: "other" }, "u2"],
    ["(b) the ordinal is past the list", [], { extraTurn: true }, "u3"],
  ] as const;
  for (const [name, entries, seed, target] of misaligned) {
    it(`R6 ${name}: agent_unavailable, no branch, released`, REAL, async () => {
      const world = worlds.track(await openForkWorld({ entries: [...entries] }));
      const { db } = world.fixture;
      const seeded = seedTwoTurns(world, seed);
      const before = snapshot(db, world.session, true);
      const work = forkAt(world, seeded[target]);

      await expectForkRejected(world, work, "agent_unavailable", rowCounts(db));

      expect(types(spawnedAt(world, 0).stdin)).toContain("get_branch_messages");
      expect(types(spawnedAt(world, 0).stdin)).not.toContain("branch");
      expect(snapshot(db, world.session, true)).toEqual(before);
      seeded.unchanged();
      expect(isLive(spawnedAt(world, 0).child)).toBe(false);
      await promptsAgain(world, "after mismatch", seeded.file, 1);
    });
  }

  it("R7 prechecks reject without spawn, rows or a synchronous throw", REAL, async () => {
    const world = worlds.track(await openForkWorld());
    const { app, db } = world.fixture;
    const seeded = seedTwoTurns(world);
    const other = await createSession(app, world.cookie);
    const elsewhere = seedTwoTurns(world, {}, other);
    const noFile = await createSession(app, world.cookie);
    const unfiled = seedTwoTurns(world, {}, noFile);
    db.prepare("UPDATE chat_sessions SET omp_session_file = NULL WHERE id = ?").run(noFile);
    const cases = [
      [world.session, OWNER_ID, seeded.a1, "bad_request"],
      [world.session, OWNER_ID, elsewhere.u1, "bad_request"],
      [world.session, OWNER_ID, 999_999, "bad_request"],
      [world.session, "someone-else", seeded.u1, "not_found"],
      ["f".repeat(32), OWNER_ID, seeded.u1, "not_found"],
      [noFile, OWNER_ID, unfiled.u1, "agent_unavailable"],
    ] as const;
    for (const [session, owner, messageId, code] of cases) {
      const rows = rowCounts(db);
      const before = snapshot(db, session, true);
      expect(await rejectedCode(forkAt(world, messageId, session, owner))).toBe(code);
      expect(rowCounts(db)).toEqual(rows);
      expect(snapshot(db, session, true)).toEqual(before);
      expect(held(world, session)).toBe(false);
    }
    expect(world.rt.calls).toHaveLength(0);

    await worlds.closing(world);
    expect(await rejectedCode(forkAt(world, seeded.u2))).toBe("agent_unavailable");
    expect(world.rt.calls).toHaveLength(0);
  });

  it("R7 a running source is session_busy and its process is untouched", REAL, async () => {
    const world = worlds.track(await openStopWorld("abort-ok"));
    await heldTurn(world);
    const { db } = world.fixture;
    const [user] = messagesOf(db, world.session);
    const child = spawnedAt(world, 0);
    const frames = child.stdin.length;
    const rows = rowCounts(db);

    expect(await rejectedCode(forkAt(world, user?.id ?? -1))).toBe("session_busy");
    await settle();

    expect(child.child.stdin.writableEnded).toBe(false);
    expect(child.stdin).toHaveLength(frames);
    expect(world.rt.calls).toHaveLength(1);
    expect(rowCounts(db)).toEqual(rows);
    expect(held(world)).toBe(false);
  });

  it("R8 a synchronous precheck fault is rejected as is and releases the claim", REAL, async () => {
    const world = worlds.track(await openForkWorld());
    const { store } = world.fixture;
    const seeded = seedTwoTurns(world);
    vi.spyOn(store, "getMessages").mockImplementationOnce(() => {
      throw new Error("r8");
    });

    const error = await rejection(forkAt(world, seeded.u2));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpError);
    expect((error as Error).message).toBe("r8");
    expect(held(world)).toBe(false);
    expect(world.rt.calls).toHaveLength(0);
    expect((await sendPrompt(world, "after fault")).statusCode).toBe(202);
    await waitForTurn(world.fixture, world.session, "done");
  });

  it("R9 a source mid idle reclaim exits before the temporary spawn", REAL, async () => {
    const world = worlds.track(await openForkWorld({ scenario: "hang-eof" }));
    const { db } = world.fixture;
    await turn(world, FIRST);
    await turn(world, QUESTION);
    const [, , u2] = messagesOf(db, world.session);
    const file = sessionFile(db, world.session);
    const epoch = epochOf(db, world.session);
    const reclaimed = spawnedAt(world, 0).child;
    world.clock.advance(IDLE_MS);
    await waitFor(() => (reclaimed.stdin.writableEnded ? true : undefined), "reclaim began");
    world.rt.setScenario("branch");

    const work = forkAt(world, u2?.id ?? -1);
    const pending = observePromise(work);
    await settle();
    expect([pending.outcome, world.rt.calls.length]).toEqual(["pending", 1]);
    world.clock.advance(5_000);

    expect((await work).draft).toBe(QUESTION);
    expect(world.liveAtSpawn[1]).toEqual([]);
    await promptsAgain(world, "after reclaim", file, 2);
    expect(epochOf(db, world.session)).toBe(epoch + 1);
  });

  it("R10 pid-less spawn failures release the temporary quota and token", REAL, async () => {
    const world = worlds.track(await openCappedWorld(1));
    const { db, supervisor, tokens } = world.fixture;
    const modes = switchSpawns(world.rt.runtime);
    // Outermost: sees every attempt, `throw` included, which never reaches `rt.calls`.
    const issued: Array<{ token: string; live: string | null }> = [];
    const switched = world.rt.runtime.spawnImpl;
    world.rt.runtime.spawnImpl = (command, args, options) => {
      const token = requiredToken(options.env?.WORKBUDDY_MODEL_TOKEN);
      issued.push({ token, live: tokens.lookup(token) });
      return switched(command, args, options);
    };
    const seeded = seedTwoTurns(world);
    const rows = rowCounts(db);

    for (const mode of ["missing", "throw"] as const) {
      modes.mode = mode;
      const before = issued.length;
      await expectForkRejected(world, forkAt(world, seeded.u2), "agent_unavailable", rows);
      expect(supervisor.liveProcessCount()).toBe(0);
      expect(issued).toHaveLength(before + 1);
      const attempt = issued[before];
      expect(attempt?.live).toEqual(expect.any(String));
      expect(attempt?.live).not.toBe(world.session);
      expect(tokens.lookup(attempt?.token ?? "")).toBeNull();
    }
    modes.mode = "valid";
    const result = await forkAt(world, seeded.u2);

    expect(result.draft).toBe(QUESTION);
    expect(modes.pids).toHaveLength(3);
    expect(modes.pids.slice(0, 2)).toEqual([undefined, undefined]);
    expect(rowCounts(db).sessions).toBe(rows.sessions + 1);
  });

  it("G1 cap 2 holds across concurrent prompts, a regenerate and a fork", REAL, async () => {
    const world = worlds.track(await openCappedWorld(2, true));
    const { app, db, supervisor } = world.fixture;
    const s3 = await createSession(app, world.cookie);
    const s4 = await createSession(app, world.cookie);
    const s2 = await createSession(app, world.cookie);
    seedDone(world, s3);
    const seeded = seedTwoTurns(world, {}, s4);
    const sessions = rowCounts(db).sessions;
    const seen: number[] = [];
    const capacity = (): "capacity" => {
      seen.push(supervisor.liveProcessCount());
      return "capacity";
    };

    const prompts = [world.session, s2].map((session) =>
      sendPrompt(world, "hold", session).then((response) => {
        if (response.statusCode === 503) {
          expectCapacity(response);
          return capacity();
        }
        expect(response.statusCode).toBe(202);
        return "ok";
      }),
    );
    const controls = [regenerate(world, s3), forkAt(world, seeded.u2, s4)].map((work) =>
      (work as Promise<unknown>).then(
        () => "ok",
        (error: unknown) => {
          if (error instanceof HttpError && error.code === "agent_capacity") {
            return capacity();
          }
          throw error;
        },
      ),
    );
    const outcomes = await Promise.all([...prompts, ...controls]);

    expect(outcomes.every((o) => o === "ok" || o === "capacity")).toBe(true);
    expect(seen.every((count) => count === 2)).toBe(true);
    expectWithinCap(world.liveAtSpawn, 2);
    expect(rowCounts(db).sessions).toBe(sessions + (outcomes[3] === "ok" ? 1 : 0));
  });
});

/**
 * Issue #1018 (message-attachments「分叉拷贝与回填」, chat-sessions「Branch alignment of a message
 * with attachments」): the entry list is the scripted child's, so the entry of a message with an
 * attachment can be anywhere in it. The scripted `branch` always answers QUESTION: a `draft` that
 * is anything else was read from the stored row, and so were the `attachments` beside it (#1019,
 * turn-control「分叉点消息的附件随响应返回」).
 */
describe("fork alignment of messages with attachments (#1018)", () => {
  const entries = (first: string, second: string) => [
    { entryId: "e-1", text: first },
    { entryId: "e-2", text: second },
  ];

  /** FIRST → QUESTION seeded, then `uploads/a.pdf` stored on one of the two user messages. */
  async function attached(
    messages: ReturnType<typeof entries>,
    target: "u1" | "u2",
    content?: string,
  ) {
    const world = await openForkScripted(worlds, [{ messages }]);
    const { db } = world.fixture;
    const seeded = seedTwoTurns(world);
    attach(db, seeded[target], content);
    return { world, db, seeded };
  }

  /** The fork at `messageId`: its draft and attachments, exact keys, the entry `branch` named. */
  async function forked(world: Awaited<ReturnType<typeof attached>>["world"], messageId: number) {
    const spawned = world.rt.calls.length;
    const result = await forkAt(world, messageId);
    expect(Object.keys(result)).toEqual(["session", "draft", "attachments"]);
    const frames = scriptedAt(world.scripted, spawned).frames;
    const branch = frames.filter((frame) => frame.type === "branch").map((frame) => frame.entryId);
    return { draft: result.draft, attachments: result.attachments, branch };
  }

  it.each([
    ["the text followed by the suffix", FIRST, `${FIRST}${A_PDF_SUFFIX}`],
    [
      "escaped `/` text followed by the suffix",
      "/etc/hosts 是什么",
      ` /etc/hosts 是什么${A_PDF_SUFFIX}`,
    ],
    [
      "unescaped `/` text followed by the suffix",
      "/etc/hosts 是什么",
      `/etc/hosts 是什么${A_PDF_SUFFIX}`,
    ],
    ["no text: the suffix alone", "", A_PDF_SUFFIX],
  ])(
    "aligns %s, and the message after it; the draft is the stored text",
    async (_n, text, entry) => {
      const { world, db, seeded } = await attached(entries(entry, QUESTION), "u1", text);
      const before = snapshot(db, world.session, true);

      expect(await forked(world, seeded.u2)).toEqual({
        draft: QUESTION,
        attachments: [],
        branch: ["e-2"],
      });
      expect(await forked(world, seeded.u1)).toEqual({
        draft: text,
        attachments: [A_PDF],
        branch: ["e-1"],
      });

      expect(snapshot(db, world.session, true)).toEqual(before);
      expect(messagesOf(db, world.session)[0]).toMatchObject({ id: seeded.u1, content: text });
      expect(
        db.prepare("SELECT attachments FROM chat_messages WHERE id = ?").get(seeded.u1),
      ).toEqual({ attachments: A_PDF_STORED });
    },
  );

  it("aligns an attachment-only message that is not the first: its draft is empty", async () => {
    const { world, seeded } = await attached(entries(FIRST, A_PDF_SUFFIX), "u2", "");

    expect(await forked(world, seeded.u2)).toEqual({
      draft: "",
      attachments: [A_PDF],
      branch: ["e-2"],
    });
    expect(await forked(world, seeded.u1)).toEqual({
      draft: FIRST,
      attachments: [],
      branch: ["e-1"],
    });
  });

  // message-attachments「分叉拷贝与回填」: both lists written by the admission itself.
  it.each([
    ["a message with text", QUESTION],
    ["an attachment-only message", ""],
  ])(
    "a fork at %s answers its stored list; the copy before it keeps its column",
    async (_n, text) => {
      const bPng = { path: "uploads/b.png", size: 5 };
      const bPngSuffix =
        "\n\n用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：\n- uploads/b.png";
      const world = await openForkScripted(worlds, [
        { messages: entries(`${FIRST}${A_PDF_SUFFIX}`, `${text}${bPngSuffix}`) },
      ]);
      const { db, store } = world.fixture;
      const [u1, u2] = [[FIRST, A_PDF] as const, [text, bPng] as const].map(
        ([content, attachment]) => {
          const accepted = store.acceptPrompt(world.session, OWNER_ID, content, [attachment]);
          store.finishTurn(accepted.assistantMessageId, "done");
          return accepted.userMessageId;
        },
      );
      presetSessionFile(db, world.session, realSource().file);
      const before = snapshot(db, world.session, true);

      const result = await forked(world, u2 ?? -1);

      expect(result).toEqual({ draft: text, attachments: [bPng], branch: ["e-2"] });
      const fresh = String(
        db.prepare("SELECT id FROM chat_sessions WHERE parent_session_id = ?").get(world.session)
          ?.id,
      );
      expect(
        db
          .prepare(
            "SELECT role, attachments, typeof(attachments) AS type FROM chat_messages WHERE session_id = ? ORDER BY id",
          )
          .all(fresh),
      ).toEqual([
        { role: "user", attachments: A_PDF_STORED, type: "text" },
        { role: "assistant", attachments: null, type: "null" },
      ]);
      const copied = store.getMessages(fresh, OWNER_ID)?.messages;
      expect(copied?.map((message) => message.attachments)).toEqual([[A_PDF], []]);
      expect(snapshot(db, world.session, true)).toEqual(before);
      expect((await forked(world, u1 ?? -1)).attachments).toEqual([A_PDF]);
    },
  );

  it.each([
    ["the text alone", undefined, FIRST],
    ["the suffix without its two leading newlines", "", A_PDF_SUFFIX.slice(2)],
  ])(
    "an entry that is %s aligns neither that message nor the one after it: 502",
    async (_n, text, entry) => {
      const { world, db, seeded } = await attached(entries(entry, QUESTION), "u1", text);
      const { before, rows } = baseline(world);

      for (const target of [seeded.u2, seeded.u1]) {
        const spawned = world.rt.calls.length;
        await expectForkRejected(world, forkAt(world, target), "agent_unavailable", rows);
        const frames = types(scriptedAt(world.scripted, spawned).frames);
        expect(frames).toContain("get_branch_messages");
        expect(frames).not.toContain("branch");
      }
      expect(snapshot(db, world.session, true)).toEqual(before);
    },
  );
});
