/**
 * Per-session omp lifecycle (Issue #96) over OmpProcess.
 * Token crypto, persistence and event mapping live elsewhere.
 */
import { type ChildProcessWithoutNullStreams, type SpawnOptions, spawn } from "node:child_process";
import type { ApprovalMode } from "../../model-catalog.js";
import {
  awaitChild,
  canAbort,
  clearDrain,
  clearGrace,
  closeStdin,
  deferAbort,
  deferredExit,
  deferredReceipt,
  deferredSpawn,
  drainHeld,
  dropDeferredAbort,
  type Generation,
  isMatchingFailure,
  isTerminalEnd,
  isTurnStart,
  KILL_GRACE_MS,
  liveChild,
  localSignal,
  nonempty,
  openDeferredAbort,
  type RuntimeCommandFrame,
  signalLive,
  stateSessionFile,
  TERM_GRACE_MS,
  type Turn,
  waitNative,
  watchHeldPipe,
} from "./commands.js";
import type { OmpFrame } from "./frame.js";
import { decideLocalCompletion, LOCAL_COMMAND_GRACE_MS, type LocalState } from "./local-command.js";
import {
  AgentUnavailableError,
  type OmpExit,
  OmpProcess,
  OmpProtocolError,
  type SpawnImpl,
} from "./process.js";
import { FrameStream } from "./prompt-stream.js";
import { reportHandshakeTimeout, type SpawnGate, type SpawnLog } from "./spawn-gate.js";
import type { ApprovalDecision, ApprovalRequest } from "./ui-requests.js";

const DEFAULT_IDLE_MS = 600_000;

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
  approvalMode: ApprovalMode;
  tokens: SessionTokens;
  ompUser?: string;
  cwd: string;
  idleMs?: number;
  resumePath?: string | null;
  spawnImpl?: SpawnImpl;
  clock?: SessionClock;
  onExit?: (exit: OmpExit) => void;
  onApproval?: (request: ApprovalRequest) => void;
  handshakeTimeoutMs?: number;
  spawnGate?: SpawnGate;
  log?: SpawnLog;
}

export type PromptDispatchReceipt = { requestId: string; sessionFile: string };

export class SessionBusyError extends Error {
  readonly code = "session_busy" as const;

  constructor() {
    super("session busy");
    this.name = "SessionBusyError";
  }
}

/** A turn waiting for a late `command_output` after its local-only outcome (design D15). */
interface LocalWait {
  turn: Turn;
  since: number;
  timer: unknown;
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
  readonly #approvalMode: ApprovalMode;
  readonly #ompUser: string | undefined;
  readonly #cwd: string;
  readonly #tokens: SessionTokens;
  readonly #idleMs: number;
  readonly #clock: SessionClock;
  readonly #userSpawn: SpawnImpl;
  readonly #onExit: ((exit: OmpExit) => void) | undefined;
  readonly #onApproval: ((request: ApprovalRequest) => void) | undefined;
  readonly #handshakeTimeoutMs: number | undefined;
  readonly #spawnGate: SpawnGate | undefined;
  readonly #log: SpawnLog | undefined;
  #cancelQueued: (() => void) | undefined;
  #resumePath: string | null;
  #sessionFile: string | undefined;
  #generation: Generation | undefined;
  #issuedGenId: number | undefined;
  #turn: Turn | undefined;
  #localWait: LocalWait | undefined;
  #pendingReceipts = new Set<Turn>();
  #nextGen = 0;
  #nextRequest = 0;
  #idleTimer: unknown;
  #commanding = false;
  #closed = false;
  #retired: Promise<void> = Promise.resolve();

  constructor(opts: SessionRuntimeOpts) {
    this.#sessionId = opts.sessionId;
    this.#bin = opts.bin;
    this.#sandboxRoot = opts.sandboxRoot;
    this.#stateDir = opts.stateDir;
    this.#ownerId = opts.ownerId;
    this.#modelId = opts.modelId;
    this.#approvalMode = opts.approvalMode;
    this.#ompUser = opts.ompUser;
    this.#cwd = opts.cwd;
    this.#tokens = opts.tokens;
    this.#idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.#clock = opts.clock ?? systemClock;
    this.#userSpawn = opts.spawnImpl ?? (spawn as SpawnImpl);
    this.#onExit = opts.onExit;
    this.#onApproval = opts.onApproval;
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs;
    this.#spawnGate = opts.spawnGate;
    this.#log = opts.log;
    this.#resumePath = opts.resumePath ?? null;
    this.#sessionFile = nonempty(this.#resumePath);
  }

