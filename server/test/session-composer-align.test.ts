/**
 * Issue #1010 (s1g-composer-capabilities tasks 9.2/9.4, design D5/D8): a dispatch aligns the
 * session's process with its composer settings — the model and effort half. Every generation's
 * first dispatch sends `set_model` and, for a reasoning model, `set_thinking_level`; a later one
 * sends only what changed; both precede the turn's `prompt` (a regenerate's `get_branch_messages`).
 * model-selection「模型与强度从下一条消息起生效」, chat-sessions「派发前按会话设置对齐进程」 step 2 and
 * turn-control「重新生成 REST」; the mode half is `session-composer-dispatch.test.ts`, the fork's
 * inherited settings `session-fork-metadata.test.ts`.
 *
 * Every world is the production createApp → registerSessions assembly over real fake-omp children
 * (`branch` unless a case says otherwise), a real in-memory SQLite and the injected clock, driven
 * over REST. Oracles: the fake's own inbound `frames=` record, per-child stdin frames, the recorded
 * spawn argv, SQLite rows and the public snapshot; never supervisor internals.
 */
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  type ApprovalWorld,
  auditCount,
  extraSession,
  flagValue,
  openApprovalWorld,
  pendingApproval,
  prompted,
  REAL,
  settle,
  spawnedAt,
} from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import {
  BAD_LEVEL,
  choose,
  FAILING_MODEL_CATALOG,
  holdFirstExit,
  MISSING_MODEL,
  plantBadLevel,
  processOf,
  setMode,
} from "./session-composer-helpers.js";
import {
  forkWorlds,
  insertApproval,
  messagesOf,
  openForkScripted,
  openForkWorld,
  turn,
} from "./session-fork-helpers.js";
import { THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import {
  answered,
  count,
  heldLine,
  openRegenWorld,
  QUESTION,
  scriptedAt,
  seedDone,
  sendPrompt,
  snapshot,
  types,
  waitDead,
} from "./session-regenerate-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE, getSessionMessages } from "./session-rest-helpers.js";
import { probeFrames } from "./session-stop-helpers.js";
import {
  IDLE_MS,
  OWNER_ID,
  type RecordingWorld,
  requiredCall,
  requiredToken,
  resumePath,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { expectCapacity, isLive } from "./session-supervisor-pool-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";

const THREE = { assembly: { modelCatalog: THREE_MODEL_CATALOG } };
const FAILING = { assembly: { modelCatalog: FAILING_MODEL_CATALOG } };
/** What a generation's first dispatch sends ahead of its prompt for a reasoning model. */
const ALIGNED = ["negotiate_protocol", "get_state", "set_model", "set_thinking_level"];
/** The keys of a message in the snapshot, as chat-sessions「会话 REST」 lists them. */
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

const worlds = forkWorlds();

type World = ApprovalWorld;

/** The `set_model` frames a child received, without their ids. */
function models(frames: readonly OmpFrame[]) {
  return frames
    .filter((frame) => frame.type === "set_model")
    .map(({ type, provider, modelId }) => ({ type, provider, modelId }));
}

/** The `level` of each `set_thinking_level` frame a child received, in order. */
function levels(frames: readonly OmpFrame[]): unknown[] {
  return frames.filter((frame) => frame.type === "set_thinking_level").map((frame) => frame.level);
}

/** The n-th child once the idle timer reclaimed it and the supervisor let its capacity go. */
async function reclaimed(world: World, index: number): Promise<void> {
  world.clock.advance(IDLE_MS);
  await waitDead(world, index);
  await waitFor(
    () => (world.fixture.supervisor.liveProcessCount() === 0 ? true : undefined),
    "idle reclaim",
  );
}

function regenerate(world: RecordingWorld) {
  return postSessionAction(world.fixture.app, "regenerate", world.session, world.cookie);
}

describe("模型与强度从下一条消息起生效 (model-selection)", () => {
  it(
    "换模型与强度后的帧序：首次派发两条命令，之后只发变了的那条，不支持推理的模型不发强度；五个回合同一进程",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld(THREE));
      await answered(world);
      await choose(world, { modelId: "m3", reasoningEffort: "low" });
      await answered(world);
      await answered(world);
      await choose(world, { reasoningEffort: "high" });
      await answered(world);
      await choose(world, { modelId: "m2" });
      await answered(world);

      expect(await probeFrames(world)).toBe(
        "negotiate_protocol,get_state,set_model,set_thinking_level,prompt,set_model,set_thinking_level,prompt,prompt,set_thinking_level,prompt,set_model,prompt,prompt",
      );
      const { stdin } = spawnedAt(world, 0);
      const to = (modelId: string) => ({ type: "set_model", provider: "workbuddy", modelId });
      expect(models(stdin)).toEqual([to("m1"), to("m3"), to("m2")]);
      expect(levels(stdin)).toEqual(["high", "low", "high"]);
      // No restart for a model or an effort: one process served all of it.
      expect(world.rt.calls).toHaveLength(1);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "新进程重新应用：空闲回收后不改设置，新进程在 prompt 前只收到 set_model（m2 不支持推理）；改回 m1 再发两条",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld(THREE));
      await choose(world, { modelId: "m2" });
      await answered(world);
      expect(types(spawnedAt(world, 0).stdin)).toEqual([
        "negotiate_protocol",
        "get_state",
        "set_model",
        "prompt",
      ]);
      await reclaimed(world, 0);

      await answered(world);

      expect(world.rt.calls).toHaveLength(2);
      const { stdin } = spawnedAt(world, 1);
      expect(types(stdin)).toEqual(["negotiate_protocol", "get_state", "set_model", "prompt"]);
      expect(models(stdin).map((frame) => frame.modelId)).toEqual(["m2"]);

      await choose(world, { modelId: "m1" });
      await answered(world);

      expect(world.rt.calls).toHaveLength(2);
      expect(types(stdin).slice(4)).toEqual(["set_model", "set_thinking_level", "prompt"]);
      expect(models(stdin).map((frame) => frame.modelId)).toEqual(["m2", "m1"]);
      expect(levels(stdin)).toEqual(["high"]);

      // `off` is an effort like any other: it is sent, not treated as "nothing to apply".
      await choose(world, { reasoningEffort: "off" });
      await answered(world);
      expect(types(stdin).slice(7)).toEqual(["set_thinking_level", "prompt"]);
      expect(levels(stdin)).toEqual(["high", "off"]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "生成中修改不打断：回合在途时 PATCH m3，回合结束前没有 set_model；下一条 prompt 之前才收到",
    REAL,
    async () => {
      const world = worlds.track(await openApprovalWorld("approval", THREE));
      const pending = await pendingApproval(world);
      const { stdin } = spawnedAt(world, 0);
      expect(types(stdin)).toEqual([...ALIGNED, "prompt"]);

      await choose(world, { modelId: "m3" });
      await settle();
      expect(types(stdin)).toEqual([...ALIGNED, "prompt"]);

      await world.fixture.supervisor.decide(world.session, pending.id, "allow");
      await waitForTurn(world.fixture, world.session, "done");
      await settle();
      expect(types(stdin)).toEqual([...ALIGNED, "prompt", "extension_ui_response"]);
      expect(models(stdin).map((frame) => frame.modelId)).toEqual(["m1"]);

      await prompted(world);
      await waitFor(
        () => (types(stdin).filter((type) => type === "prompt").length === 2 ? true : undefined),
        "the second prompt",
      );
      expect(types(stdin).slice(6)).toEqual(["set_model", "set_thinking_level", "prompt"]);
      expect(models(stdin).map((frame) => frame.modelId)).toEqual(["m1", "m3"]);
      // The raw effort was never chosen: m3's default is sent, not m1's leftover.
      expect(levels(stdin)).toEqual(["high", "high"]);
      expect(world.rt.calls).toHaveLength(1);
    },
  );

  it(
    "消息不带模型：两个模型下各一个回合，快照每条消息的键集不变，chat_messages 没有模型或强度列",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld(THREE));
      await answered(world);
      await choose(world, { modelId: "m3", reasoningEffort: "low" });
      await answered(world);
      expect(models(spawnedAt(world, 0).stdin).map((frame) => frame.modelId)).toEqual(["m1", "m3"]);

      const response = await getSessionMessages(world.fixture.app, world.session, world.cookie);

      expect(response.statusCode).toBe(200);
      const { messages } = response.json() as { messages: object[] };
      expect(messages).toHaveLength(4);
      for (const message of messages) {
        expect(Object.keys(message)).toEqual(MESSAGE_KEYS);
      }
      const columns = world.fixture.db
        .prepare("PRAGMA table_info(chat_messages)")
        .all()
        .map((column) => String(column.name));
      expect(columns).toContain("content");
      expect(columns.filter((name) => /model|effort|level|reasoning/u.test(name))).toEqual([]);
    },
  );
});

