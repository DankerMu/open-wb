/**
 * Issue #1009 (s1g-composer-capabilities task 9.1, design D2/D5): a dispatch aligns the session's
 * process with its composer settings — the mode half. Every spawn takes the session's EFFECTIVE
 * mode and model (the raw columns clamped by the cap and the whitelist), and a live process started
 * under another mode is retired before the dispatch spawns its successor.
 * chat-sessions「派发前按会话设置对齐进程」, session-permission-tier「档位进入 argv」「换档从下一条消息起生效」
 * 「调低上界后既有会话被夹取」 and turn-control「档位不同时先退役再重新生成」; the fork argv is in
 * `session-fork-metadata.test.ts`, the `always-ask` approval flow in `session-approvals.test.ts`.
 *
 * Every world is the production createApp → registerSessions assembly over real fake-omp children
 * (`branch` unless a case says otherwise), a real in-memory SQLite and the injected clock, driven
 * over REST. A mode REST would refuse (`yolo` under a `write` cap) is planted by SQL. Oracles: the
 * recorded spawn argv, Node's own exit state of each child at every spawn, per-child stdin frames,
 * `stream_epoch`, SQLite rows and the published events; never supervisor internals.
 * The model and effort commands before a prompt are task 9.2: until then a process started for a
 * regenerate receives `get_branch_messages` first.
 */
