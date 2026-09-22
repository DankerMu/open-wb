import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { AgentUnavailableError, type SpawnImpl } from "../src/sessions/omp/process.js";
import { SessionRuntime, type SessionRuntimeOpts } from "../src/sessions/omp/runtime.js";
import {
  createRpcHarness,
  DEFAULT_READY,
  DEFAULT_SESSION,
  type FakeChild,
  holdNextPromptWrite,
  observePromise,
} from "./support/omp-rpc.js";
import {
  collectUntilError,
  createClock,
  createTokens,
  type TestClock,
  type TokenBook,
} from "./support/omp-runtime.js";

const SESSION_ID = "session-dispatch-100";
const TOKEN_PREFIX = "wb-issue100-dispatch-token";
const IDLE_MS = 10_000;
const harness = createRpcHarness();

type DispatchReceipt = { requestId: string; sessionFile: string };
type DispatchedPrompt = AsyncIterable<OmpFrame> & { dispatched: Promise<DispatchReceipt> };

describe("SessionRuntime prompt dispatch receipt", () => {
  it("keeps early lifecycle frames iterable while the held write delays the exact outbound receipt", async () => {
    const world = openDispatchWorld();
    try {
      const held = holdNextPromptWrite(world.child);
      const prompt = dispatchedPrompt(world.runtime.prompt("early lifecycle"));
      const receiptObservation = observePromise(prompt.dispatched);
      const iterator = prompt[Symbol.asyncIterator]();
      await held.entered;

      world.child.emitLine({ type: "agent_start" });
      world.child.emitLine({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "before write completion" },
        message: { role: "assistant", content: [] },
      });
      const first = await iterator.next();
      expect(first).toEqual({ value: { type: "agent_start" }, done: false });
      expect(receiptObservation.outcome).toBe("pending");

      held.release();
      const outbound = await world.waitPrompt();
      const receipt = await prompt.dispatched;
      expect(receipt).toEqual({ requestId: outbound.id, sessionFile: DEFAULT_SESSION });

      const second = await iterator.next();
      expect(second).toEqual({
        value: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "before write completion" },
          message: { role: "assistant", content: [] },
        },
        done: false,
      });
      world.child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
      await expect(iterator.next()).resolves.toEqual({
        value: { type: "agent_end", messages: [], isTerminal: true },
        done: false,
      });
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    } finally {
      await closeDispatchWorld(world);
    }
  });

  it("uses the outbound prompt id rather than an unrelated local-only response id", async () => {
    const world = openDispatchWorld();
    try {
      const prompt = dispatchedPrompt(world.runtime.prompt("local only"));
      const iterator = prompt[Symbol.asyncIterator]();
      const outbound = await world.waitPrompt();
      await expect(prompt.dispatched).resolves.toEqual({
        requestId: outbound.id,
        sessionFile: DEFAULT_SESSION,
      });

      const unrelated = iterator.next();
      const unrelatedObservation = observePromise(unrelated);
      world.child.emitLine({
        id: "unrelated-local-response",
        type: "prompt_result",
        agentInvoked: false,
      });
      await waitImmediate();
      expect(unrelatedObservation.outcome).toBe("resolved");
      await expect(unrelated).resolves.toEqual({
        value: { id: "unrelated-local-response", type: "prompt_result", agentInvoked: false },
        done: false,
      });

      const parked = iterator.next();
      const parkedObservation = observePromise(parked);
      await waitImmediate();
      expect(parkedObservation.outcome).toBe("pending");

      world.child.emitLine({ id: outbound.id, type: "prompt_result", agentInvoked: false });
      await expect(parked).resolves.toEqual({
        value: { id: outbound.id, type: "prompt_result", agentInvoked: false },
        done: false,
      });
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    } finally {
      await closeDispatchWorld(world);
    }
  });

  it("rejects both channels on pre-dispatch acquisition failure without issuing a live token", async () => {
    const clock = createClock();
    const tokens = createTokens(TOKEN_PREFIX);
    const runtime = new SessionRuntime({
      sessionId: SESSION_ID,
      ...harness.tempOpts(`${TOKEN_PREFIX}-acquire`, "omp-dispatch-acquire-"),
      tokens,
      idleMs: IDLE_MS,
      clock,
      spawnImpl: (() => {
        throw new Error("spawn refused");
      }) as SpawnImpl,
    });
    try {
      const prompt = dispatchedPrompt(runtime.prompt("cannot acquire"));
      await expectBothChannelsReject(prompt);
      expect(tokens.live.get(SESSION_ID)).toBeUndefined();
      expect(tokens.revoked).toEqual(tokens.issued);
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects both channels after a prompt write failure and retires the acquired token", async () => {
    const world = openDispatchWorld();
    try {
      world.child.onCommand("get_state", (frame) => {
        world.child.emitLine({
          id: frame.id,
          type: "response",
          command: "get_state",
          success: true,
          data: { sessionFile: DEFAULT_SESSION },
        });
        world.child.failWrites(new Error("EPIPE prompt write"));
      });
      world.child.stdin.once("finish", () => {
        world.child.endStdout();
        world.child.exit(0);
      });

      const prompt = dispatchedPrompt(world.runtime.prompt("write failure"));
      await expectBothChannelsReject(prompt);
      await waitImmediate();
      expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    } finally {
      await closeDispatchWorld(world);
    }
  });

  it("rejects the receipt when cancellation or shutdown wins before the held prompt write", async () => {
    for (const action of ["cancel", "shutdown"] as const) {
      const world = openDispatchWorld();
      try {
        const held = holdNextPromptWrite(world.child);
        const prompt = dispatchedPrompt(world.runtime.prompt(`${action} before send`));
        observePromise(prompt.dispatched);
        const iterator = prompt[Symbol.asyncIterator]();
        await held.entered;

        let shutting: Promise<void> | undefined;
        if (action === "cancel") {
          const cancel = iterator.return;
          if (cancel === undefined) {
            throw new Error("prompt iterator must support cancellation");
          }
          await cancel.call(iterator);
        } else {
          shutting = world.runtime.shutdown();
        }

        await expect(prompt.dispatched).rejects.toBeInstanceOf(AgentUnavailableError);
        expect(world.tokens.live.get(SESSION_ID)).toBe(world.tokens.issued[0]);
        expect(world.tokens.revoked).toEqual([]);

        world.child.nativeExit(0);
        world.child.endStdout();
        if (shutting !== undefined) {
          await shutting;
        }
        await waitImmediate();
        expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
        expect(world.tokens.revoked).toEqual(world.tokens.issued);
        expect(world.tokens.revoked).toHaveLength(1);
      } finally {
        await closeDispatchWorld(world);
      }
    }
  });

  it("settles dispatch before terminal completion and leaves a later matching failure observable only on the iterator", async () => {
    const world = openDispatchWorld();
    try {
      const prompt = dispatchedPrompt(world.runtime.prompt("late failure"));
      const iterator = prompt[Symbol.asyncIterator]();
      const outbound = await world.waitPrompt();
      const receipt = await prompt.dispatched;
      expect(receipt.requestId).toBe(outbound.id);

      const parked = iterator.next();
      const parkedObservation = observePromise(parked);
      await waitImmediate();
      expect(parkedObservation.outcome).toBe("pending");
      const failure = {
        id: outbound.id,
        type: "response",
        command: "prompt",
        success: false,
        error: "late agent failure",
      };
      world.child.emitLine(failure);

      await expect(parked).resolves.toEqual({ value: failure, done: false });
      await expect(iterator.next()).rejects.toBeInstanceOf(AgentUnavailableError);
      await expect(prompt.dispatched).resolves.toEqual(receipt);
    } finally {
      await closeDispatchWorld(world);
    }
  });
});