describe("派发前按会话设置对齐进程：模型与强度 (chat-sessions)", () => {
  it(
    "regenerate 用当前设置：存活进程上两条命令先于 get_branch_messages；换成 yolo 后新进程同样先对齐",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld(THREE));
      const { db } = world.fixture;
      await answered(world);
      const first = spawnedAt(world, 0);
      const sent = first.stdin.length;
      const others = () => messagesOf(db, world.session).slice(0, -1);
      const kept = others();

      // The mode is unchanged: the live process is reused, on the generation already aligned.
      await choose(world, { modelId: "m3", reasoningEffort: "low" });
      expect((await regenerate(world)).statusCode).toBe(202);

      expect(world.rt.calls).toHaveLength(1);
      expect(types(first.stdin.slice(sent))).toEqual([
        "set_model",
        "set_thinking_level",
        "get_branch_messages",
        "branch",
        "get_state",
        "prompt",
      ]);
      await waitForTurn(world.fixture, world.session, "done");
      await settle();
      expect(others()).toEqual(kept);
      const before = processOf(world);

      await choose(world, { approvalMode: "yolo" });
      const response = await regenerate(world);

      expect([response.statusCode, Object.keys(response.json() as object)]).toEqual([
        202,
        ["assistantMessageId"],
      ]);
      expect(world.liveAtSpawn).toEqual([[], []]);
      expect(flagValue(requiredCall(world.rt.calls, 1).args, "--approval-mode")).toBe("yolo");
      const { stdin } = spawnedAt(world, 1);
      expect(types(stdin)).toEqual([
        ...ALIGNED,
        "get_branch_messages",
        "branch",
        "get_state",
        "prompt",
      ]);
      expect(models(stdin)).toEqual([{ type: "set_model", provider: "workbuddy", modelId: "m3" }]);
      expect(levels(stdin)).toEqual(["low"]);
      expect(processOf(world)).toMatchObject({ epoch: before.epoch + 1, spawns: 2 });
      await waitForTurn(world.fixture, world.session, "done");
      // Only the replaced answer changed: every other row is the one read before.
      expect(others()).toEqual(kept);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "对齐不留下多余的派发计数：回合结束后的 generation 在退役等待期间即已封存，流游标的 seq 为 null（规格未写的不变量）",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld());
      const { supervisor } = world.fixture;
      const hold = holdFirstExit(world);
      try {
        await answered(world);
        const live = supervisor.streamCursor(world.session);
        expect(live.seq).toEqual(expect.any(Number));
        await setMode(world, "always-ask");

        // Retires the first process and waits for its held exit: its generation has no dispatch
        // and no pump left, so the retirement seals it at once and the cursor reads the store.
        const next = Promise.resolve(sendPrompt(world, "after the switch"));
        await waitFor(() => (hold.held() > 0 ? true : undefined), "the held exit");
        await settle();
        expect(supervisor.streamCursor(world.session)).toEqual({ epoch: live.epoch, seq: null });

        hold.release();
        expect((await next).statusCode).toBe(202);
        await waitForTurn(world.fixture, world.session, "done");
        expect(world.errors).toEqual([]);
      } finally {
        hold.release();
      }
    },
  );

  it(
    "set_model 的应答被扣住时到达的 stop：202 留存意图，放开后 prompt 之后恰一条 abort（规格未写的分支）",
    REAL,
    async () => {
      const world = worlds.track(
        await openRegenWorld({
          scenario: "abort-ok",
          hold: (line) => line.includes('"command":"set_model"'),
        }),
      );
      const { app, store } = world.fixture;
      const first = Promise.resolve(sendPrompt(world, "stop during the alignment"));
      await heldLine(world);
      const { stdin, gate } = spawnedAt(world, 0);
      const waiting = ["negotiate_protocol", "get_state", "set_model"];
      expect(types(stdin)).toEqual(waiting);

      const stop = await postSessionAction(app, "stop", world.session, world.cookie);

      // The turn is claimed but has no prompt yet: nothing can be aborted, nothing is written.
      expect(stop.statusCode).toBe(202);
      await settle();
      expect(types(stdin)).toEqual(waiting);

      gate.release();
      expect((await first).statusCode).toBe(202);
      await waitFor(() => (types(stdin).includes("abort") ? true : undefined), "the kept abort");
      expect(types(stdin)).toEqual([...ALIGNED, "prompt", "abort"]);
      await waitFor(
        () => (store.runtimeState(world.session)?.activeTurn === null ? true : undefined),
        "the stopped turn's end",
      );
      await settle();
      expect(types(stdin)).toEqual([...ALIGNED, "prompt", "abort"]);
      expect(messagesOf(world.fixture.db, world.session).at(-1)?.status).toBe("stopped");
      expect(world.rt.calls).toHaveLength(1);
      expect(world.errors).toEqual([]);
    },
  );
});