  get sessionFile(): string | undefined {
    return this.#sessionFile;
  }

  prompt(text: string): AsyncIterable<OmpFrame> & {
    dispatched: Promise<PromptDispatchReceipt>;
  } {
    if (this.#closed) {
      throw new AgentUnavailableError("runtime shutdown");
    }
    if (this.#turn !== undefined || this.#commanding) {
      throw new SessionBusyError();
    }
    const stream = new FrameStream();
    const dispatched = deferredReceipt();
    void dispatched.promise.catch(() => {});
    const turn: Turn = {
      genId: 0,
      requestId: "",
      stream,
      sent: false,
      dispatched,
      receiptSettled: false,
      slashText: text.startsWith("/"),
      commandOutputSeen: false,
      started: false,
      deferredAbort: undefined,
    };
    this.#turn = turn;
    this.#pendingReceipts.add(turn);
    stream.onCancel = () => {
      this.#abandon(turn);
    };
    this.#resetIdle();
    void this.#runPrompt(text, turn);
    return Object.assign(stream, { dispatched: dispatched.promise });
  }

  async shutdown(): Promise<void> {
    if (this.#closed) {
      return this.#retired;
    }
    this.#closed = true;
    this.#cancelQueued?.();
    this.#clearIdle();
    this.#failActiveTurn(new AgentUnavailableError("runtime shutdown"));
    this.#rejectPendingReceipts(new AgentUnavailableError("runtime shutdown"));
    const gen = this.#generation;
    if (gen === undefined) {
      return this.#retired;
    }
    await this.#retire(gen);
  }

  /** Suspend idle expiry while any approval id is pending on the current generation. */
  markPending(approvalId: string | number): void {
    const gen = this.#generation;
    if (gen === undefined || gen.pending.has(approvalId)) {
      return;
    }
    gen.pending.add(approvalId);
    this.#clearIdle();
  }

  /** Clearing the last pending id re-arms the full idle duration; absent ids are a no-op. */
  clearPending(approvalId: string | number): void {
    const gen = this.#generation;
    if (gen === undefined || !gen.pending.delete(approvalId) || gen.pending.size > 0) {
      return;
    }
    this.#resetIdle();
  }

  /** Owner answer, passed synchronously to the current generation; a no-op without one. */
  respondApproval(id: string, decision: ApprovalDecision): void {
    this.#generation?.proc.respondApproval(id, decision);
  }

  /**
   * `false` until the turn's receipt resolved on its live, non-retiring generation. Writes `abort`
   * only once the turn started (#650); before that the call is deferred to the start.
   */
  abort(): Promise<OmpFrame> | false {
    const turn = this.#turn;
    const gen = this.#generation;
    if (turn === undefined || !turn.receiptSettled || !canAbort(gen, turn)) {
      return false;
    }
    return turn.started ? this.#writeAbort(gen) : deferAbort(turn);
  }

