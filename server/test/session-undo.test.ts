/**
 * Issue #951 undo endpoint, `files:"keep"` only (s1f-session-list-temp-space tasks 11.4–11.6) on
 * the production createApp → registerSessions assembly. Undo is only ever requested over REST
 * (inject, a real socket for the parser-owner boundary, a real listener for the list event
 * connection). Real fake-omp `branch` children where the spec names them (the branch entry, the new
 * session file, the RPC gaps, the cap on real children); scripted FakeChild processes for exits,
 * the shutdown gap, the pool and shutdown.
 *
 * Specs: message-undo「撤回 REST」「对话原地回退」「撤回审计与通知」, session-metadata「归档后只读」
 * 「撤回持有占用时删除被拒」, turn-control「撤回各 RPC 间隙的并发请求」, omp-pool (the three undo
 * scenarios), session-list-push「撤回发两种事件」.
 */
import type { DatabaseSync } from "node:sqlite";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { withListeningApp } from "./raw-http-helpers.js";
import { REAL, settle, spawnedAt } from "./session-approval-helpers.js";
import { patch } from "./session-archive-helpers.js";
import {
  type BodyInput,
  EMPTY_JSON,
  expectEnvelope,
  MALFORMED_JSON,
  OCTET,
  onWire,
  PRE_PARSER_BODIES,
  postSessionAction,
  wireSessionAction,
} from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  INTERNAL_ERROR_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import {
  FIRST,
  forkWorlds,
  insertApproval,
  messagesOf,
  openCappedWorld,
  openForkScripted,
  openForkWorld,
  seedTwoTurns,
  sessionRowOf,
  subscribeQuietly,
  turn,
} from "./session-fork-helpers.js";
import { closeListening } from "./session-list-events-helpers.js";
import {
  epochOf,
  HOLD,
  held,
  heldLine,
  promptsAgain,
  QUESTION,
  scriptedAt,
  sendPrompt,
  sessionFile,
  types,
} from "./session-regenerate-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  SESSION_ARCHIVED_ENVELOPE,
  SESSION_BUSY_ENVELOPE,
  UNKNOWN_SESSION_ID,
} from "./session-rest-helpers.js";
import {
  completeHeldTurn,
  createSession,
  expectSettled,
  OWNER_ID,
  requiredCall,
  resumePath,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { expectCapacity, expectWithinCap, isLive } from "./session-supervisor-pool-helpers.js";
import {
  expectClaimed,
  framesSince,
  heldBranch,
  historyOf,
  lastStateFile,
  listFrom,
  observed,
  openListeningScripted,
  postUndo,
  register,
  rewoundFrame,
  seededSession,
  seedUndoable,
  THIRD,
  tempClosing,
  type UndoWorld,
  undoBody,
  undone,
  withoutChanged,
} from "./session-undo-helpers.js";

const ROUTE = "/api/sessions/:id/undo";
const T1 = { phases: [{ name: "准备", tasks: [{ content: "读取需求", status: "in_progress" }] }] };
const T2 = { phases: [{ name: "收尾", tasks: [{ content: "写总结", status: "pending" }] }] };

const worlds = forkWorlds();
afterEach(closeListening);

function setSession(db: DatabaseSync, session: string, assignment: string, value: unknown): void {
  db.prepare(`UPDATE chat_sessions SET ${assignment} WHERE id = ?`).run(
    value as string | number | null,
    session,
  );
}

/** A failed undo spawned at most its temporary process and changed nothing else. */
function expectOnlySpawned(
  world: UndoWorld,
  before: ReturnType<typeof observed>,
  spawned: number,
): void {
  expect(observed(world)).toEqual({ ...before, spawns: before.spawns + spawned });
  expect(held(world)).toBe(false);
  expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
}

describe("undo REST: shape, owner and prechecks", () => {
  it("形状与鉴权: every non-conforming body is 400 with nothing written; restore and force are 400 for now", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { u2 } = seedUndoable(world);
    const raw = (payload: string, contentType = "application/json"): BodyInput => ({
      name: payload,
      payload,
      contentType,
    });
    const bodies = [
      raw("{}"),
      raw(JSON.stringify({ messageId: u2 })),
      raw(JSON.stringify({ files: "keep" })),
      undoBody(String(u2), "restore"),
      undoBody(u2, "yes"),
      undoBody(u2, "keep", { x: 1 }),
      undoBody(u2 + 0.5),
      undoBody(2 ** 53),
      undoBody(0),
      undoBody(null),
      raw("[]"),
      raw(JSON.stringify([{ messageId: u2, files: "keep" }])),
      MALFORMED_JSON,
      raw(JSON.stringify({ messageId: u2, files: "keep" }), "text/plain"),
      // Well-formed, and refused until the file restore lands (task 12.1).
      undoBody(u2, "restore"),
      undoBody(u2, "force"),
    ];
    const before = observed(world);

    for (const body of bodies) {
      const response = await postSessionAction(
        world.fixture.app,
        "undo",
        world.session,
        world.cookie,
        body,
      );
      expect([body.name, response.statusCode, response.json()]).toEqual([
        body.name,
        400,
        BAD_REQUEST_ENVELOPE,
      ]);
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    expect(observed(world)).toEqual(before);
    expect([world.rt.calls.length, held(world)]).toEqual([0, false]);
  });

  it("形状与鉴权: 401 and the identical 404 come before the body is parsed", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { u2 } = seedUndoable(world);
    const foreign = await cookieFor(world.fixture.app, "zhaoliu");
    const before = observed(world);
    const targets = [
      [world.session, null, 401, UNAUTHORIZED_ENVELOPE],
      [world.session, foreign, 404, NOT_FOUND_ENVELOPE],
      [UNKNOWN_SESSION_ID, world.cookie, 404, NOT_FOUND_ENVELOPE],
    ] as const;

    for (const [session, cookie, status, envelope] of targets) {
      for (const body of [undoBody(u2), ...PRE_PARSER_BODIES]) {
        expectEnvelope(
          await postSessionAction(world.fixture.app, "undo", session, cookie, body),
          status,
          envelope,
        );
      }
    }

    expect(observed(world)).toEqual(before);
    expect(world.rt.calls).toHaveLength(0);
  });

  it("the four content-parser failures on one's own session are owned 400s on the wire; then 200", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { u2 } = seedUndoable(world);
    const valid = undoBody(u2);
    const parserFailures: BodyInput[] = [
      MALFORMED_JSON,
      EMPTY_JSON,
      OCTET,
      { ...valid, name: "padded past 1 KiB", payload: `${valid.payload}${" ".repeat(1_100)}` },
    ];
    const before = observed(world);

    await withListeningApp(world.fixture.app, async (origin) => {
      for (const body of parserFailures) {
        expect({
          body: body.name,
          ...(await wireSessionAction(origin, "undo", world.session, world.cookie, body)),
        }).toEqual({ body: body.name, ...onWire(400, JSON.stringify(BAD_REQUEST_ENVELOPE)) });
      }
      expect(observed(world)).toEqual(before);
      expect(world.fixture.app.hasRoute({ method: "POST", url: ROUTE })).toBe(true);

      const accepted = await wireSessionAction(origin, "undo", world.session, world.cookie, valid);
      expect({ ...accepted, text: "" }).toEqual(onWire(200, ""));
      expect(JSON.parse(accepted.text)).toMatchObject({ draft: QUESTION });
    });
  });

  it("前置校验的各拒绝: each refusal in the spec's order, no row, no frame, no process", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { db, store } = world.fixture;
    const elsewhere = seedUndoable(world);
    type Target = { session: string; messageId: number };
    const seeded = async (prepare: (target: Target & { a2: number }) => void = () => {}) => {
      const target = await seededSession(world);
      prepare({ session: target.session, messageId: target.u2, a2: target.a2 });
      return { session: target.session, messageId: target.u2, a2: target.a2 };
    };
    /** A bound session whose u2 carries this registration (none at all for `none`). */
    const registered = async (outcome: "command" | "too_large" | "failed" | "none") => {
      const session = await createSession(world.fixture.app, world.cookie);
      const turns = seedTwoTurns(world, {}, session);
      register(db, session, turns.u1);
      if (outcome !== "none") {
        register(db, session, turns.u2, outcome);
      }
      return { session, messageId: turns.u2 };
    };
    const running = (target: Target) => {
      store.acceptPrompt(target.session, OWNER_ID, "still running");
    };
    const noFile = (target: Target) => {
      setSession(db, target.session, "omp_session_file = ?", null);
    };
    const cases: Array<[string, () => Promise<Target>, number, object]> = [
      [
        "archived",
        async () => {
          const target = await seeded();
          expect((await patch(world, { archived: true }, target)).statusCode).toBe(200);
          return target;
        },
        409,
        SESSION_ARCHIVED_ENVELOPE,
      ],
      [
        "archived and running: the archive comes first",
        () =>
          seeded((target) => {
            running(target);
            setSession(db, target.session, "archived_at = ?", 5);
          }),
        409,
        SESSION_ARCHIVED_ENVELOPE,
      ],
      ["a turn in progress", () => seeded(running), 409, SESSION_BUSY_ENVELOPE],
      [
        "a turn in progress and a message that is no user message: busy comes first",
        async () => {
          const target = await seeded(running);
          return { session: target.session, messageId: target.a2 };
        },
        409,
        SESSION_BUSY_ENVELOPE,
      ],
      [
        "an assistant message",
        async () => {
          const target = await seeded();
          return { session: target.session, messageId: target.a2 };
        },
        400,
        BAD_REQUEST_ENVELOPE,
      ],
      [
        "another session's user message",
        async () => ({ session: (await seeded()).session, messageId: elsewhere.u2 }),
        400,
        BAD_REQUEST_ENVELOPE,
      ],
      [
        "an id that is no message",
        async () => ({ session: (await seeded()).session, messageId: 999_999 }),
        400,
        BAD_REQUEST_ENVELOPE,
      ],
      ["undo command", () => registered("command"), 400, BAD_REQUEST_ENVELOPE],
      ["undo too_large", () => registered("too_large"), 400, BAD_REQUEST_ENVELOPE],
      ["undo failed", () => registered("failed"), 400, BAD_REQUEST_ENVELOPE],
      ["undo none", () => registered("none"), 400, BAD_REQUEST_ENVELOPE],
      [
        "a legacy session bound to no workspace (unbound)",
        async () => {
          const session = await createSession(world.fixture.app, world.cookie);
          const turns = seedTwoTurns(world, {}, session);
          setSession(db, session, "workspace_id = ?", null);
          return { session, messageId: turns.u2 };
        },
        400,
        BAD_REQUEST_ENVELOPE,
      ],
      [
        "not undoable and no session file: the undo state comes first",
        async () => {
          const target = await registered("failed");
          noFile(target);
          return target;
        },
        400,
        BAD_REQUEST_ENVELOPE,
      ],
      ["no omp session file", () => seeded(noFile), 502, AGENT_UNAVAILABLE_ENVELOPE],
    ];

    for (const [name, prepare, status, envelope] of cases) {
      const { session, messageId } = await prepare();
      const before = observed(world, session);
      const response = await postUndo(world, messageId, session);
      expect([name, response.statusCode, response.json()]).toEqual([name, status, envelope]);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect([name, observed(world, session)]).toEqual([name, before]);
      expect([name, held(world, session)]).toEqual([name, false]);
    }
    expect(world.rt.calls).toHaveLength(0);
  });

  it("前置校验的各拒绝: a regenerate holding the claim is 409; archived while held is still session_archived", async () => {
    const world = await openForkScripted(worlds, [{ hold: "branch" }, {}]);
    const { app, db, supervisor } = world.fixture;
    const { u2 } = seedUndoable(world);
    const regenerating = Promise.resolve(
      postSessionAction(app, "regenerate", world.session, world.cookie),
    );
    const child = await heldBranch(world);
    const before = observed(world);

    expectEnvelope(await postUndo(world, u2), 409, SESSION_BUSY_ENVELOPE);

    expect(observed(world)).toEqual(before);
    child.release?.();
    expect((await regenerating).statusCode).toBe(202);
    await waitForTurn(world.fixture, world.session, "done");
    await settle();

    // Archiving is refused while a claim is held, so the session is archived first.
    const archived = await seededSession(world);
    expect((await patch(world, { archived: true }, archived)).statusCode).toBe(200);
    const release = supervisor.holdControl(archived.session);
    try {
      const rows = observed(world, archived.session);
      expectEnvelope(
        await postUndo(world, archived.u2, archived.session),
        409,
        SESSION_ARCHIVED_ENVELOPE,
      );
      expect(observed(world, archived.session)).toEqual(rows);
    } finally {
      release();
    }
    expect(sessionFile(db, archived.session)).toBe(archived.file);
  });
});

