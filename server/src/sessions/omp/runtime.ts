/**
 * Per-session omp lifecycle (Issue #96) over OmpProcess.
 * Token crypto, persistence and event mapping live elsewhere.
 */
import { type ChildProcessWithoutNullStreams, type SpawnOptions, spawn } from "node:child_process";
import type { OmpFrame } from "./frame.js";
import {
  AgentUnavailableError,
  type OmpExit,
  OmpProcess,
  OmpProtocolError,
  type SpawnImpl,
} from "./process.js";

const DEFAULT_IDLE_MS = 600_000;
const TERM_GRACE_MS = 5_000;
const KILL_GRACE_MS = 3_000;
const SHUTDOWN_BUDGET_MS = TERM_GRACE_MS + KILL_GRACE_MS;

export interface SessionClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface SessionTokens {
  issue(sessionId: string): string;
  revoke(sessionId: string): void;
}

export interface SessionRuntimeOpts {
  sessionId: string;
  bin: string;
  sandboxRoot: string;
  stateDir: string;
  ownerId: string;
  modelId: string;
  tokens: SessionTokens;
  idleMs?: number;
  resumePath?: string | null;
  spawnImpl?: SpawnImpl;
  clock?: SessionClock;
  onExit?: (exit: OmpExit) => void;
  handshakeTimeoutMs?: number;
}

export class SessionBusyError extends Error {
  readonly code = "session_busy" as const;

  constructor() {
    super("session busy");
    this.name = "SessionBusyError";
  }
}

interface NativeWaiter {
  promise: Promise<OmpExit>;
  resolve: (exit: OmpExit) => void;
}

interface FrameWaiter {
  resolve: (result: IteratorResult<OmpFrame>) => void;
  reject: (error: Error) => void;
}

interface Generation {
  id: number;
  proc: OmpProcess;
  child: ChildProcessWithoutNullStreams | undefined;
  native: OmpExit | undefined;
  nativeWait: NativeWaiter;
  boot: Promise<{ sessionFile: string }>;
  revoked: boolean;
  retiring: Promise<void> | undefined;
  drainTimer: unknown;
}

interface Turn {
  genId: number;
  requestId: string;
  stream: FrameStream;
  sent: boolean;
}

const systemClock: SessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => {
    clearTimeout(id as NodeJS.Timeout);
  },
};

export class SessionRuntime {
  readonly #sessionId: string;
  readonly #bin: string;
  readonly #sandboxRoot: string;
  readonly #stateDir: string;
  readonly #ownerId: string;
  readonly #modelId: string;
  readonly #tokens: SessionTokens;
  readonly #idleMs: number;
  readonly #clock: SessionClock;
  readonly #userSpawn: SpawnImpl;
  readonly #onExit: ((exit: OmpExit) => void) | undefined;
  readonly #handshakeTimeoutMs: number | undefined;
  #resumePath: string | null;
  #sessionFile: string | undefined;
  #generation: Generation | undefined;
  #issuedGenId: number | undefined;
  #turn: Turn | undefined;
  #nextGen = 0;
  #nextRequest = 0;
  #idleTimer: unknown;
  #closed = false;
  #retired: Promise<void> = Promise.resolve();

  constructor(opts: SessionRuntimeOpts) {
    this.#sessionId = opts.sessionId;
    this.#bin = opts.bin;
    this.#sandboxRoot = opts.sandboxRoot;
    this.#stateDir = opts.stateDir;
    this.#ownerId = opts.ownerId;
    this.#modelId = opts.modelId;
    this.#tokens = opts.tokens;
    this.#idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.#clock = opts.clock ?? systemClock;
    this.#userSpawn = opts.spawnImpl ?? (spawn as SpawnImpl);
    this.#onExit = opts.onExit;
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs;
    this.#resumePath = opts.resumePath ?? null;
    this.#sessionFile = nonempty(this.#resumePath);
  }

  get sessionFile(): string | undefined {
    return this.#sessionFile;
  }

  prompt(text: string): AsyncIterable<OmpFrame> {
    if (this.#closed) {
      throw new AgentUnavailableError("runtime shutdown");
    }
    if (this.#turn !== undefined) {
      throw new SessionBusyError();
    }
    const stream = new FrameStream();
    const turn: Turn = { genId: 0, requestId: "", stream, sent: false };
    this.#turn = turn;
    stream.onCancel = () => {
      this.#abandon(turn);
    };
    this.#resetIdle();
    void this.#runPrompt(text, turn);
    return stream;
  }

  async shutdown(): Promise<void> {
    if (this.#closed) {
      return this.#retired;
    }
    this.#closed = true;
    this.#clearIdle();
    this.#failActiveTurn(new AgentUnavailableError("runtime shutdown"));
    const gen = this.#generation;
    if (gen === undefined) {
      return this.#retired;
    }
    await this.#retire(gen);
  }