interface DispatchWorld {
  runtime: SessionRuntime;
  child: FakeChild;
  clock: TestClock;
  tokens: TokenBook;
  waitPrompt(): Promise<OmpFrame>;
}

function openDispatchWorld(): DispatchWorld {
  const clock = createClock();
  const tokens = createTokens(TOKEN_PREFIX);
  const child = harness.fake();
  const prompts: OmpFrame[] = [];
  const promptWaiters: Array<(frame: OmpFrame) => void> = [];
  child.emitLine(DEFAULT_READY);
  child.replyHandshake();
  child.onCommand("prompt", (frame) => {
    prompts.push(frame);
    for (const resolve of promptWaiters.splice(0)) {
      resolve(frame);
    }
  });
  const opts: SessionRuntimeOpts = {
    sessionId: SESSION_ID,
    ...harness.tempOpts(`${TOKEN_PREFIX}-world`, "omp-dispatch-world-"),
    tokens,
    idleMs: IDLE_MS,
    clock,
    spawnImpl: child.spawnImpl,
  };
  return {
    runtime: new SessionRuntime(opts),
    child,
    clock,
    tokens,
    waitPrompt() {
      const existing = prompts.at(0);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => {
        promptWaiters.push(resolve);
      });
    },
  };
}

async function expectBothChannelsReject(prompt: DispatchedPrompt): Promise<void> {
  const receipt = expect(prompt.dispatched).rejects.toBeInstanceOf(AgentUnavailableError);
  const stream = collectUntilError(prompt);
  await receipt;
  await expect(stream).resolves.toMatchObject({
    frames: [],
    error: expect.any(AgentUnavailableError),
  });
}
function dispatchedPrompt(prompt: AsyncIterable<OmpFrame>): DispatchedPrompt {
  expect(prompt).toHaveProperty("dispatched");
  expect((prompt as { dispatched?: unknown }).dispatched).toBeInstanceOf(Promise);
  return prompt as DispatchedPrompt;
}

async function closeDispatchWorld(world: DispatchWorld): Promise<void> {
  if (world.child.exitCode === null && world.child.signalCode === null) {
    world.child.exit(0);
  }
  if (!world.child.stdout.destroyed && !world.child.stdout.readableEnded) {
    world.child.endStdout();
  }
  await world.runtime.shutdown();
}
