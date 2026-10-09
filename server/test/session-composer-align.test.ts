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
  flagValue,
  openApprovalWorld,
  pendingApproval,
  prompted,
  REAL,
  settle,
  spawnedAt,
} from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { choose, holdFirstExit, processOf, setMode } from "./session-composer-helpers.js";
import { forkWorlds, messagesOf, openForkWorld } from "./session-fork-helpers.js";
import { THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import {
  answered,
  heldLine,
  openRegenWorld,
  sendPrompt,
  types,
  waitDead,
} from "./session-regenerate-helpers.js";
import { getSessionMessages } from "./session-rest-helpers.js";
import { probeFrames } from "./session-stop-helpers.js";
import { IDLE_MS, requiredCall, waitFor, waitForTurn } from "./session-supervisor-helpers.js";

const THREE = { assembly: { modelCatalog: THREE_MODEL_CATALOG } };
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

function regenerate(world: World) {
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