  async #runPrompt(text: string, turn: Turn): Promise<void> {
    try {
      const gen = await this.#readyGeneration(turn);
      turn.genId = gen.id;
      turn.requestId = this.#nextId();
      this.#resetIdle();
      turn.sent = true;
      await gen.proc.send({ id: turn.requestId, type: "prompt", message: text });
    } catch (error) {
      if (this.#turn === turn) {
        this.#failTurn(turn, sanitizeError(error));
      }
    }
  }

  async #readyGeneration(turn: Turn): Promise<Generation> {
    await this.#retired;
    this.#assertTurn(turn);
    const current = this.#generation;
    if (current !== undefined && current.retiring === undefined && current.native === undefined) {
      return current;
    }
    if (current !== undefined) {
      await this.#retire(current);
      this.#assertTurn(turn);
    }
    const gen = await this.#acquire();
    if (this.#closed || this.#turn !== turn) {
      if (this.#generation === gen) {
        void this.#retire(gen);
      }
      throw new AgentUnavailableError("runtime shutdown");
    }
    return gen;
  }

  #assertTurn(turn: Turn): void {
    if (this.#closed || this.#turn !== turn) {
      throw new AgentUnavailableError("runtime shutdown");
    }
  }
  async #acquire(): Promise<Generation> {
    if (this.#closed) {
      throw new AgentUnavailableError("runtime shutdown");
    }
    this.#nextGen += 1;
    const id = this.#nextGen;
    const token = this.#tokens.issue(this.#sessionId);
    this.#issuedGenId = id;
    const nativeWait = deferredExit();
    const proc = this.#openProcess(token, (command, args, options) =>
      this.#spawnFor(id, command, args, options),
    );
    const boot = proc.start();
    const gen: Generation = {
      id,
      proc,
      child: undefined,
      native: undefined,
      nativeWait,
      boot,
      revoked: false,
      retiring: undefined,
      drainTimer: undefined,
    };
    this.#generation = gen;
    this.#bindProcess(gen);
    void boot.then(
      () => {},
      () => {},
    );
    try {
      const started = await boot;
      if (this.#closed || this.#generation !== gen) {
        await this.#retire(gen);
        throw new AgentUnavailableError("runtime shutdown");
      }
      this.#sessionFile = started.sessionFile;
      this.#resumePath = started.sessionFile;
      this.#resetIdle();
      return gen;
    } catch (error) {
      if (this.#generation === gen) {
        await this.#retire(gen);
      }
      throw sanitizeError(error);
    }
  }

  #openProcess(token: string, spawnImpl: SpawnImpl): OmpProcess {
    return new OmpProcess({
      bin: this.#bin,
      sandboxRoot: this.#sandboxRoot,
      stateDir: this.#stateDir,
      ownerId: this.#ownerId,
      modelId: this.#modelId,
      token,
      resumePath: this.#resumePath,
      spawnImpl,
      ...(this.#handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: this.#handshakeTimeoutMs }),
    });
  }
  #spawnFor(
    genId: number,
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams {
    const child = this.#userSpawn(command, args, options);
    const gen = this.#generation;
    if (gen === undefined || gen.id !== genId) {
      child.kill("SIGKILL");
      return child;
    }
    gen.child = child;
    child.once("exit", (code, signal) => {
      this.#onNativeExit(gen, { code, signal });
    });
    if (this.#closed || gen.retiring !== undefined) {
      gen.proc.closeInput();
    }
    return child;
  }

  #bindProcess(gen: Generation): void {
    gen.proc.on("frame", (frame) => {
      this.#onFrame(gen, frame);
    });
    gen.proc.on("error", (error) => {
      this.#onTransportError(gen, error);
    });
    gen.proc.on("exit", () => {
      this.#onLogicalExit(gen);
    });
  }

  #onFrame(gen: Generation, frame: OmpFrame): void {
    if (this.#generation !== gen) {
      return;
    }
    this.#resetIdle();
    const turn = this.#turn;
    if (turn === undefined || turn.genId !== gen.id || !turn.sent) {
      return;
    }
    turn.stream.push(frame);
    if (isLocalComplete(frame, turn.requestId) || isTerminalEnd(frame)) {
      this.#completeTurn(turn);
      return;
    }
    if (isMatchingFailure(frame, turn.requestId)) {
      this.#failTurn(turn, new AgentUnavailableError("prompt failed"));
      void this.#retire(gen);
    }
  }
  #onNativeExit(gen: Generation, exit: OmpExit): void {
    if (gen.native !== undefined) {
      return;
    }
    gen.native = exit;
    gen.nativeWait.resolve(exit);
    this.#revoke(gen);
    if (this.#generation === gen && gen.retiring === undefined) {
      this.#watchHeldPipe(gen);
    }
  }

  #onLogicalExit(gen: Generation): void {
    this.#clearDrain(gen);
    const turn = this.#turn;
    if (turn !== undefined && turn.genId === gen.id) {
      this.#onExit?.(gen.native ?? { code: null, signal: null });
      this.#failTurn(turn, new AgentUnavailableError("child exited"));
    }
    if (this.#generation === gen) {
      this.#clearIdle();
      this.#generation = undefined;
    }
  }

  #onTransportError(gen: Generation, error: Error): void {
    if (this.#generation !== gen) {
      return;
    }
    const turn = this.#turn;
    const active = turn !== undefined && turn.genId === gen.id;
    if (error instanceof OmpProtocolError && !active) {
      return;
    }
    if (active && turn !== undefined) {
      this.#failTurn(turn, sanitizeError(error));
    }
    void this.#retire(gen);
  }

  #completeTurn(turn: Turn): void {
    if (this.#turn !== turn) {
      return;
    }
    this.#turn = undefined;
    turn.stream.end();
  }

  #failTurn(turn: Turn, error: Error): void {
    if (this.#turn !== turn) {
      return;
    }
    this.#turn = undefined;
    turn.stream.fail(error);
  }

  #failActiveTurn(error: Error): void {
    const turn = this.#turn;
    if (turn !== undefined) {
      this.#failTurn(turn, error);
    }
  }

  #abandon(turn: Turn): void {
    if (this.#turn !== turn) {
      return;
    }
    this.#turn = undefined;
    const gen = this.#generation;
    if (gen !== undefined) {
      void this.#retire(gen);
    }
  }

  #retire(gen: Generation): Promise<void> {
    gen.retiring ??= this.#runRetire(gen);
    if (this.#generation === gen) {
      this.#retired = gen.retiring;
    }
    return gen.retiring;
  }
  async #runRetire(gen: Generation): Promise<void> {
    this.#clearIdle();
    this.#clearDrain(gen);
    const started = this.#clock.now();
    gen.proc.closeInput();
    const waitChild = this.#awaitChild(gen);
    const first = await this.#waitNative(gen, TERM_GRACE_MS);
    await waitChild;
    if (liveChild(gen) === undefined || first === "exit") {
      this.#revoke(gen);
      await this.#drainHeld(gen, started);
      this.#dropGeneration(gen);
      return;
    }
    gen.proc.kill("SIGTERM");
    if ((await this.#waitNative(gen, KILL_GRACE_MS)) === "exit") {
      await this.#finishDead(gen, started);
      return;
    }
    if (liveChild(gen) !== undefined) {
      gen.proc.kill("SIGKILL");
    }
    await gen.nativeWait.promise;
    await this.#finishDead(gen, started);
  }

  async #awaitChild(gen: Generation): Promise<void> {
    if (liveChild(gen) !== undefined || gen.native !== undefined) {
      return;
    }
    await gen.boot.then(
      () => {},
      () => {},
    );
  }

  async #finishDead(gen: Generation, started: number): Promise<void> {
    this.#revoke(gen);
    await this.#drainHeld(gen, started);
    this.#dropGeneration(gen);
  }
  async #drainHeld(gen: Generation, started: number): Promise<void> {
    const child = gen.child;
    if (child === undefined || child.stdout.readableEnded || child.stdout.destroyed) {
      return;
    }
    const remaining = SHUTDOWN_BUDGET_MS - Math.max(0, this.#clock.now() - started);
    if (remaining <= 0) {
      destroyStdio(child);
      return;
    }
    const ended = stdoutEnded(child);
    if ((await raceDelay(this.#clock, ended, remaining)) === "timeout") {
      destroyStdio(child);
    }
  }

  #watchHeldPipe(gen: Generation): void {
    const child = gen.child;
    if (child === undefined || child.stdout.readableEnded || child.stdout.destroyed) {
      return;
    }
    this.#clearDrain(gen);
    gen.drainTimer = this.#clock.setTimeout(() => {
      if (this.#generation === gen && !child.stdout.readableEnded && !child.stdout.destroyed) {
        destroyStdio(child);
      }
    }, SHUTDOWN_BUDGET_MS);
  }

  #clearDrain(gen: Generation): void {
    if (gen.drainTimer !== undefined) {
      this.#clock.clearTimeout(gen.drainTimer);
      gen.drainTimer = undefined;
    }
  }

  async #waitNative(gen: Generation, ms: number): Promise<"exit" | "timeout"> {
    if (gen.native !== undefined) {
      return "exit";
    }
    return raceDelay(this.#clock, gen.nativeWait.promise, ms);
  }

  #revoke(gen: Generation): void {
    if (gen.revoked || this.#issuedGenId !== gen.id) {
      return;
    }
    gen.revoked = true;
    this.#issuedGenId = undefined;
    this.#tokens.revoke(this.#sessionId);
  }

  #dropGeneration(gen: Generation): void {
    if (this.#generation === gen) {
      this.#generation = undefined;
    }
  }

  #resetIdle(): void {
    this.#clearIdle();
    const gen = this.#generation;
    if (this.#closed || gen === undefined || gen.retiring !== undefined) {
      return;
    }
    this.#idleTimer = this.#clock.setTimeout(() => {
      if (this.#generation === gen) {
        void this.#retire(gen);
      }
    }, this.#idleMs);
  }

  #clearIdle(): void {
    if (this.#idleTimer !== undefined) {
      this.#clock.clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  #nextId(): string {
    this.#nextRequest += 1;
    return `rt-${this.#nextRequest}`;
  }
}