  #writeAbort(gen: Generation): Promise<OmpFrame> {
    return gen.proc.request({ type: "abort", id: this.#nextId() });
  }

  /** Correlated out-of-turn request on the prompt acquisition path; resolves the response data. */
  command(frame: RuntimeCommandFrame): Promise<unknown> {
    if (this.#closed) {
      throw new AgentUnavailableError("runtime shutdown");
    }
    if (this.#turn !== undefined || this.#commanding) {
      throw new SessionBusyError();
    }
    this.#commanding = true;
    this.#resetIdle();
    return this.#runCommand(frame).finally(() => {
      this.#commanding = false;
      this.#resetIdle();
    });
  }

  async #runCommand(frame: OmpFrame): Promise<unknown> {
    try {
      const gen = await this.#readyGeneration(() => {
        if (this.#closed) {
          throw new AgentUnavailableError("runtime shutdown");
        }
      });
      const response = await gen.proc.request({ ...frame, id: this.#nextId() });
      if (response.success !== true) {
        throw new AgentUnavailableError(`${String(frame.type)} failed`);
      }
      const sessionFile = stateSessionFile(frame, response);
      if (sessionFile !== undefined && this.#generation === gen) {
        this.#sessionFile = sessionFile;
        this.#resumePath = sessionFile;
      }
      return response.data;
    } catch (error) {
      throw error instanceof AgentUnavailableError ? error : new AgentUnavailableError();
    }
  }

  async #runPrompt(text: string, turn: Turn): Promise<void> {
    try {
      const gen = await this.#readyGeneration(() => this.#assertTurn(turn));
      this.#assertTurn(turn);
      turn.genId = gen.id;
      turn.requestId = this.#nextId();
      this.#resetIdle();
      const sessionFile = this.#sessionFile;
      if (sessionFile === undefined || sessionFile.length === 0) {
        throw new AgentUnavailableError("get_state missing sessionFile");
      }
      turn.sent = true;
      await gen.proc.send({ id: turn.requestId, type: "prompt", message: text });
      this.#resolveReceipt(turn, { requestId: turn.requestId, sessionFile });
    } catch (error) {
      const sanitized = sanitizeError(error);
      if (this.#turn === turn) {
        this.#failTurn(turn, sanitized);
        const gen = this.#generation;
        if (gen !== undefined) {
          void this.#retire(gen);
        }
      } else {
        this.#rejectReceipt(turn, sanitized);
      }
    }
  }
  /** The single acquisition path for prompt and command; `assert` throws once the caller is stale. */
  async #readyGeneration(assert: () => void): Promise<Generation> {
    await this.#retired;
    assert();
    const current = this.#generation;
    if (current !== undefined && current.retiring === undefined && current.native === undefined) {
      return current;
    }
    if (current !== undefined) {
      await this.#retire(current);
      assert();
    }
    const gen = await this.#acquire();
    try {
      assert();
    } catch (error) {
      if (this.#generation === gen) {
        void this.#retire(gen);
      }
      throw error;
    }
    return gen;
  }

  #assertTurn(turn: Turn): void {
    if (this.#closed || this.#turn !== turn) {
      throw new AgentUnavailableError("runtime shutdown");
    }
  }
  /** A gate permit is held from grant until boot settles, and returned on every exit path. */
  async #acquire(): Promise<Generation> {
    const began = performance.now();
    const ticket = this.#closed ? undefined : this.#spawnGate?.acquire();
    this.#cancelQueued = ticket?.cancel;
    const release = ticket === undefined ? () => {} : await ticket.granted;
    try {
      if (this.#closed) {
        throw new AgentUnavailableError("runtime shutdown");
      }
      this.#nextGen += 1;
      const id = this.#nextGen;
      const token = this.#tokens.issue(this.#sessionId);
      this.#issuedGenId = id;
      const nativeWait = deferredExit();
      const spawnWait = deferredSpawn();
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
        spawnWait,
        boot,
        acquired: false,
        spawnFailed: false,
        revoked: false,
        retiring: undefined,
        pending: new Set<string | number>(),
        drainTimer: undefined,
        graceTimer: undefined,
      };
      this.#generation = gen;
      this.#bindProcess(gen);
      void boot.then(
        () => {},
        () => {
          gen.spawnWait.resolve(undefined);
        },
      );
      try {
        const started = await boot;
        release();
        gen.acquired = true;
        if (this.#closed || this.#generation !== gen) {
          await this.#retire(gen);
          throw new AgentUnavailableError("runtime shutdown");
        }
        this.#sessionFile = started.sessionFile;
        this.#resumePath = started.sessionFile;
        this.#resetIdle();
        return gen;
      } catch (error) {
        release();
        reportHandshakeTimeout(this.#log, this.#sessionId, began, error);
        if (this.#generation === gen) {
          await this.#retire(gen);
        }
        throw sanitizeError(error);
      }
    } finally {
      release();
    }
  }

  #openProcess(token: string, spawnImpl: SpawnImpl): OmpProcess {
    return new OmpProcess({
      bin: this.#bin,
      sandboxRoot: this.#sandboxRoot,
      stateDir: this.#stateDir,
      ownerId: this.#ownerId,
      modelId: this.#modelId,
      approvalMode: this.#approvalMode,
      token,
      resumePath: this.#resumePath,
      ...(this.#ompUser === undefined ? {} : { ompUser: this.#ompUser }),
      cwd: this.#cwd,
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
    // Only a pid-less child's 'error' is a spawn failure; a live one's is e.g. kill EPERM (#327).
    child.once("error", () => {
      if (typeof child.pid === "number") {
        return;
      }
      gen.spawnFailed = true;
      gen.child = undefined;
      gen.spawnWait.resolve(undefined);
    });
    if (typeof child.pid !== "number") {
      gen.spawnFailed = true;
      gen.spawnWait.resolve(undefined);
      return child;
    }
    gen.child = child;
    gen.spawnWait.resolve(child);
    child.once("exit", (code, signal) => {
      this.#onNativeExit(gen, { code, signal });
    });
    if (this.#closed || gen.retiring !== undefined) {
      closeStdin(gen);
    }
    return child;
  }

  #bindProcess(gen: Generation): void {
    gen.proc.on("frame", (frame) => {
      this.#onFrame(gen, frame);
    });
    gen.proc.on("approval", (request) => {
      this.#forwardApproval(gen, request);
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
    if (isTerminalEnd(frame)) {
      this.#completeTurn(turn);
      return;
    }
    if (isMatchingFailure(frame, turn.requestId)) {
      this.#failTurn(turn, new AgentUnavailableError("prompt failed"));
      void this.#retire(gen);
      return;
    }
    this.#onLocalFrame(turn, frame);
    if (!turn.started && isTurnStart(frame, turn.requestId)) {
      // After #onLocalFrame: a start frame that also ended the turn rejects instead (#650).
      turn.started = true;
      const open = this.#turn === turn && canAbort(gen, turn);
      openDeferredAbort(turn, open ? () => this.#writeAbort(gen) : undefined);
    }
  }

  /** Local-only completion: a `/` turn without output waits for it or for the grace. */
  #onLocalFrame(turn: Turn, frame: OmpFrame): void {
    const decision = decideLocalCompletion(
      this.#localState(turn, 0),
      localSignal(frame, turn.requestId),
    );
    if (frame.type === "command_output") {
      turn.commandOutputSeen = true;
    }
    if (decision === "complete") {
      this.#completeTurn(turn);
    } else if (decision === "await") {
      this.#awaitOutput(turn);
    }
  }

  #awaitOutput(turn: Turn): void {
    const wait: LocalWait = { turn, since: this.#clock.now(), timer: undefined };
    const tick = (): void => {
      if (this.#localWait !== wait || this.#turn !== turn) {
        return;
      }
      const elapsedMs = this.#clock.now() - wait.since;
      if (decideLocalCompletion(this.#localState(turn, elapsedMs), "grace-tick") === "complete") {
        this.#completeTurn(turn);
        return;
      }
      // Wall clock behind the timer (rounding, rollback): re-arm and replace the handle.
      wait.timer = this.#clock.setTimeout(tick, Math.max(1, LOCAL_COMMAND_GRACE_MS - elapsedMs));
    };
    this.#localWait = wait;
    wait.timer = this.#clock.setTimeout(tick, LOCAL_COMMAND_GRACE_MS);
  }

  #localState(turn: Turn, elapsedMs: number): LocalState {
    const awaiting = this.#localWait?.turn === turn;
    return { slashText: turn.slashText, outputSeen: turn.commandOutputSeen, awaiting, elapsedMs };
  }

  #clearLocalWait(): void {
    const wait = this.#localWait;
    if (wait !== undefined) {
      this.#localWait = undefined;
      this.#clock.clearTimeout(wait.timer);
    }
  }

  /** Same generation/turn gate as #onFrame; forwarding never marks pending or touches idle. */
  #forwardApproval(gen: Generation, request: ApprovalRequest): void {
    if (this.#generation !== gen) {
      return;
    }
    const turn = this.#turn;
    if (turn === undefined || turn.genId !== gen.id || !turn.sent) {
      return;
    }
    this.#onApproval?.(request);
  }

  #onNativeExit(gen: Generation, exit: OmpExit): void {
    if (gen.native !== undefined) {
      return;
    }
    gen.native = exit;
    gen.nativeWait.resolve(exit);
    this.#dropDeferred(gen);
    this.#revoke(gen);
    this.#onExit?.(exit);
    if (this.#generation === gen && gen.retiring === undefined) {
      watchHeldPipe(this.#clock, gen, () => this.#generation === gen);
    }
  }

  #onLogicalExit(gen: Generation): void {
    clearDrain(this.#clock, gen);
    const turn = this.#turn;
    if (turn !== undefined && turn.genId === gen.id) {
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
    if (error instanceof OmpProtocolError && !active && !this.#commanding) {
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
    this.#clearLocalWait();
    dropDeferredAbort(turn);
    turn.stream.end();
  }

  #failTurn(turn: Turn, error: Error): void {
    if (this.#turn !== turn) {
      return;
    }
    this.#turn = undefined;
    this.#clearLocalWait();
    dropDeferredAbort(turn);
    this.#rejectReceipt(turn, error);
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
    this.#clearLocalWait();
    dropDeferredAbort(turn);
    this.#rejectReceipt(turn, new AgentUnavailableError("runtime shutdown"));
    const gen = this.#generation;
    if (gen !== undefined && (turn.sent || !gen.acquired)) {
      void this.#retire(gen);
    }
  }

  #rejectPendingReceipts(error: Error): void {
    for (const turn of [...this.#pendingReceipts]) {
      this.#rejectReceipt(turn, error);
    }
  }

  #resolveReceipt(turn: Turn, receipt: PromptDispatchReceipt): void {
    if (turn.receiptSettled) {
      return;
    }
    turn.receiptSettled = true;
    this.#pendingReceipts.delete(turn);
    turn.dispatched.resolve(receipt);
  }

  #rejectReceipt(turn: Turn, error: Error): void {
    if (turn.receiptSettled) {
      return;
    }
    turn.receiptSettled = true;
    this.#pendingReceipts.delete(turn);
    turn.dispatched.reject(error);
  }
  #retire(gen: Generation): Promise<void> {
    if (this.#localWait?.turn.genId === gen.id) {
      this.#clearLocalWait();
    }
    this.#dropDeferred(gen);
    gen.retiring ??= this.#runRetire(gen);
    if (this.#generation === gen) {
      this.#retired = gen.retiring;
    }
    return gen.retiring;
  }

  async #runRetire(gen: Generation): Promise<void> {
    this.#clearIdle();
    clearDrain(this.#clock, gen);
    clearGrace(this.#clock, gen);
    const started = this.#clock.now();
    closeStdin(gen);
    const firstWait = waitNative(this.#clock, gen, TERM_GRACE_MS);
    const child = await awaitChild(gen);
    closeStdin(gen);
    if (child === undefined && gen.native === undefined && liveChild(gen) === undefined) {
      clearGrace(this.#clock, gen);
      this.#revoke(gen);
      this.#dropGeneration(gen);
      return;
    }
    const first = await firstWait;
    if (liveChild(gen) === undefined || first === "exit") {
      this.#revoke(gen);
      await drainHeld(this.#clock, gen, started);
      this.#dropGeneration(gen);
      return;
    }
    signalLive(gen, "SIGTERM");
    if ((await waitNative(this.#clock, gen, KILL_GRACE_MS)) === "exit") {
      await this.#finishDead(gen, started);
      return;
    }
    if (liveChild(gen) !== undefined) {
      signalLive(gen, "SIGKILL");
    }
    if (gen.native === undefined) {
      await gen.nativeWait.promise;
    }
    await this.#finishDead(gen, started);
  }

  async #finishDead(gen: Generation, started: number): Promise<void> {
    clearGrace(this.#clock, gen);
    this.#revoke(gen);
    await drainHeld(this.#clock, gen, started);
    this.#dropGeneration(gen);
  }
  /** Retiring or exited: the generation's turn can no longer start there (#650). */
  #dropDeferred(gen: Generation): void {
    if (this.#turn?.genId === gen.id) {
      dropDeferredAbort(this.#turn);
    }
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
    if (this.#closed || gen === undefined || gen.retiring !== undefined || gen.pending.size > 0) {
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