import { mkdirSync } from "node:fs";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import {
  type ApprovalWorld,
  approvalRows,
  auditCount,
  flagValue,
  openApprovalWorld,
  pendingApproval,
  prompted,
  REAL,
  settle,
  spawnedAt,
} from "./session-approval-helpers.js";
import { patch } from "./session-archive-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { forkWorlds, openForkWorld, rowCounts } from "./session-fork-helpers.js";
import { THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import {
  answered,
  epochOf,
  openRegenWorld,
  QUESTION,
  sendPrompt,
  sessionFile,
  types,
  waitDead,
} from "./session-regenerate-helpers.js";
import { getSessionMessages, SESSION_BUSY_ENVELOPE } from "./session-rest-helpers.js";
import { holdExitEvents } from "./session-spawn-gate-helpers.js";
import {
  IDLE_MS,
  requiredCall,
  resumePath,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { isLive, sampleSpawns } from "./session-supervisor-pool-helpers.js";
import { postUndo, seedUndoable, undone } from "./session-undo-helpers.js";

const MODES = ["always-ask", "write", "yolo"] as const;

const worlds = forkWorlds();

/** Any of the worlds here: each is an approval world, opened under one scenario or another. */
type World = ApprovalWorld;

function post(world: World, url: string, body: unknown): Promise<LightMyRequestResponse> {
  return world.fixture.app.inject({
    method: "POST",
    url,
    headers: { cookie: world.cookie, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

function plant(world: World, column: "approval_mode" | "model_id", value: string): void {
  const written = world.fixture.db
    .prepare(`UPDATE chat_sessions SET ${column} = ? WHERE id = ?`)
    .run(value, world.session);
  expect(Number(written.changes)).toBe(1);
}

function rawMode(world: World): unknown {
  return world.fixture.db
    .prepare("SELECT approval_mode FROM chat_sessions WHERE id = ?")
    .get(world.session)?.approval_mode;
}

/** The session view's `approvalMode`, read over the public snapshot. */
async function shownMode(world: World): Promise<unknown> {
  const response = await getSessionMessages(world.fixture.app, world.session, world.cookie);
  expect(response.statusCode).toBe(200);
  return (response.json() as { session: { approvalMode: unknown } }).session.approvalMode;
}

/** The owner picks `approvalMode` over REST: 200, and the view reads it back. */
async function setMode(world: World, approvalMode: (typeof MODES)[number]): Promise<void> {
  const response = await patch(world, { approvalMode });
  expect(response.statusCode).toBe(200);
  expect((response.json() as { approvalMode: unknown }).approvalMode).toBe(approvalMode);
}

/** The session's file, epoch, spawn count and live process count, as one comparable value. */
function processOf(world: World) {
  const { db, supervisor } = world.fixture;
  return {
    file: sessionFile(db, world.session),
    epoch: epochOf(db, world.session),
    spawns: world.rt.calls.length,
    live: supervisor.liveProcessCount(),
  };
}

/**
 * Holds the `exit`/`close` events of the world's first child (wrapped before any spawn), so its
 * retirement stays pending until `release()`.
 */
function holdFirstExit(world: World): { held(): number; release(): void } {
  let hold: ReturnType<typeof holdExitEvents> | undefined;
  const inner = world.rt.runtime.spawnImpl;
  world.rt.runtime.spawnImpl = (command, args, options) => {
    const child = inner(command, args, options);
    hold ??= holdExitEvents(child);
    return child;
  };
  return { held: () => hold?.held() ?? 0, release: () => hold?.release() };
}

/**
 * One turn on the first process, the mode switched to `always-ask`, then a prompt that is accepted
 * and left waiting for that process's held exit. The pending request comes back wrapped: an async
 * function returning it bare would wait for it.
 */
async function switchedAndWaiting(
  world: World,
  hold: { held(): number },
): Promise<{ first: Promise<LightMyRequestResponse> }> {
  await answered(world);
  await setMode(world, "always-ask");
  const first = Promise.resolve(sendPrompt(world, "after the switch"));
  await waitFor(() => (hold.held() > 0 ? true : undefined), "the held exit");
  await settle();
  return { first };
}

/** `--approval-mode` of the n-th spawn. */
function modeOf(world: World, index: number): string | undefined {
  return flagValue(requiredCall(world.rt.calls, index).args, "--approval-mode");
}

describe("档位进入 argv (session-permission-tier)", () => {
  it("三个档位的会话各自冷启动：argv 只差 --approval-mode 的取值", REAL, async () => {
    const world = worlds.track(await openRegenWorld());
    // The workspace store realpaths the sandbox root; one workspace gives the three one cwd.
    mkdirSync(world.rt.runtime.sandboxRoot, { recursive: true });
    const made = await post(world, "/api/workspaces", { name: "proj", dir: "proj" });
    expect(made.statusCode).toBe(201);
    const workspaceId = (made.json() as { id: string }).id;

    for (const approvalMode of MODES) {
      const created = await post(world, "/api/sessions", { workspaceId, approvalMode });
      expect(created.statusCode).toBe(201);
      const session = (created.json() as { id: string }).id;
      expect((await sendPrompt(world, QUESTION, session)).statusCode).toBe(202);
      await waitForTurn(world.fixture, session, "done");
    }

    expect(world.rt.calls).toHaveLength(3);
    const argvs = world.rt.calls.map((call) => call.args);
    const at = requiredCall(world.rt.calls, 0).args.indexOf("--approval-mode");
    expect(at).toBeGreaterThan(0);
    expect(argvs.map((args) => args[at + 1])).toEqual([...MODES]);
    const rest = argvs.map((args) => args.filter((_, index) => index !== at + 1));
    expect(rest[1]).toEqual(rest[0]);
    expect(rest[2]).toEqual(rest[0]);
    expect(rest[0]?.filter((arg) => arg === "--approval-mode")).toHaveLength(1);
    expect(rest[0]).not.toContain("--resume");
    expect(MODES.some((mode) => rest[0]?.includes(mode))).toBe(false);
  });
});

describe("调低上界后既有会话被夹取 (session-permission-tier「管理员最高档」)", () => {
  it(
    "上界 write 下的 yolo 行：两条 prompt 恰一次 spawn，argv 为 write，列值仍为 yolo，不写审计；白名单外的模型取缺省",
    REAL,
    async () => {
      const world = worlds.track(
        await openRegenWorld({
          assembly: { approvalMaxMode: "write", modelCatalog: THREE_MODEL_CATALOG },
        }),
      );
      plant(world, "approval_mode", "yolo");
      // Off the whitelist: the argv takes the default model, like the mode it takes the clamp.
      plant(world, "model_id", "gone");
      const audits = auditCount(world.fixture.db);

      expect(await shownMode(world)).toBe("write");
      await answered(world);
      await answered(world);

      expect(world.rt.calls).toHaveLength(1);
      expect(modeOf(world, 0)).toBe("write");
      expect(flagValue(requiredCall(world.rt.calls, 0).args, "--model")).toBe("workbuddy/m1");
      expect(rawMode(world)).toBe("yolo");
      expect(await shownMode(world)).toBe("write");
      expect(auditCount(world.fixture.db)).toBe(audits);
    },
  );

  it("上界 always-ask 下三列为 NULL 的会话：视图与 argv 都是 always-ask", REAL, async () => {
    const world = worlds.track(
      await openRegenWorld({ assembly: { approvalMaxMode: "always-ask" } }),
    );
    expect(rawMode(world)).toBeNull();

    await answered(world);

    expect(world.rt.calls).toHaveLength(1);
    expect(modeOf(world, 0)).toBe("always-ask");
    expect(await shownMode(world)).toBe("always-ask");
    expect(rawMode(world)).toBeNull();
  });
});

describe("撤回的临时进程 (message-undo; the spec names no argv scenario)", () => {
  it(
    "以该会话的有效档位与有效模型启动：yolo 与 workbuddy/m3，--resume 会话文件",
    REAL,
    async () => {
      const world = worlds.track(
        await openForkWorld({ assembly: { modelCatalog: THREE_MODEL_CATALOG } }),
      );
      const { u2, file } = seedUndoable(world);
      plant(world, "approval_mode", "yolo");
      plant(world, "model_id", "m3");

      undone(await postUndo(world, u2));

      expect(world.rt.calls).toHaveLength(1);
      const { args } = requiredCall(world.rt.calls, 0);
      expect([flagValue(args, "--approval-mode"), flagValue(args, "--model")]).toEqual([
        "yolo",
        "workbuddy/m3",
      ]);
      expect(resumePath(args)).toBe(file);
    },
  );
});

describe("派发前按会话设置对齐进程：档位 (chat-sessions)", () => {
  it(
    "档位不同则以新档位重启：旧进程退出后才 spawn，--resume 会话文件，epoch 加一；档位不变不再重启，换回 write 再重启",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      await answered(world);
      const first = processOf(world);
      const old = spawnedAt(world, 0);
      expect(first).toMatchObject({ spawns: 1, live: 1 });
      expect(first.file).toEqual(expect.any(String));
      expect([modeOf(world, 0), isLive(old.child)]).toEqual(["write", true]);
      const published = world.events.length;

      await setMode(world, "always-ask");
      await answered(world);

      // Sampled at the second spawn: the first child had already exited, so never two alive.
      expect(world.liveAtSpawn).toEqual([[], []]);
      expect(isLive(old.child)).toBe(false);
      const { args } = requiredCall(world.rt.calls, 1);
      expect([flagValue(args, "--approval-mode"), resumePath(args)]).toEqual([
        "always-ask",
        first.file,
      ]);
      const second = processOf(world);
      expect(second).toMatchObject({ epoch: first.epoch + 1, spawns: 2, live: 1 });
      // The second turn's events were all published by the new generation's ring.
      const epochs = world.events.slice(published).map((entry) => entry.epoch);
      expect(epochs.length).toBeGreaterThan(0);
      expect(new Set(epochs)).toEqual(new Set([first.epoch + 1]));

      await answered(world);
      expect(processOf(world)).toEqual(second);
      expect(isLive(spawnedAt(world, 1).child)).toBe(true);

      // The slot remembers the mode it was started with: going back to `write` restarts again.
      await setMode(world, "write");
      await answered(world);
      expect(world.liveAtSpawn).toEqual([[], [], []]);
      expect(modeOf(world, 2)).toBe("write");
      expect(processOf(world)).toMatchObject({ epoch: first.epoch + 2, spawns: 3, live: 1 });
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "未改档位不重启：连续两个回合、再 PATCH 与有效档位相同的 write，三个回合同一进程、epoch 不变",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      await answered(world);
      const first = processOf(world);

      await answered(world);
      expect(processOf(world)).toEqual(first);

      // The raw column goes from NULL to `write`; the effective mode was `write` all along.
      expect(rawMode(world)).toBeNull();
      await setMode(world, "write");
      expect(rawMode(world)).toBe("write");
      await answered(world);

      expect(processOf(world)).toEqual(first);
      expect(world.liveAtSpawn).toEqual([[]]);
      expect(isLive(spawnedAt(world, 0).child)).toBe(true);
    },
  );

  it(
    "修改设置本身不动进程：PATCH yolo、m3 之后进程在、零帧、epoch 不变，空闲计时器未被重置并照常回收",
    REAL,
    async () => {
      const world = worlds.track(
        await openRegenWorld({ assembly: { modelCatalog: THREE_MODEL_CATALOG } }),
      );
      await answered(world);
      const child = spawnedAt(world, 0);
      const before = { process: processOf(world), frames: child.stdin.length };
      const due = world.clock.nowMs + IDLE_MS;
      expect(world.timersDueAt(due)).toBe(1);
      // A PATCH that reset the idle timer now would move its due time by this second.
      world.clock.advance(1_000);

      await setMode(world, "yolo");
      expect((await patch(world, { modelId: "m3" })).statusCode).toBe(200);
      await settle();

      expect({ process: processOf(world), frames: child.stdin.length }).toEqual(before);
      expect([child.child.stdin.writableEnded, child.child.exitCode]).toEqual([false, null]);
      expect([world.timersDueAt(due), world.timersDueAt(due + 1_000)]).toEqual([1, 0]);

      world.clock.advance(due - world.clock.nowMs);
      await waitDead(world, 0);
      await waitFor(
        () => (world.fixture.supervisor.liveProcessCount() === 0 ? true : undefined),
        "idle reclaim",
      );
      expect(processOf(world)).toEqual({ ...before.process, live: 0 });
      expect(child.stdin).toHaveLength(before.frames);
    },
  );

  it(
    "对齐期间的并发请求：等待旧进程退役时到达的 prompt 与 regenerate 都是 409、不增行，第一条照常 202",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld());
      const hold = holdFirstExit(world);
      const { app, db } = world.fixture;
      try {
        const { first } = await switchedAndWaiting(world, hold);
        // Accepted and waiting: its pair is stored, no second process yet.
        const rows = rowCounts(db);
        expect(world.rt.calls).toHaveLength(1);

        const prompt = await sendPrompt(world, "meanwhile");
        const regenerate = await postSessionAction(app, "regenerate", world.session, world.cookie);

        for (const response of [prompt, regenerate]) {
          expect([response.statusCode, response.json()]).toEqual([409, SESSION_BUSY_ENVELOPE]);
        }
        expect(rowCounts(db)).toEqual(rows);
        expect(world.rt.calls).toHaveLength(1);

        hold.release();
        expect((await first).statusCode).toBe(202);
        await waitForTurn(world.fixture, world.session, "done");
        expect(world.rt.calls).toHaveLength(2);
        expect(modeOf(world, 1)).toBe("always-ask");
        // The two refused requests left no message behind: only the accepted pair was added.
        expect(rowCounts(db).messages).toBe(rows.messages);
        expect(world.errors).toEqual([]);
      } finally {
        hold.release();
      }
    },
  );

  it(
    "等待旧进程退役时到达的 stop：202 留存意图，新进程写出 prompt 之后恰收到一条 abort（规格未写的分支）",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld());
      const hold = holdFirstExit(world);
      try {
        const { first } = await switchedAndWaiting(world, hold);
        const old = spawnedAt(world, 0);
        const frames = old.stdin.length;

        const stop = await postSessionAction(
          world.fixture.app,
          "stop",
          world.session,
          world.cookie,
        );

        // The turn is not on any slot yet: nothing is written to the process being retired.
        expect(stop.statusCode).toBe(202);
        expect(old.stdin).toHaveLength(frames);
        expect(world.rt.calls).toHaveLength(1);

        hold.release();
        expect((await first).statusCode).toBe(202);
        const sent = () => types(spawnedAt(world, 1).stdin);
        await waitFor(() => (sent().includes("abort") ? true : undefined), "the kept abort");
        expect(sent().slice(-2)).toEqual(["prompt", "abort"]);
        expect(old.stdin).toHaveLength(frames);
        await waitFor(
          () =>
            world.fixture.store.runtimeState(world.session)?.activeTurn === null ? true : undefined,
          "the stopped turn's end",
        );
        expect(sent().filter((type) => type === "abort")).toHaveLength(1);
        expect(world.errors).toEqual([]);
      } finally {
        hold.release();
      }
    },
  );
});

describe("换档从下一条消息起生效 (session-permission-tier)", () => {
  it(
    "生成中改档位：原进程与待决审批不动，作答后回合照常结束；下一条 prompt 由 yolo 的新进程处理，没有审批",
    REAL,
    async () => {
      const world = worlds.track(
        await openApprovalWorld("approval", { assembly: { modelCatalog: THREE_MODEL_CATALOG } }),
      );
      const liveAtSpawn = sampleSpawns({ runtime: world.rt.runtime, children: world.rt.children });
      const { db, supervisor } = world.fixture;
      const pending = await pendingApproval(world);
      const child = spawnedAt(world, 0);
      const before = { process: processOf(world), frames: child.stdin.length };

      await setMode(world, "yolo");
      await settle();

      expect({ process: processOf(world), frames: child.stdin.length }).toEqual(before);
      expect(child.child.exitCode).toBeNull();
      expect(approvalRows(db, world.session)).toEqual([pending]);

      await supervisor.decide(world.session, pending.id, "allow");
      await waitForTurn(world.fixture, world.session, "done");
      await settle();
      expect(child.stdin.slice(before.frames)).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
      const ended = processOf(world);
      expect(ended).toEqual({ ...before.process, file: ended.file });
      // Nor was a retirement left behind to run once the turn ended: its stdin is still open.
      expect([child.child.stdin.writableEnded, isLive(child.child)]).toEqual([false, true]);

      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");
      await settle();

      expect(liveAtSpawn).toEqual([[], []]);
      const { args } = requiredCall(world.rt.calls, 1);
      expect([flagValue(args, "--approval-mode"), resumePath(args)]).toEqual(["yolo", ended.file]);
      expect(processOf(world)).toMatchObject({ epoch: ended.epoch + 1, spawns: 2, live: 1 });
      // The `approval` scenario gates under `write` only: the second turn asked for nothing.
      expect(approvalRows(db, world.session)).toEqual([
        { ...pending, decision: "allow", decided_at: expect.any(Number) },
      ]);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("重新生成 REST：档位不同时先退役再重新生成 (turn-control)", () => {
  it(
    "202；旧进程退出后新进程才启动，argv 为 always-ask 与 --resume，epoch 恰加一，新进程收到 branch 三命令与 prompt",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const { app } = world.fixture;
      await answered(world);
      const old = spawnedAt(world, 0);
      const before = { process: processOf(world), frames: old.stdin.length };
      expect(isLive(old.child)).toBe(true);
      await setMode(world, "always-ask");

      const response = await postSessionAction(app, "regenerate", world.session, world.cookie);

      expect([response.statusCode, Object.keys(response.json() as object)]).toEqual([
        202,
        ["assistantMessageId"],
      ]);
      expect(world.liveAtSpawn).toEqual([[], []]);
      expect(isLive(old.child)).toBe(false);
      // The retired process was sent nothing more: the commands went to its successor.
      expect(old.stdin).toHaveLength(before.frames);
      const { args } = requiredCall(world.rt.calls, 1);
      expect([flagValue(args, "--approval-mode"), resumePath(args)]).toEqual([
        "always-ask",
        before.process.file,
      ]);
      expect(processOf(world)).toMatchObject({ epoch: before.process.epoch + 1, spawns: 2 });
      // Until task 9.2 nothing precedes `get_branch_messages` but the handshake.
      expect(types(spawnedAt(world, 1).stdin)).toEqual([
        "negotiate_protocol",
        "get_state",
        "get_branch_messages",
        "branch",
        "get_state",
        "prompt",
      ]);
      await waitForTurn(world.fixture, world.session, "done");
      expect(world.errors).toEqual([]);
    },
  );
});