describe("undo in place on real fake-omp branch children", () => {
  it(
    "撤回中间的一条: 200 {session, draft, files}, u1 and a1 left as they were, the session on the branch file",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld({ entries: [THIRD] }));
      const { app, db, supervisor } = world.fixture;
      const source = world.session;
      await turn(world, FIRST);
      await turn(world, QUESTION);
      await turn(world, THIRD);
      const [u1, a1, u2] = messagesOf(db, source);
      if (u1 === undefined || a1 === undefined || u2 === undefined) {
        throw new Error("missing seeded turns");
      }
      insertApproval(db, a1.id, "r-allow", "allow", 70);
      const original = await historyOf(world);
      expect(original.messages.map((m) => [m.role, m.undo])).toEqual([
        ["user", "available"],
        ["assistant", null],
        ["user", "available"],
        ["assistant", null],
        ["user", "available"],
        ["assistant", null],
      ]);
      expect(original.messages[1]).toMatchObject({ id: a1.id, approvals: [{ decision: "allow" }] });
      expect(original.messages[1]?.steps).not.toEqual([]);
      const row = sessionRowOf(db, source);
      const epoch = epochOf(db, source);
      const first = spawnedAt(world, 0);
      expect(isLive(first.child)).toBe(true);
      subscribeQuietly(world);
      const response = await postUndo(world, u2.id);

      // The session's own process had exited before the temporary one was spawned.
      expect(world.liveAtSpawn[1]).toEqual([]);
      // Read at the 200, before anything else runs: the per-session stream was ended.
      expect(supervisor.sessionStreamSubscriberCount(source)).toBe(0);
      const body = undone(response);
      expect(body.draft).toBe(QUESTION);
      const after = await historyOf(world);
      expect(after.messages).toEqual(original.messages.slice(0, 2));
      expect(after.session).toEqual(body.session);
      expect(body.session).toMatchObject({ id: source, status: "done", title: FIRST });
      expect(body.session.updatedAt).toBeGreaterThanOrEqual(Number(original.session.updatedAt));

      const temp = spawnedAt(world, 1);
      const branched = lastStateFile(world.replies[1]);
      expect(String(branched)).toMatch(/branch-.*\.jsonl$/u);
      expect(sessionRowOf(db, source)).toEqual({ ...row, omp_session_file: branched });
      expect(epochOf(db, source)).toBe(epoch);
      expect(types(temp.stdin.slice(2))).toEqual(["get_branch_messages", "branch", "get_state"]);
      expect(temp.stdin[3]).toMatchObject({ type: "branch", entryId: "fake-entry-2" });
      expect([isLive(first.child), isLive(temp.child)]).toEqual([false, false]);
      expect([world.rt.calls.length, held(world)]).toEqual([2, false]);

      const audit = await app.inject({
        method: "GET",
        url: "/api/audit?limit=1",
        headers: { cookie: world.cookie },
      });
      expect((audit.json() as { events: unknown[] }).events).toEqual([
        expect.objectContaining({
          kind: "session.undo",
          actorId: OWNER_ID,
          title: "撤回消息",
          detail: { sessionId: source, messageId: u2.id, removedMessages: 4, files: "keep" },
        }),
      ]);
    },
  );

  it(
    "撤回第一条: an empty idle session with its title, and the next prompt resumes the branch file",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const { db } = world.fixture;
      const seeded = seedUndoable(world);
      const title = sessionRowOf(db, world.session)?.title;

      const body = undone(await postUndo(world, seeded.u1));

      expect([body.draft, body.session.status, body.session.title]).toEqual([FIRST, "idle", title]);
      expect((await historyOf(world)).messages).toEqual([]);
      const branched = lastStateFile(world.replies[0]);
      expect(String(branched)).toMatch(/branch-.*\.jsonl$/u);
      seeded.unchanged();

      expect((await sendPrompt(world, "after the undo")).statusCode).toBe(202);
      // 随后的 prompt 以 `--resume <新文件>` 启动: the file the temporary process's get_state named.
      expect(resumePath(requiredCall(world.rt.calls, 1).args)).toBe(branched);
      await waitForTurn(world.fixture, world.session, "done");
    },
  );

  /** turn-control「撤回各 RPC 间隙的并发请求」: the temporary child's stdout is held at each gap. */
  const gaps = [
    ["ready not yet arrived", HOLD.ready],
    ["get_branch_messages reply not yet arrived", HOLD.messages],
    ["branch reply not yet arrived", HOLD.branch],
    ["get_state reply not yet arrived", HOLD.state],
  ] as const;
  for (const [gap, hold] of gaps) {
    it(
      `撤回期间的并发请求: prompt, regenerate, fork, undo, archive and DELETE are 409 with ${gap}`,
      REAL,
      async () => {
        const world = worlds.track(await openForkWorld({ hold }));
        const seeded = seedUndoable(world);
        const work = Promise.resolve(postUndo(world, seeded.u2));
        await heldLine(world);
        const temp = spawnedAt(world, 0);
        const before = { rows: observed(world), frames: temp.stdin.length };

        await expectClaimed(world, seeded.u2);
        await settle();

        expect({ rows: observed(world), frames: temp.stdin.length }).toEqual(before);
        seeded.unchanged();
        temp.gate.release();
        expect(undone(await work).draft).toBe(QUESTION);
        expect([held(world), isLive(temp.child)]).toEqual([false, false]);
        expect((await sendPrompt(world, "after the undo")).statusCode).toBe(202);
        await waitForTurn(world.fixture, world.session, "done");
      },
    );
  }

  it(
    "撤回先退回本会话进程: at cap 1 the session's own process exits first, no 503",
    REAL,
    async () => {
      const world = worlds.track(await openCappedWorld(1));
      const { supervisor } = world.fixture;
      await turn(world, FIRST);
      await turn(world, QUESTION);
      const [u1] = messagesOf(world.fixture.db, world.session);
      expect(supervisor.liveProcessCount()).toBe(1);

      const body = undone(await postUndo(world, u1?.id ?? -1));

      expect(body.session.status).toBe("idle");
      expect(supervisor.liveProcessCount()).toBe(0);
      expect(world.rt.calls).toHaveLength(2);
      expect(world.liveAtSpawn[1]).toEqual([]);
      expectWithinCap(world.liveAtSpawn, 1);
    },
  );
});