class FrameStream implements AsyncIterable<OmpFrame> {
  onCancel: (() => void) | undefined;
  #queue: OmpFrame[] = [];
  #done = false;
  #error: Error | undefined;
  #wait: FrameWaiter | undefined;

  push(frame: OmpFrame): void {
    if (this.#done) {
      return;
    }
    const waiter = this.#wait;
    if (waiter !== undefined) {
      this.#wait = undefined;
      waiter.resolve({ value: frame, done: false });
      return;
    }
    this.#queue.push(frame);
  }

  end(): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#wait?.resolve({ value: undefined, done: true });
    this.#wait = undefined;
  }

  fail(error: Error): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#error = error;
    this.#wait?.reject(error);
    this.#wait = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<OmpFrame> {
    return {
      next: () => this.#next(),
      return: () => this.#return(),
    };
  }
  #next(): Promise<IteratorResult<OmpFrame>> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return Promise.resolve({ value: queued, done: false });
    }
    if (this.#error !== undefined) {
      return Promise.reject(this.#error);
    }
    if (this.#done) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.#wait = { resolve, reject };
    });
  }

  async #return(): Promise<IteratorResult<OmpFrame>> {
    if (!this.#done) {
      this.onCancel?.();
      this.#done = true;
    }
    this.#wait = undefined;
    return { value: undefined, done: true };
  }
}

