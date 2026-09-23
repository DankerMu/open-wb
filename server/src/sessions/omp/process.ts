/**
 * omp spawn assembly (Issue #85) and RPC transport (Issue #95).
 * Idle/reap policy, models.yml and token issuance live elsewhere.
 */
import { type ChildProcessWithoutNullStreams, type SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { assertSafeSudoPath } from "../../core/process-path.js";
import { ensureSharedDir } from "../../core/sandbox/dirs.js";
import {
  MAX_RPC_FRAME_BYTES,
  MAX_RPC_REASSEMBLED_BYTES,
  type OmpFrame,
  RpcChunkDecoder,
} from "./frame.js";

export interface SpawnOmpOpts {
  /** Trusted absolute executable path from config; not a PATH lookup. */
  bin: string;
  sandboxRoot: string;
  stateDir: string;
  ownerId: string;
  modelId: string;
  token: string;
  resumePath: string | null;
  ompUser?: string;
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

/**
 * Prepare owned directories then spawn the omp child.
 * Await this call: it settles after directory preparation and spawnImpl return.
 * It does not wait for the child to exit.
 */
export async function spawnOmp(
  opts: SpawnOmpOpts,
  spawnImpl: SpawnImpl = spawn as SpawnImpl,
): Promise<ChildProcessWithoutNullStreams> {
  if (opts.ompUser !== undefined) {
    assertSafeSudoPath(process.env.PATH);
  }
  const cwd = join(opts.sandboxRoot, opts.ownerId);
  const sessionDir = join(opts.stateDir, "sessions", opts.ownerId);
  const home = join(opts.stateDir, "home");
  const agent = join(opts.stateDir, "agent");
  ensureSharedDir(cwd);
  ensureSharedDir(sessionDir);
  ensureSharedDir(home);
  ensureSharedDir(agent);
  // Preserve the prior async spawn boundary; native lifecycle regression covers it.
  await Promise.resolve();

  const args = [
    "--mode",
    "rpc",
    "--cwd",
    cwd,
    "--session-dir",
    sessionDir,
    "--model",
    `workbuddy/${opts.modelId}`,
    "--approval-mode",
    "yolo",
    "--no-extensions",
    "--no-lsp",
    "--no-pty",
    "--no-title",
  ];
  if (opts.resumePath !== null) {
    args.push("--resume", opts.resumePath);
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    PI_CODING_AGENT_DIR: agent,
    WORKBUDDY_MODEL_TOKEN: opts.token,
  };
  if (process.env.LANG !== undefined) {
    env.LANG = process.env.LANG;
  }
  if (process.env.TMPDIR !== undefined) {
    env.TMPDIR = process.env.TMPDIR;
  }

  const command = opts.ompUser === undefined ? opts.bin : "sudo";
  const commandArgs =
    opts.ompUser === undefined
      ? args
      : [
          "-n",
          "-u",
          opts.ompUser,
          "--preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN",
          "--",
          opts.bin,
          ...args,
        ];
  return spawnImpl(command, commandArgs, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface OmpProcessOpts extends SpawnOmpOpts {
  spawnImpl?: SpawnImpl;
  handshakeTimeoutMs?: number;
}

export interface OmpExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class AgentUnavailableError extends Error {
  readonly code = "agent_unavailable" as const;

  constructor(message = "agent_unavailable") {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

export class OmpProtocolError extends Error {
  readonly code = "protocol_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "OmpProtocolError";
  }
}

interface PendingRequest {
  command: string;
  resolve: (frame: OmpFrame) => void;
  reject: (error: Error) => void;
}

interface OmpEvents {
  frame: [OmpFrame];
  exit: [OmpExit];
  error: [Error];
}

/**
 * JSONL RPC transport over spawnOmp. Handshake succeeds only after ready,
 * negotiate_protocol v2, and nonempty get_state.sessionFile.
 */
export class OmpProcess {
  readonly #opts: SpawnOmpOpts;
  readonly #spawnImpl: SpawnImpl;
  readonly handshakeTimeoutMs: number;
  readonly #events = new EventEmitter();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #decoder = new RpcChunkDecoder();
  readonly #ready: Promise<void>;
  #settleReady: ((error?: Error) => void) | undefined;
  #readySettled = false;
  #child: ChildProcessWithoutNullStreams | undefined;
  #startPromise: Promise<{ sessionFile: string }> | undefined;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #nextId = 0;
  #line: Buffer | undefined;
  #lineLength = 0;
  #discardingOversizedLine = false;
  #maxPhysical = MAX_RPC_FRAME_BYTES;
  #maxLogical = MAX_RPC_REASSEMBLED_BYTES;
  #exited = false;
  #writesClosed = false;
  #stdoutClosed = false;
  #started = false;
  #fatal: Error | undefined;
  #nativeExit: OmpExit | undefined;
  #sentSigkill = false;

  constructor(opts: OmpProcessOpts) {
    const { spawnImpl, handshakeTimeoutMs, ...spawnOpts } = opts;
    this.#opts = spawnOpts;
    this.#spawnImpl = spawnImpl ?? (spawn as SpawnImpl);
    this.handshakeTimeoutMs = handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#settleReady = (error) => {
        if (this.#readySettled) {
          return;
        }
        this.#readySettled = true;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
    });
    void this.#ready.catch(() => {});
    this.#events.on("error", () => {});
  }

  get child(): ChildProcessWithoutNullStreams | undefined {
    return this.#child;
  }

  on<K extends keyof OmpEvents>(event: K, listener: (...args: OmpEvents[K]) => void): this {
    this.#events.on(event, listener as never);
    return this;
  }

  start(): Promise<{ sessionFile: string }> {
    this.#startPromise ??= this.#boot();
    return this.#startPromise;
  }

  send(frame: OmpFrame): Promise<void> {
    return this.#write(frame);
  }

  request(frame: OmpFrame): Promise<OmpFrame> {
    const command = typeof frame.type === "string" ? frame.type : "";
    const id = typeof frame.id === "string" && frame.id.length > 0 ? frame.id : this.#id();
    return this.#request(command, { ...frame, id });
  }

  closeInput(): void {
    this.#child?.stdin.end();
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): boolean {
    const sent = this.#child?.kill(signal) ?? false;
    if (sent && signal === "SIGKILL") {
      this.#sentSigkill = true;
    }
    return sent;
  }

  async #boot(): Promise<{ sessionFile: string }> {
    try {
      this.#child = await spawnOmp(this.#opts, this.#spawnImpl);
    } catch (error) {
      throw this.#failStartup(sanitizeIo(error, "spawn failed"));
    }
    this.#attach(this.#child);
    const timeout = this.#deadline();
    const handshake = this.#handshake();
    void handshake.catch(() => {});
    try {
      const sessionFile = await Promise.race([handshake, timeout.promise]);
      if (this.#fatal || this.#writesClosed || this.#childDead()) {
        throw this.#fatal ?? new AgentUnavailableError("agent_unavailable");
      }
      this.#started = true;
      return { sessionFile };
    } catch (error) {
      throw this.#failStartup(error);
    } finally {
      timeout.clear();
    }
  }

  async #handshake(): Promise<string> {
    if (this.#fatal || this.#writesClosed) {
      throw this.#fatal ?? new AgentUnavailableError("agent_unavailable");
    }
    await this.#ready;
    const negotiate = await this.#request("negotiate_protocol", {
      id: this.#id(),
      type: "negotiate_protocol",
      protocolVersion: 2,
    });
    if (
      negotiate.success !== true ||
      negotiate.command !== "negotiate_protocol" ||
      asRecord(negotiate.data).protocolVersion !== 2
    ) {
      throw new AgentUnavailableError("negotiate_protocol failed");
    }
    const state = await this.#request("get_state", { id: this.#id(), type: "get_state" });
    const sessionFile = asRecord(state.data).sessionFile;
    if (state.success !== true || state.command !== "get_state" || !isNonemptyString(sessionFile)) {
      throw new AgentUnavailableError("get_state missing sessionFile");
    }
    return sessionFile;
  }

  #applyLimits(ready: OmpFrame): void {
    const physical = ready.maxFrameBytes;
    const logical = ready.maxReassembledFrameBytes;
    if (typeof physical === "number" && Number.isSafeInteger(physical) && physical > 0) {
      this.#maxPhysical = Math.min(physical, MAX_RPC_FRAME_BYTES);
    }
    if (typeof logical === "number" && Number.isSafeInteger(logical) && logical > 0) {
      this.#maxLogical = Math.min(logical, MAX_RPC_REASSEMBLED_BYTES);
    }
    this.#decoder.setLimits(this.#maxPhysical, this.#maxLogical);
  }

  #request(command: string, frame: OmpFrame): Promise<OmpFrame> {
    const id = typeof frame.id === "string" ? frame.id : this.#id();
    if (this.#pending.has(id)) {
      return Promise.reject(new OmpProtocolError("duplicate request id"));
    }
    return new Promise<OmpFrame>((resolve, reject) => {
      if (this.#fatal || this.#writesClosed) {
        reject(this.#fatal ?? new AgentUnavailableError("write failed"));
        return;
      }
      const pending: PendingRequest = { command, resolve, reject };
      this.#pending.set(id, pending);
      const failWrite = (error: unknown): void => {
        if (this.#pending.get(id) === pending) this.#pending.delete(id);
        reject(sanitizeIo(error, "write failed"));
      };
      void this.#write({ ...frame, id }).catch(failWrite);
    });
  }

  #write(frame: OmpFrame): Promise<void> {
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed || this.#writesClosed || this.#fatal) {
      return Promise.reject(sanitizeIo(this.#fatal ?? new Error("stdin closed"), "write failed"));
    }
    let line: string;
    try {
      line = `${JSON.stringify(frame)}\n`;
    } catch (error) {
      return Promise.reject(sanitizeIo(error, "write failed"));
    }
    if (Buffer.byteLength(line, "utf8") > this.#maxPhysical) {
      return Promise.reject(new OmpProtocolError("outbound frame exceeds physical limit"));
    }
    return new Promise<void>((resolve, reject) => {
      try {
        child.stdin.write(line, (error) => {
          if (error) {
            reject(sanitizeIo(error, "write failed"));
            return;
          }
          resolve();
        });
      } catch (error) {
        reject(sanitizeIo(error, "write failed"));
      }
    });
  }

  #attach(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.#onStdout(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    child.stdout.on("end", () => {
      this.#onStdoutEnd();
    });
    child.stdout.on("close", () => {
      this.#onStdoutEnd();
    });
    child.stdout.on("error", (error) => {
      this.#failIo(error);
    });
    child.stdin.on("error", (error) => {
      this.#failIo(error);
    });
    child.stderr.on("data", () => {
      // Drain only; never retain or log raw stderr.
    });
    child.stderr.on("error", (error) => {
      this.#failIo(error);
    });
    child.stderr.resume();
    child.on("error", (error) => {
      this.#failIo(error);
    });
    child.on("exit", (code, signal) => {
      this.#onNativeExit(code, signal);
    });
    child.on("close", (code, signal) => {
      this.#onChildClose(code, signal);
    });
    if (child.stdout.readableEnded || child.stdout.destroyed) {
      this.#onStdoutEnd();
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#onNativeExit(child.exitCode, child.signalCode);
    }
  }
  #onStdout(chunk: Buffer): void {
    if (this.#stdoutClosed) {
      return;
    }
    let offset = 0;
    while (offset < chunk.byteLength && !this.#stdoutClosed) {
      const resumed = this.#afterDiscardedLine(chunk, offset);
      if (resumed === undefined) {
        return;
      }
      offset = resumed;
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.byteLength : newline;
      const length = end - offset;
      const terminated = newline !== -1;
      if (this.#exceedsPhysicalLimit(length, terminated)) {
        this.#discardOversizedLine(!terminated);
        if (!terminated) {
          return;
        }
        offset = newline + 1;
        continue;
      }
      if (!terminated) {
        this.#appendLinePart(chunk, offset, length);
        return;
      }
      this.#completeLine(chunk, offset, length);
      offset = newline + 1;
    }
  }

  #afterDiscardedLine(chunk: Buffer, offset: number): number | undefined {
    if (!this.#discardingOversizedLine) {
      return offset;
    }
    const newline = chunk.indexOf(0x0a, offset);
    if (newline === -1) {
      return undefined;
    }
    this.#discardingOversizedLine = false;
    return newline + 1;
  }

  #exceedsPhysicalLimit(length: number, terminated: boolean): boolean {
    const total = this.#lineLength + length + (terminated ? 1 : 0);
    return terminated ? total > this.#maxPhysical : total >= this.#maxPhysical;
  }
  #discardOversizedLine(waitForNewline: boolean): void {
    const hadChunks = this.#decoder.hasPending();
    this.#line = undefined;
    this.#lineLength = 0;
    this.#discardingOversizedLine = waitForNewline;
    this.#decoder.reset();
    const error = this.#reportProtocol("physical frame exceeds limit");
    if (hadChunks) {
      this.#rejectPending(error);
    }
  }
  #appendLinePart(chunk: Buffer, offset: number, length: number): void {
    if (length === 0) {
      return;
    }
    this.#line ??= Buffer.allocUnsafe(this.#maxPhysical);
    chunk.copy(this.#line, this.#lineLength, offset, offset + length);
    this.#lineLength += length;
  }
  #completeLine(chunk: Buffer, offset: number, length: number): void {
    const buffered = this.#line;
    if (buffered === undefined) {
      this.#onLine(chunk.subarray(offset, offset + length));
      return;
    }
    if (length > 0) {
      chunk.copy(buffered, this.#lineLength, offset, offset + length);
      this.#lineLength += length;
    }
    const line = buffered.subarray(0, this.#lineLength);
    this.#line = undefined;
    this.#lineLength = 0;
    this.#onLine(line);
  }

  #onLine(line: Buffer): void {
    if (isBlankLine(line)) {
      return;
    }
    const hadChunks = this.#decoder.hasPending();
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
      this.#abandonChunkSequence("malformed JSON line", hadChunks);
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.#abandonChunkSequence("rpc frame must be an object", hadChunks);
      return;
    }
    const object = parsed as OmpFrame;
    try {
      const frame = this.#decoder.push(object);
      if (frame !== undefined) {
        this.#onFrame(frame);
      }
    } catch {
      this.#decoder.reset();
      const protocol = new OmpProtocolError("invalid rpc chunk");
      this.#reportProtocol(protocol);
      if (hadChunks) {
        this.#rejectPending(protocol);
      }
    }
  }
  #abandonChunkSequence(message: string, hadChunks: boolean): void {
    this.#decoder.reset();
    const error = this.#reportProtocol(message);
    if (hadChunks) {
      this.#rejectPending(error);
    }
  }
  #onStdoutEnd(): void {
    if (this.#stdoutClosed) {
      return;
    }
    this.#stdoutClosed = true;
    const truncated = this.#discardIncompleteInput();
    const closed = this.#fatal ?? new AgentUnavailableError("stdout closed");
    this.#forbidCommands(closed);
    this.#rejectPending(truncated ?? closed);
    this.#publishExit();
  }
  #discardIncompleteInput(): OmpProtocolError | undefined {
    const incomplete =
      this.#lineLength > 0 || this.#discardingOversizedLine || this.#decoder.hasPending();
    this.#clearInput();
    return incomplete ? this.#reportProtocol("truncated frame") : undefined;
  }
  #clearInput(): void {
    this.#line = undefined;
    this.#lineLength = 0;
    this.#discardingOversizedLine = false;
    this.#decoder.reset();
  }

  #onFrame(frame: OmpFrame): void {
    if (frame.type === "ready") {
      this.#applyLimits(frame);
      this.#settleReady?.();
    }
    this.#events.emit("frame", frame);
    if (
      frame.type === "extension_ui_request" &&
      typeof frame.id === "string" &&
      !this.#writesClosed
    ) {
      void this.#write({ type: "extension_ui_response", id: frame.id, cancelled: true }).catch(
        (error: unknown) => {
          this.#failIo(error);
        },
      );
    }
    if (frame.type !== "response" || typeof frame.id !== "string") {
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (pending === undefined || pending.command !== frame.command) {
      return;
    }
    this.#pending.delete(frame.id);
    pending.resolve(frame);
  }

  #onNativeExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#nativeExit !== undefined) {
      return;
    }
    this.#nativeExit = { code, signal };
    this.#forbidCommands(this.#fatal ?? new AgentUnavailableError("child exited"));
    if (this.#stdoutClosed) {
      this.#publishExit();
    }
  }
  #onChildClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#nativeExit === undefined) {
      this.#nativeExit = { code, signal };
      this.#forbidCommands(this.#fatal ?? new AgentUnavailableError("child exited"));
    }
    this.#onStdoutEnd();
    this.#publishExit();
  }
  #failIo(error: unknown): void {
    this.#terminateTransport(sanitizeIo(error, "io failed"));
  }
  #forbidCommands(error: Error): void {
    const already = this.#writesClosed;
    this.#writesClosed = true;
    this.#clearTimer();
    this.#settleReady?.(error);
    if (!this.#started) {
      this.#rejectPending(error);
      if (!already && this.#fatal === undefined) {
        this.#events.emit("error", error);
      }
    }
  }
  #terminateTransport(error: Error): void {
    if (this.#fatal !== undefined) {
      return;
    }
    this.#fatal = error;
    this.#writesClosed = true;
    this.#stdoutClosed = true;
    this.#clearTimer();
    this.#clearInput();
    this.#settleReady?.(error);
    this.#rejectPending(error);
    this.#events.emit("error", error);
    if (this.#nativeExit !== undefined) {
      this.#publishExit();
    }
  }
  #publishExit(): void {
    if (this.#exited || this.#nativeExit === undefined) {
      return;
    }
    this.#exited = true;
    this.#events.emit("exit", this.#nativeExit);
  }
  #reportProtocol(error: string | OmpProtocolError): OmpProtocolError {
    const protocol = typeof error === "string" ? new OmpProtocolError(error) : error;
    this.#events.emit("error", protocol);
    return protocol;
  }
  #failStartup(error: unknown): AgentUnavailableError {
    const unavailable =
      error instanceof AgentUnavailableError
        ? error
        : new AgentUnavailableError("agent_unavailable");
    const firstFailure = this.#fatal === undefined && !this.#writesClosed;
    this.#fatal = unavailable;
    this.#writesClosed = true;
    this.#clearTimer();
    if (this.#nativeExit === undefined) {
      this.#stdoutClosed = true;
      this.#clearInput();
    }
    this.#settleReady?.(unavailable);
    this.#rejectPending(unavailable);
    if (
      this.#child !== undefined &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null &&
      !this.#sentSigkill
    ) {
      this.kill("SIGKILL");
    }
    if (firstFailure) {
      this.#events.emit("error", unavailable);
    }
    return unavailable;
  }
  #rejectPending(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }

  #deadline(): { promise: Promise<never>; clear: () => void } {
    const promise = new Promise<never>((_resolve, reject) => {
      this.#handshakeTimer = setTimeout(() => {
        reject(new AgentUnavailableError("handshake timeout"));
      }, this.handshakeTimeoutMs);
    });
    return {
      promise,
      clear: () => {
        this.#clearTimer();
      },
    };
  }
  #clearTimer(): void {
    if (this.#handshakeTimer !== undefined) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = undefined;
    }
  }
  #id(): string {
    while (true) {
      this.#nextId += 1;
      const id = `omp-${this.#nextId}`;
      if (!this.#pending.has(id)) {
        return id;
      }
    }
  }
  #childDead(): boolean {
    const child = this.#child;
    return (
      this.#nativeExit !== undefined ||
      (child !== undefined && (child.exitCode !== null || child.signalCode !== null))
    );
  }
}

function asRecord(value: unknown): OmpFrame {
  return value !== null && typeof value === "object" ? (value as OmpFrame) : {};
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBlankLine(line: Buffer): boolean {
  for (const byte of line) {
    if (byte !== 0x09 && byte !== 0x0b && byte !== 0x0c && byte !== 0x0d && byte !== 0x20) {
      return false;
    }
  }
  return true;
}

function sanitizeIo(error: unknown, fallback: string): Error {
  if (error instanceof AgentUnavailableError || error instanceof OmpProtocolError) {
    return error;
  }
  return new AgentUnavailableError(fallback);
}