/** A turn-free session's rows, compared across a dispatch that must leave them alone. */
function rowsOf(world: World, session = world.session) {
  return snapshot(world.fixture.db, session, true);
}

function permissionAudits(world: World): number {
  return count(
    world.fixture.db,
    "SELECT COUNT(*) AS count FROM audit_events WHERE kind = 'session.permission'",
  );
}

function expectUnavailable(response: { statusCode: number; json(): unknown }): void {
  expect([response.statusCode, response.json()]).toEqual([502, AGENT_UNAVAILABLE_ENVELOPE]);
}

/**
 * The REST prompt order without the route's snapshot step (real file I/O of unknown length): the
 * pair is admitted and the dispatch reaches the pool's admission queue in this synchronous segment,
 * so its place ahead of a later admission does not depend on timing.
 */
function admitted(world: World, session: string): Promise<void> {
  const { store, supervisor } = world.fixture;
  store.acceptPrompt(session, OWNER_ID, "takes a slot");
  return supervisor.prompt(session, "takes a slot");
}

type Scripted = Awaited<ReturnType<typeof openForkScripted>>;

/** What a child received when `set_model` was the last frame written to it. */
const ANSWERED_ONCE = ["negotiate_protocol", "get_state", "set_model"];

/** Runs `configure` on the scripted world's first child, right after its script. */
function onFirstChild(world: Scripted, configure: (child: FakeChild) => void): void {
  const inner = world.rt.runtime.spawnImpl;
  world.rt.runtime.spawnImpl = (command, args, options) => {
    const spawned = inner(command, args, options);
    if (world.scripted.length === 1) {
      configure(scriptedAt(world.scripted, 0).child);
    }
    return spawned;
  };
}