function liveChild(gen: Generation): ChildProcessWithoutNullStreams | undefined {
  const child = gen.child ?? gen.proc.child;
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return undefined;
  }
  return child;
}

function stdoutEnded(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.stdout.readableEnded || child.stdout.destroyed) {
      resolve();
      return;
    }
    child.stdout.once("end", resolve);
    child.stdout.once("close", resolve);
  });
}

function destroyStdio(child: ChildProcessWithoutNullStreams): void {
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.destroy();
}

function raceDelay(
  clock: SessionClock,
  done: Promise<unknown>,
  ms: number,
): Promise<"exit" | "timeout"> {
  return new Promise((resolve) => {
    const timer = clock.setTimeout(() => {
      resolve("timeout");
    }, ms);
    void done.then(
      () => {
        clock.clearTimeout(timer);
        resolve("exit");
      },
      () => {
        clock.clearTimeout(timer);
        resolve("exit");
      },
    );
  });
}

function deferredExit(): NativeWaiter {
  let resolve!: (exit: OmpExit) => void;
  const promise = new Promise<OmpExit>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function isTerminalEnd(frame: OmpFrame): boolean {
  return frame.type === "agent_end" && frame.isTerminal !== false;
}

function isLocalComplete(frame: OmpFrame, requestId: string): boolean {
  if (frame.id !== requestId) {
    return false;
  }
  if (frame.type === "prompt_result") {
    return frame.agentInvoked === false;
  }
  if (frame.type !== "response" || frame.command !== "prompt" || frame.success !== true) {
    return false;
  }
  return asRecord(frame.data).agentInvoked === false;
}

function isMatchingFailure(frame: OmpFrame, requestId: string): boolean {
  return (
    frame.type === "response" &&
    frame.id === requestId &&
    frame.command === "prompt" &&
    frame.success === false
  );
}

function asRecord(value: unknown): OmpFrame {
  return value !== null && typeof value === "object" ? (value as OmpFrame) : {};
}

function nonempty(value: string | null): string | undefined {
  return value !== null && value.length > 0 ? value : undefined;
}

function sanitizeError(error: unknown): Error {
  if (
    error instanceof AgentUnavailableError ||
    error instanceof OmpProtocolError ||
    error instanceof SessionBusyError
  ) {
    return error;
  }
  return new AgentUnavailableError("agent_unavailable");
}