describe("undo over scripted FakeChild processes", () => {
  for (const status of ["stopped", "failed"] as const) {
    it(`剩余历史的状态: a1 ${status} leaves the session ${status}`, async () => {
      const world = await openForkScripted(worlds, [{}]);
      const seeded = seedUndoable(world, { a1: status });

      expect(undone(await postUndo(world, seeded.u2)).session.status).toBe(status);

      const history = await historyOf(world);
      expect(history.session.status).toBe(status);
      expect(history.messages.map((m) => m.id)).toEqual([seeded.u1, seeded.a1]);
    });
  }

  it("任务清单回到当时: the list u2 was accepted with comes back, a null one included", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { db } = world.fixture;
    for (const [stored, expected] of [
      [JSON.stringify(T1), T1],
      [null, null],
    ] as const) {
      const session = await createSession(world.fixture.app, world.cookie);
      const turns = seedTwoTurns(world, {}, session);
      register(db, session, turns.u2, "ok", stored);
      setSession(db, session, "todo = ?", JSON.stringify(T2));
      expect((await historyOf(world, session)).todo).toEqual(T2);

      undone(await postUndo(world, turns.u2, session));

      expect((await historyOf(world, session)).todo).toEqual(expected);
    }
  });

  it("撤回发两种事件: one session.rewound for the session and at least one sessions.changed", async () => {
    const world = await openListeningScripted([{}]);
    const seeded = seedUndoable(world);
    const { client, mark } = await listFrom(world);

    undone(await postUndo(world, seeded.u2));

    const { rest, changed } = withoutChanged(await framesSince(world, client, mark));
    expect(rest).toBe(rewoundFrame(world.session));
    expect(changed).toBeGreaterThanOrEqual(1);
  });

  it("对位失败: no entry for the message is 502 with no branch, nothing changed and no list event", async () => {
    const world = await openListeningScripted([
      { messages: [{ entryId: "fake-entry-1", text: "another question" }] },
      {},
    ]);
    const seeded = seedUndoable(world);
    const { client, mark } = await listFrom(world);
    const before = observed(world);

    expectEnvelope(await postUndo(world, seeded.u2), 502, AGENT_UNAVAILABLE_ENVELOPE);

    const temp = scriptedAt(world.scripted, 0);
    expect(types(temp.frames)).toContain("get_branch_messages");
    expect(types(temp.frames)).not.toContain("branch");
    expect(isLive(temp.child)).toBe(false);
    expectOnlySpawned(world, before, 1);
    seeded.unchanged();
    expect(await framesSince(world, client, mark)).toBe("");
    await promptsAgain(world, "after the failure", seeded.file, 1);
  });

  it("进程失败: an exit after the branch reply is 502 with nothing changed; a branch onto the same file too", async () => {
    const world = await openForkScripted(worlds, [{ exitAfterBranch: true }, {}]);
    const { db } = world.fixture;
    const seeded = seedUndoable(world);
    const before = observed(world);

    expectEnvelope(await postUndo(world, seeded.u2), 502, AGENT_UNAVAILABLE_ENVELOPE);

    const temp = scriptedAt(world.scripted, 0);
    expect(types(temp.frames)).toContain("branch");
    expect(isLive(temp.child)).toBe(false);
    expectOnlySpawned(world, before, 1);
    seeded.unchanged();

    // The scripted child names one fixed file after every branch: once the session is on it, a
    // second branch would leave the session where it is, and nothing is committed.
    undone(await postUndo(world, seeded.u2));
    const onBranch = observed(world);
    expectEnvelope(await postUndo(world, seeded.u1), 502, AGENT_UNAVAILABLE_ENVELOPE);
    expectOnlySpawned(world, onBranch, 1);
    await promptsAgain(world, "after the failure", sessionFile(db, world.session), 3);
  });

  it("最终事务复核失败: the session set running before the commit is 409 with no row deleted and no list event", async () => {
    const world = await openListeningScripted([{ keepStdout: true }, {}]);
    const { db } = world.fixture;
    const seeded = seedUndoable(world);
    const { client, mark } = await listFrom(world);
    const work = Promise.resolve(postUndo(world, seeded.u2));
    // After the get_state reply: the temporary process is closing, the commit has not run.
    const temp = await tempClosing(world);
    setSession(db, world.session, "status = ?", "running");
    const rewritten = observed(world);
    temp.endStdout();
    temp.exit(0);

    expectEnvelope(await work, 409, SESSION_BUSY_ENVELOPE);

    expectOnlySpawned(world, rewritten, 0);
    expect(sessionFile(db, world.session)).toBe(seeded.file);
    expect(messagesOf(db, world.session)).toHaveLength(4);
    expect(await framesSince(world, client, mark)).toBe("");
    setSession(db, world.session, "status = ?", "done");
    await promptsAgain(world, "after the recheck", seeded.file, 1);
  });

  it("撤回期间的并发请求: the same six are 409 while the temporary process shuts down, before the commit", async () => {
    const world = await openForkScripted(worlds, [{ keepStdout: true }, {}]);
    const seeded = seedUndoable(world);
    const work = Promise.resolve(postUndo(world, seeded.u2));
    const temp = await tempClosing(world);
    const before = observed(world);

    await expectClaimed(world, seeded.u2);
    await settle();

    expect(observed(world)).toEqual(before);
    temp.endStdout();
    temp.exit(0);
    expect(undone(await work).draft).toBe(QUESTION);
    expect(held(world)).toBe(false);
    await promptsAgain(world, "after the undo", sessionFile(world.fixture.db, world.session), 1);
  });

  it("审计失败则不回退: a failing audit write is the generic 5xx and rolls the undo back", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const seeded = seedUndoable(world);
    world.fixture.db.exec(
      "CREATE TRIGGER undo_audit_down BEFORE INSERT ON audit_events WHEN NEW.kind = 'session.undo' BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    const before = observed(world);

    expectEnvelope(await postUndo(world, seeded.u2), 500, INTERNAL_ERROR_ENVELOPE);

    expectOnlySpawned(world, before, 1);
  });

  it("撤回的临时进程计入上限: at cap 1 another session's prompt is 503 while the undo branches", async () => {
    const world = await openForkScripted(worlds, [{ hold: "branch" }, {}], 1);
    const { app, supervisor } = world.fixture;
    const other = await createSession(app, world.cookie);
    const seeded = seedUndoable(world);
    const work = Promise.resolve(postUndo(world, seeded.u2));
    const temp = await heldBranch(world);

    expectCapacity(await sendPrompt(world, "b", other));

    expect([temp.child.stdin.writableEnded, temp.child.signalCode]).toEqual([false, null]);
    expect(world.rt.calls).toHaveLength(1);
    temp.release?.();
    undone(await work);
    expect(supervisor.liveProcessCount()).toBe(0);
    expect((await sendPrompt(world, "b again", other)).statusCode).toBe(202);
    expect(world.rt.calls).toHaveLength(2);
    await waitForTurn(world.fixture, other, "done");
  });

  it("撤回遇池满: 503 agent_capacity with no spawn and the claim released; then the prompt resumes the old file", async () => {
    const world = await openForkScripted(worlds, [{ prompt: "hold" }, {}], 1);
    const { app } = world.fixture;
    const other = await createSession(app, world.cookie);
    expect((await sendPrompt(world, "b holds", other)).statusCode).toBe(202);
    const seeded = seedUndoable(world);
    const b = scriptedAt(world.scripted, 0).child;
    const before = observed(world);

    expectCapacity(await postUndo(world, seeded.u2));

    expect(observed(world)).toEqual(before);
    seeded.unchanged();
    expect([b.stdin.writableEnded, b.signalCode]).toEqual([false, null]);
    // The claim is free before B's turn ends; only then can A's prompt be admitted at cap 1.
    expect(held(world)).toBe(false);
    completeHeldTurn(b);
    await waitForTurn(world.fixture, other, "done");
    await settle();
    await promptsAgain(world, "after the full pool", seeded.file, 1);
  });

  it("关停时在途撤回的临时进程被收掉: shutdown reaps the temporary process and the undo is 502", async () => {
    const world = await openForkScripted(worlds, [{ hold: "branch" }]);
    const { db, supervisor } = world.fixture;
    const seeded = seedUndoable(world);
    const atClose: { messages?: number; file?: string | null } = {};
    const close = db.close.bind(db);
    db.close = () => {
      atClose.messages = messagesOf(db, world.session).length;
      atClose.file = sessionFile(db, world.session);
      close();
    };
    const work: Promise<LightMyRequestResponse> = Promise.resolve(postUndo(world, seeded.u2));
    const temp = await heldBranch(world);

    const closing = worlds.closing(world);
    try {
      await expectSettled(
        closing,
        "shutdown with a held undo temporary process",
        "resolved",
        2_000,
      );
    } finally {
      temp.release?.();
    }

    expectEnvelope(await work, 502, AGENT_UNAVAILABLE_ENVELOPE);
    expect([isLive(temp.child), supervisor.liveProcessCount()]).toEqual([false, 0]);
    expect(atClose).toEqual({ messages: 4, file: seeded.file });
  });
});