/** Answers `set_model` with success, then exits natively in the same segment (stdout ended). */
function answersThenExits(child: FakeChild): void {
  child.onCommand("set_model", (frame) => {
    child.emitLine({ id: frame.id, type: "response", command: "set_model", success: true });
    child.nativeExit(1);
    child.endStdout();
  });
}

/** The next prompt is accepted on a second process, aligned from scratch before its prompt. */
async function realignsOnNewProcess(world: Scripted): Promise<void> {
  expect((await sendPrompt(world)).statusCode).toBe(202);
  await waitForTurn(world.fixture, world.session, "done");
  expect(world.rt.calls).toHaveLength(2);
  expect(types(scriptedAt(world.scripted, 1).frames)).toEqual([...ALIGNED, "prompt"]);
}

/** How many frames of each of `kinds` the child received. */
function received(frames: readonly OmpFrame[], ...kinds: string[]): number[] {
  return kinds.map((kind) => frames.filter((frame) => frame.type === kind).length);
}

describe("对齐失败按派发前失败处理 (model-selection「命令失败」, chat-sessions「对齐失败按派发前失败补偿」)", () => {
  it(
    "set_model 应答失败：502，受理对被补偿、状态与 updatedAt 复原，没有 prompt 帧，进程已退役；改回可用模型后 202",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld(FAILING));
      const { db, supervisor } = world.fixture;
      await answered(world);
      const first = spawnedAt(world, 0);
      const sent = first.stdin.length;
      await choose(world, { modelId: MISSING_MODEL });
      const before = { rows: rowsOf(world), audits: auditCount(db), process: processOf(world) };

      const response = await sendPrompt(world, "under the missing model");

      expectUnavailable(response);
      expect(rowsOf(world)).toEqual(before.rows);
      expect(auditCount(db)).toBe(before.audits);
      // The refused command was the last frame this process received: no prompt followed it.
      expect(first.stdin.slice(sent)).toEqual([
        expect.objectContaining({ type: "set_model", modelId: MISSING_MODEL }),
      ]);
      expect([isLive(first.child), supervisor.liveProcessCount()]).toEqual([false, 0]);

      await choose(world, { modelId: "m1" });
      expect((await sendPrompt(world)).statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");
      expect(world.rt.calls).toHaveLength(2);
      expect(resumePath(requiredCall(world.rt.calls, 1).args)).toBe(before.process.file);
      expect(types(spawnedAt(world, 1).stdin)).toEqual([...ALIGNED, "prompt"]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "set_thinking_level 应答失败（回收后的新进程）：502，受理对被补偿，没有 prompt 帧，进程已退役；改回可用强度后 202",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const { supervisor } = world.fixture;
      await answered(world);
      await reclaimed(world, 0);
      plantBadLevel(world);
      // The epoch moves with the acquisition, as it does for any failed first command.
      const before = snapshot(world.fixture.db, world.session);

      const response = await sendPrompt(world, "under the bad level");

      expectUnavailable(response);
      expect(snapshot(world.fixture.db, world.session)).toEqual(before);
      const second = spawnedAt(world, 1);
      expect(types(second.stdin)).toEqual(ALIGNED);
      expect(levels(second.stdin)).toEqual([BAD_LEVEL]);
      expect([isLive(second.child), supervisor.liveProcessCount()]).toEqual([false, 0]);

      await choose(world, { reasoningEffort: "high" });
      expect((await sendPrompt(world)).statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");
      expect(world.rt.calls).toHaveLength(3);
      expect(types(spawnedAt(world, 2).stdin)).toEqual([...ALIGNED, "prompt"]);
      expect(levels(spawnedAt(world, 2).stdin)).toEqual(["high"]);
      expect(world.errors).toEqual([]);
    },
  );

  it("进程在 set_model 期间退出：502，受理对被补偿，名额与 token 都已释放；下一条 prompt 新 spawn 并重发两条命令", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { supervisor, tokens } = world.fixture;
    onFirstChild(world, (child) => {
      child.onCommand("set_model", () => {
        child.exit(1);
      });
    });
    const before = snapshot(world.fixture.db, world.session);

    const response = await sendPrompt(world);

    expectUnavailable(response);
    expect(snapshot(world.fixture.db, world.session)).toEqual(before);
    expect(types(scriptedAt(world.scripted, 0).frames)).toEqual(ANSWERED_ONCE);
    expect(supervisor.liveProcessCount()).toBe(0);
    expect(tokens.lookup(requiredToken(requiredCall(world.rt.calls, 0).token))).toBeNull();
    await realignsOnNewProcess(world);
  });

  it("新进程应答 set_model 之后原生退出（prompt）：下一条命令的重新获取失败仍是 502，受理对被补偿，没有 prompt 帧，进程已退役；下一条 prompt 新 spawn 并重新对齐", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { supervisor, tokens } = world.fixture;
    onFirstChild(world, answersThenExits);
    const before = snapshot(world.fixture.db, world.session);

    const response = await sendPrompt(world);

    expectUnavailable(response);
    expect(snapshot(world.fixture.db, world.session)).toEqual(before);
    expect(types(scriptedAt(world.scripted, 0).frames)).toEqual(ANSWERED_ONCE);
    expect([world.rt.calls.length, supervisor.liveProcessCount()]).toEqual([1, 0]);
    expect(tokens.lookup(requiredToken(requiredCall(world.rt.calls, 0).token))).toBeNull();
    await realignsOnNewProcess(world);
    expect(world.errors).toEqual([]);
  });

  it("新进程应答 set_model 之后原生退出（regenerate）：502，没有 get_branch_messages，行不变，占用释放；下一条 prompt 新 spawn 并重新对齐", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { supervisor, tokens } = world.fixture;
    seedDone(world);
    onFirstChild(world, answersThenExits);
    const before = snapshot(world.fixture.db, world.session);

    const response = await regenerate(world);

    expectUnavailable(response);
    expect(snapshot(world.fixture.db, world.session)).toEqual(before);
    expect(types(scriptedAt(world.scripted, 0).frames)).toEqual(ANSWERED_ONCE);
    expect([world.rt.calls.length, supervisor.liveProcessCount()]).toEqual([1, 0]);
    expect(supervisor.controlHeld(world.session)).toBe(false);
    expect(tokens.lookup(requiredToken(requiredCall(world.rt.calls, 0).token))).toBeNull();
    await realignsOnNewProcess(world);
    expect(world.errors).toEqual([]);
  });

  it(
    "换档后的 prompt 重新准入时进程上限已满且无可驱逐：503，受理对被补偿，旧进程已退出，没有新 spawn，审计只有 PATCH 那一条；之后 202",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld({ maxProcesses: 1 }));
      const hold = holdFirstExit(world);
      const other = await extraSession(world);
      try {
        await answered(world);
        const old = spawnedAt(world, 0);
        await setMode(world, "always-ask");
        const before = rowsOf(world);

        // Waits for the old process's held exit; the other session's admission evicts that same
        // slot and waits with it, ahead of this session's own re-admission.
        const switched = Promise.resolve(sendPrompt(world, "after the switch"));
        await waitFor(() => (hold.held() > 0 ? true : undefined), "the held exit");
        await settle();
        const taking = admitted(world, other);
        await settle();
        expect(world.rt.calls).toHaveLength(1);
        hold.release();

        expectCapacity(await switched);
        await expect(taking).resolves.toBeUndefined();
        expect(rowsOf(world)).toEqual(before);
        expect(isLive(old.child)).toBe(false);
        expect(received(old.stdin, "prompt")).toEqual([1]);
        await waitForTurn(world.fixture, other, "done");
        await settle();
        // The first session's process and the other one's: the refused prompt spawned nothing.
        expect(world.rt.calls).toHaveLength(2);
        expect(permissionAudits(world)).toBe(1);

        expect((await sendPrompt(world)).statusCode).toBe(202);
        await waitForTurn(world.fixture, world.session, "done");
        expect(world.rt.calls).toHaveLength(3);
        expect(flagValue(requiredCall(world.rt.calls, 2).args, "--approval-mode")).toBe(
          "always-ask",
        );
        expect(world.errors).toEqual([]);
      } finally {
        hold.release();
      }
    },
  );
});

