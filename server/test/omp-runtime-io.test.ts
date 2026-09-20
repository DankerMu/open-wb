/**
 * Issue #96 SessionRuntime controlled-wire races.
 * Independent literals from frozen rpc.md v18.0.10 and Node child_process.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  AgentUnavailableError,
  type OmpExit,
  OmpProtocolError,
} from "../src/sessions/omp/process.js";
import {
  SessionBusyError,
  SessionRuntime,
  type SessionRuntimeOpts,
} from "../src/sessions/omp/runtime.js";
import {
  createRpcHarness,
  DEFAULT_READY,
  type FakeChild,
  hasTerminated,
  observePromise,
} from "./support/omp-rpc.js";
import {
  collectUntilError,
  createClock,
  createTokens,
  type TestClock,
  type TokenBook,
} from "./support/omp-runtime.js";

const SESSION_ID = "sess-runtime-io";
const TOKEN = "wb-issue96-io-secret-token";
const IDLE_MS = 10_000;
const TERMINAL: OmpFrame = { type: "agent_end", isTerminal: true, messages: [] };
const harness = createRpcHarness();

describe("SessionRuntime prompt completion", () => {
  it("does not complete on ACK, nonterminal agent_end, or unrelated ids", async () => {
    const world = openWired();
    const pending = collectUntilError(world.runtime.prompt("wait"));
    const request = await world.waitPrompt();
    ackPrompt(world, request.id);
    world.child.emitLine({ type: "agent_start" });
    world.child.emitLine({ type: "agent_end", isTerminal: false, messages: [] });
    ackPrompt(world, "other", false);
    world.child.emitLine({
      id: "other",
      type: "response",
      command: "prompt",
      success: false,
      error: "unrelated",
    });
    await waitImmediate();
    const observation = observePromise(pending);
    expect(observation.outcome).toBe("pending");
    world.child.emitLine(TERMINAL);
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.frames.some((frame) => frame.type === "agent_start")).toBe(true);
    expect(result.frames).toContainEqual({ type: "agent_end", isTerminal: false, messages: [] });
    expect(result.frames[result.frames.length - 1]).toEqual(TERMINAL);
  });

  it("completes local-only work from matching agentInvoked false or prompt_result", async () => {
    const first = openWired();
    const local = collectUntilError(first.runtime.prompt("slash"));
    const request = await first.waitPrompt();
    ackPrompt(first, request.id, false);
    await expect(local).resolves.toMatchObject({ error: undefined });

    const second = openWired();
    const delayed = collectUntilError(second.runtime.prompt("later-local"));
    const later = await second.waitPrompt();
    ackPrompt(second, later.id);
    second.child.emitLine({ type: "command_output", output: "ok" });
    second.child.emitLine({ type: "prompt_result", id: later.id, agentInvoked: false });
    const delayedResult = await delayed;
    expect(delayedResult.error).toBeUndefined();
    expect(delayedResult.frames).toContainEqual({ type: "command_output", output: "ok" });
  });

  it("fails a matching same-id prompt error after ACK and keeps prior frames", async () => {
    const world = openWired();
    const pending = collectUntilError(world.runtime.prompt("late-fail"));
    const request = await world.waitPrompt();
    ackPrompt(world, request.id);
    world.child.emitLine({ type: "agent_start" });
    world.child.emitLine({
      id: request.id,
      type: "response",
      command: "prompt",
      success: false,
      error: "scheduling failed",
    });
    const result = await pending;
    expect(result.error).toBeInstanceOf(AgentUnavailableError);
    expect(result.frames).toContainEqual({ type: "agent_start" });
    world.clock.advance(8_000);
    await waitImmediate();
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
  });

  it("keeps events that arrive before ACK", async () => {
    const world = openWired();
    const pending = collectUntilError(world.runtime.prompt("early"));
    const request = await world.waitPrompt();
    world.child.emitLine({ type: "agent_start" });
    ackPrompt(world, request.id);
    world.child.emitLine(TERMINAL);
    const result = await pending;
    expect(result.frames[0]).toEqual({ type: "agent_start" });
    expect(result.frames[result.frames.length - 1]).toEqual(TERMINAL);
  });
});

describe("SessionRuntime native drain, stale callbacks and transport errors", () => {
  it("revokes the token on native death before stdout ends and still drains terminal frames", async () => {
    const world = openWired();
    const pending = collectUntilError(world.runtime.prompt("drain"));
    const request = await world.waitPrompt();
    ackPrompt(world, request.id);
    world.child.nativeExit(0);
    await waitImmediate();
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    const observation = observePromise(pending);
    expect(observation.outcome).toBe("pending");
    world.child.emitLine({ type: "notice", level: "info", message: "buffered" });
    world.child.emitLine(TERMINAL);
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.frames).toContainEqual({ type: "notice", level: "info", message: "buffered" });
    expect(result.frames).toContainEqual(TERMINAL);
    world.child.endStdout();
  });

  it("reclaims a held stdout pipe within the 8s drain budget using the original exit", async () => {
    const world = openWired();
    const pending = collectUntilError(world.runtime.prompt("held"));
    await world.waitPrompt();
    world.child.nativeExit(7);
    await waitImmediate();
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    expect(observePromise(pending).outcome).toBe("pending");
    world.clock.advance(7_999);
    await waitImmediate();
    expect(world.child.stdout.destroyed).toBe(false);
    world.clock.advance(1);
    const result = await pending;
    expect(result.error).toBeInstanceOf(AgentUnavailableError);
    expect(world.exits).toEqual([{ code: 7, signal: null }]);
    expect(world.child.stdout.destroyed).toBe(true);
  });

  it("ignores stale generation frames and exit after a successor starts", async () => {
    const world = openWired();
    const first = collectUntilError(world.runtime.prompt("old"));
    await world.waitPrompt();
    const oldChild = world.child;
    const oldToken = world.tokens.issued[0];
    world.child.exit(1);
    await first;
    const next = collectUntilError(world.runtime.prompt("new"));
    const successor = await world.waitPrompt();
    const successorToken = world.tokens.issued[1];
    expect(successorToken).not.toBe(oldToken);
    oldChild.emitLine(TERMINAL);
    oldChild.nativeExit(9);
    await waitImmediate();
    expect(world.tokens.live.get(SESSION_ID)).toBe(successorToken);
    ackPrompt(world, successor.id);
    world.child.emitLine(TERMINAL);
    const result = await next;
    expect(result.error).toBeUndefined();
    expect(world.tokens.revoked).not.toContain(successorToken);
  });

  it("fails and reclaims on a sanitized transport error instead of succeeding", async () => {
    const world = openWired();
    const pending = collectUntilError(world.runtime.prompt("io"));
    await world.waitPrompt();
    world.child.stdout.emit("error", new Error(`EPIPE ${TOKEN}`));
    const result = await pending;
    expect(result.error).toBeInstanceOf(AgentUnavailableError);
    expect(secretIn(result.error)).toBe(false);
    world.clock.advance(8_000);
    await waitImmediate();
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    expect(result.frames.some((frame) => frame.type === "agent_end")).toBe(false);
  });

  it("resets idle on child frames and does not spawn a second overlapping child", async () => {
    const world = openWired();
    const pending = collectUntilError(world.runtime.prompt("idle-frame"));
    const request = await world.waitPrompt();
    world.clock.advance(IDLE_MS - 1);
    world.child.emitLine({ type: "notice", level: "info", message: "tick" });
    world.clock.advance(IDLE_MS - 1);
    await waitImmediate();
    expect(hasTerminated(world.child as unknown as ChildProcessWithoutNullStreams)).toBe(false);
    expect(() => world.runtime.prompt("overlap")).toThrow(SessionBusyError);
    expect(world.spawns).toBe(1);
    ackPrompt(world, request.id);
    world.child.emitLine(TERMINAL);
    await pending;
  });

  it("does not treat protocol errors as a successful turn", async () => {
    const world = openWired();
    const pending = collectUntilError(world.runtime.prompt("protocol"));
    await world.waitPrompt();
    world.child.emitRaw("{not-json\n");
    const result = await pending;
    expect(result.error).toBeInstanceOf(OmpProtocolError);
    expect(result.frames.some((frame) => frame.type === "agent_end")).toBe(false);
  });
});

interface WiredWorld {
  runtime: SessionRuntime;
  child: FakeChild;
  clock: TestClock;
  tokens: TokenBook;
  exits: OmpExit[];
  spawns: number;
  waitPrompt(): Promise<OmpFrame>;
  waitSpawn(): Promise<FakeChild>;
}

function openWired(): WiredWorld {
  const clock = createClock();
  const tokens = createTokens(TOKEN);
  const exits: OmpExit[] = [];
  const spawnWaiters: Array<(child: FakeChild) => void> = [];
  let child = harness.fake();
  let spawns = 0;
  let promptWaiter: ((frame: OmpFrame) => void) | undefined;
  const bindChild = (next: FakeChild): void => {
    child = next;
    next.emitLine(DEFAULT_READY);
    next.replyHandshake();
    next.onCommand("prompt", (frame) => {
      promptWaiter?.(frame);
    });
  };
  bindChild(child);
  const opts: SessionRuntimeOpts = {
    sessionId: SESSION_ID,
    ...harness.tempOpts(TOKEN, "omp-rt-io-"),
    tokens,
    idleMs: IDLE_MS,
    clock,
    spawnImpl: (_command, args, options) => {
      spawns += 1;
      if (spawns > 1) {
        bindChild(harness.fake());
      }
      const spawned = child.spawnImpl(_command, args, options);
      spawnWaiters.splice(0).forEach((resolve) => {
        resolve(child);
      });
      return spawned;
    },
    onExit: (exit) => {
      exits.push(exit);
    },
  };
  return {
    runtime: new SessionRuntime(opts),
    get child() {
      return child;
    },
    clock,
    tokens,
    exits,
    get spawns() {
      return spawns;
    },
    waitPrompt() {
      return new Promise((resolve) => {
        promptWaiter = resolve;
      });
    },
    waitSpawn() {
      return new Promise((resolve) => {
        spawnWaiters.push(resolve);
      });
    },
  };
}

function ackPrompt(world: WiredWorld, id: unknown, agentInvoked = true): void {
  world.child.emitLine({
    id,
    type: "response",
    command: "prompt",
    success: true,
    data: { agentInvoked },
  });
}

function secretIn(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name}\n${error.message}\n${error.stack ?? ""}`
      : String(error);
  return text.includes(TOKEN);
}