describe("regenerate 的对齐失败不动任何行 (chat-sessions; turn-control「模型对齐失败发生在事务之前」)", () => {
  it(
    "失败模型：502，没有 get_branch_messages、branch 与 prompt，a1 及其步骤、审批与会话行逐值不变，进程已退役、占用释放；改回后 202",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld(FAILING));
      const { db, supervisor } = world.fixture;
      await answered(world);
      const a1 = messagesOf(db, world.session).at(-1)?.id ?? -1;
      // The `branch` scenario's turn ran one tool step; the approval is written beside it.
      insertApproval(db, a1, "r1", "allow", 70);
      const first = spawnedAt(world, 0);
      const sent = first.stdin.length;
      await choose(world, { modelId: MISSING_MODEL });
      const before = rowsOf(world);
      expect([before.steps.length, before.approvals.length]).toEqual([1, 1]);

      const response = await regenerate(world);

      expectUnavailable(response);
      expect(rowsOf(world)).toEqual(before);
      expect(first.stdin.slice(sent)).toEqual([
        expect.objectContaining({ type: "set_model", modelId: MISSING_MODEL }),
      ]);
      expect([isLive(first.child), supervisor.liveProcessCount()]).toEqual([false, 0]);
      expect(supervisor.controlHeld(world.session)).toBe(false);

      await choose(world, { modelId: "m1" });
      expect((await regenerate(world)).statusCode).toBe(202);
      expect(world.rt.calls).toHaveLength(2);
      expect(types(spawnedAt(world, 1).stdin)).toEqual([
        ...ALIGNED,
        "get_branch_messages",
        "branch",
        "get_state",
        "prompt",
      ]);
      await waitForTurn(world.fixture, world.session, "done");
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "换档后的 regenerate 重新准入时进程上限已满且无可驱逐：503，行不变，没有 branch 三命令与 prompt；之后 202",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld({ maxProcesses: 2 }));
      const { app, supervisor } = world.fixture;
      const hold = holdFirstExit(world);
      const a = await extraSession(world);
      const waiters = [await extraSession(world), await extraSession(world)] as const;
      const again = () => postSessionAction(app, "regenerate", a, world.cookie);
      try {
        // The world's own session is the least recently active: its process is the one evicted.
        await turn(world, QUESTION);
        await turn(world, QUESTION, a);
        const old = spawnedAt(world, 1);
        const sent = old.stdin.length;
        const taking = waiters.map((session) => admitted(world, session));
        await waitFor(() => (hold.held() > 0 ? true : undefined), "the held exit");
        await settle();
        await setMode(world, "always-ask", a);
        const before = rowsOf(world, a);

        // Retires its own process, then queues its re-admission behind the two prompts.
        const refused = Promise.resolve(again());
        await waitDead(world, 1);
        await settle();
        expect(world.rt.calls).toHaveLength(2);
        hold.release();

        expectCapacity(await refused);
        await expect(Promise.all(taking)).resolves.toEqual([undefined, undefined]);
        expect(rowsOf(world, a)).toEqual(before);
        expect(old.stdin).toHaveLength(sent);
        expect(supervisor.controlHeld(a)).toBe(false);
        for (const session of waiters) {
          await waitForTurn(world.fixture, session, "done");
        }
        await settle();
        // Only the four sessions' own processes: the refused regenerate spawned nothing.
        expect(world.rt.calls).toHaveLength(4);
        const branching = world.spawned.flatMap((spawned) =>
          received(spawned.stdin, "get_branch_messages", "branch"),
        );
        expect(branching).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

        expect((await again()).statusCode).toBe(202);
        await waitForTurn(world.fixture, a, "done");
        expect(world.rt.calls).toHaveLength(5);
        expect(world.errors).toEqual([]);
      } finally {
        hold.release();
      }
    },
  );
});
