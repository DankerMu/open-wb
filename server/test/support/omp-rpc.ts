/**
 * Shared Issue #95 protocol-test lifecycle and observation helpers.
 * Observation waits on real frame/exit events and never synthesizes termination.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect } from "vitest";
import type { OmpFrame } from "../../src/sessions/omp/frame.js";
import {
  type OmpExit,
  OmpProcess,
  type OmpProcessOpts,
  OmpProtocolError,
  type SpawnImpl,
} from "../../src/sessions/omp/process.js";

export const DEFAULT_SESSION = "/tmp/open-wb-fake-session.jsonl";
export const RPC_PHYSICAL_LIMIT = 1_048_576;
export const RPC_LOGICAL_LIMIT = 67_108_864;
export const RPC_CHUNK_PAYLOAD = 256 * 1024;
export const DEFAULT_READY: OmpFrame = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: RPC_PHYSICAL_LIMIT,
  maxReassembledFrameBytes: RPC_LOGICAL_LIMIT,
};

export const IO_ERROR_SOURCES = ["child", "stdin", "stdout", "stderr"] as const;
export type IoErrorSource = (typeof IO_ERROR_SOURCES)[number];

export class RpcHarness {
  readonly procs: OmpProcess[] = [];
  readonly temps: string[] = [];
  readonly timers: ReturnType<typeof setTimeout>[] = [];
  readonly children: ChildProcessWithoutNullStreams[] = [];
  readonly fakes: FakeChild[] = [];

  manage(proc: OmpProcess): OmpProcess {
    this.procs.push(proc);
    return proc;
  }

  fake(): FakeChild {
    const child = new FakeChild();
    this.fakes.push(child);
    return child;
  }

  tempOpts(token: string, prefix = "omp-rpc-"): OmpProcessOpts {
    const root = mkdtempSync(join(tmpdir(), prefix));
    this.temps.push(root);
    return {
      bin: join(root, "omp-bin"),
      sandboxRoot: join(root, "sandbox"),
      stateDir: join(root, "state"),
      ownerId: "u1",
      modelId: "deepseek-v4.1-flash",
      token,
      resumePath: null,
    };
  }

  collectFrames(proc: OmpProcess): OmpFrame[] {
    const frames: OmpFrame[] = [];
    proc.on("frame", (frame) => {
      frames.push(frame);
    });
    return frames;
  }

  collectErrors(proc: OmpProcess): unknown[] {
    const errors: unknown[] = [];
    proc.on("error", (error) => {
      errors.push(error);
    });
    return errors;
  }

  waitFrame(
    proc: OmpProcess,
    predicate: (frame: OmpFrame) => boolean,
    ms = 8_000,
    frames: OmpFrame[] = [],
  ): Promise<OmpFrame> {
    const existing = frames.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for frame"));
      }, ms);
      this.timers.push(timer);
      proc.on("frame", (frame) => {
        if (!predicate(frame)) {
          return;
        }
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  waitExit(proc: OmpProcess, ms = 8_000): Promise<OmpExit> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for observed child exit"));
      }, ms);
      this.timers.push(timer);
      proc.on("exit", (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
  }

  includesSecret(error: unknown, token: string): boolean {
    const text =
      error instanceof Error
        ? `${error.name}\n${error.message}\n${error.stack ?? ""}`
        : String(error);
    return text.includes(token);
  }

  async cleanup(): Promise<void> {
    for (const timer of this.timers.splice(0)) {
      clearTimeout(timer);
    }
    for (const proc of this.procs.splice(0)) {
      proc.kill("SIGKILL");
    }
    await Promise.all(this.children.splice(0).map(stopChild));
    for (const fake of this.fakes.splice(0)) {
      fake.destroy();
    }
    for (const dir of this.temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function createRpcHarness(): RpcHarness {
  const harness = new RpcHarness();
  afterEach(async () => {
    await harness.cleanup();
  });
  return harness;
}

export function parseJsonl(text: string): OmpFrame[] {
  const frames: OmpFrame[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    frames.push(JSON.parse(line) as OmpFrame);
  }
  return frames;
}

export function asRecord(value: unknown): OmpFrame {
  return value !== null && typeof value === "object" ? (value as OmpFrame) : {};
}

export function hasTerminated(child: ChildProcessWithoutNullStreams | undefined): boolean {
  return child !== undefined && (child.exitCode !== null || child.signalCode !== null);
}

export function negotiateOk(id: string): OmpFrame {
  return {
    id,
    type: "response",
    command: "negotiate_protocol",
    success: true,
    data: { protocolVersion: 2 },
  };
}

function stateOk(id: string, sessionFile = DEFAULT_SESSION): OmpFrame {
  return {
    id,
    type: "response",
    command: "get_state",
    success: true,
    data: { sessionFile },
  };
}

export interface PromiseObservation {
  outcome: "pending" | "resolved" | "rejected";
  settlements: number;
}

export function observePromise<T>(promise: Promise<T>): PromiseObservation {
  const observation: PromiseObservation = { outcome: "pending", settlements: 0 };
  void promise.then(
    () => {
      observation.outcome = "resolved";
      observation.settlements += 1;
    },
    () => {
      observation.outcome = "rejected";
      observation.settlements += 1;
    },
  );
  return observation;
}

export function capturePromptFrames(child: FakeChild): OmpFrame[] {
  const frames: OmpFrame[] = [];
  child.onCommand("prompt", (frame) => {
    frames.push(frame);
  });
  return frames;
}

export function expectProtocolError(errors: unknown[]): void {
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(OmpProtocolError);
}

export function rpcChunkFrames(bytes: Buffer, chunkId: string): OmpFrame[] {
  const count = Math.ceil(bytes.byteLength / RPC_CHUNK_PAYLOAD);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId,
    index,
    count,
    byteLength: bytes.byteLength,
    data: bytes
      .subarray(index * RPC_CHUNK_PAYLOAD, (index + 1) * RPC_CHUNK_PAYLOAD)
      .toString("base64"),
  }));
}

export function openFakeProcess(
  harness: RpcHarness,
  token: string,
  options: { handshakeTimeoutMs?: number; prefix?: string } = {},
): {
  child: FakeChild;
  proc: OmpProcess;
  frames: OmpFrame[];
  errors: unknown[];
} {
  const child = harness.fake();
  const proc = harness.manage(
    new OmpProcess({
      ...harness.tempOpts(token, options.prefix ?? "omp-rpc-io-"),
      spawnImpl: child.spawnImpl,
      ...(options.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    }),
  );
  return {
    child,
    proc,
    frames: harness.collectFrames(proc),
    errors: harness.collectErrors(proc),
  };
}

export async function startFakeProcess(
  harness: RpcHarness,
  token: string,
  options: { handshakeTimeoutMs?: number; prefix?: string; ready?: OmpFrame } = {},
): Promise<{
  child: FakeChild;
  proc: OmpProcess;
  frames: OmpFrame[];
  errors: unknown[];
}> {
  const opened = openFakeProcess(harness, token, options);
  opened.child.emitLine(options.ready ?? DEFAULT_READY);
  opened.child.replyHandshake();
  await expect(opened.proc.start()).resolves.toEqual({ sessionFile: DEFAULT_SESSION });
  return opened;
}

export function emitIoFailure(child: FakeChild, source: IoErrorSource, token: string): void {
  const error = new Error(`EIO ${token}`);
  switch (source) {
    case "child":
      child.emit("error", error);
      return;
    case "stdin":
      child.stdin.emit("error", error);
      return;
    case "stdout":
      child.stdout.emit("error", error);
      return;
    case "stderr":
      child.stderr.emit("error", error);
      return;
  }
}

export async function expectInterruptedRequest(
  pending: Promise<OmpFrame>,
  id: string,
  frames: OmpFrame[],
  errors: unknown[],
): Promise<void> {
  await expect(pending).rejects.toBeInstanceOf(OmpProtocolError);
  expect(frames.some((frame) => frame.id === id && frame.type === "response")).toBe(false);
  expect(errors).toContainEqual(expect.any(OmpProtocolError));
}

export function startUnreadyFake(
  harness: RpcHarness,
  token: string,
  afterSpawn?: (child: FakeChild) => void,
): {
  child: FakeChild;
  observation: PromiseObservation;
  spawned: Promise<void>;
  started: Promise<{ sessionFile: string }>;
} {
  const child = harness.fake();
  let markSpawned: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  const spawnImpl: SpawnImpl = (command, args, options) => {
    const spawnedChild = child.spawnImpl(command, args, options);
    markSpawned?.();
    afterSpawn?.(child);
    return spawnedChild;
  };
  const proc = harness.manage(
    new OmpProcess({
      ...harness.tempOpts(token, "omp-rpc-io-"),
      handshakeTimeoutMs: 60_000,
      spawnImpl,
    }),
  );
  const started = proc.start();
  return { child, observation: observePromise(started), spawned, started };
}

export class FakeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly spawnImpl: SpawnImpl;
  readonly #emitter = new EventEmitter();
  readonly #handlers: Record<string, (frame: OmpFrame) => void> = {};
  #pending = "";

  constructor() {
    this.spawnImpl = () => {
      this.stdin.on("data", (chunk: Buffer | string) => {
        this.#pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let newline = this.#pending.indexOf("\n");
        while (newline !== -1) {
          const line = this.#pending.slice(0, newline);
          this.#pending = this.#pending.slice(newline + 1);
          if (line.trim().length > 0) {
            const frame = JSON.parse(line) as OmpFrame;
            this.#handlers[String(frame.type)]?.(frame);
          }
          newline = this.#pending.indexOf("\n");
        }
      });
      return this as unknown as ChildProcessWithoutNullStreams;
    };
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.#emitter.on(event, listener);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    this.#emitter.once(event, listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    return this.#emitter.emit(event, ...args);
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) {
      return false;
    }
    this.exit(null, signal);
    return true;
  }

  onCommand(type: string, handler: (frame: OmpFrame) => void): void {
    this.#handlers[type] = handler;
  }

  replyHandshake(handshake: { sessionFile?: string; afterState?: () => void } = {}): void {
    this.onCommand("negotiate_protocol", (frame) => {
      this.emitLine(negotiateOk(String(frame.id)));
    });
    this.onCommand("get_state", (frame) => {
      this.emitLine(stateOk(String(frame.id), handshake.sessionFile ?? DEFAULT_SESSION));
      handshake.afterState?.();
    });
  }

  emitLine(frame: OmpFrame): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  emitRaw(text: string): void {
    this.stdout.write(text);
  }

  endStdout(): void {
    this.stdout.end();
  }

  failWrites(error: Error): void {
    this.stdin.write = ((_chunk, encodingOrCb, cb) => {
      const done = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      if (typeof done === "function") {
        done(error);
      } else {
        this.stdin.emit("error", error);
      }
      return false;
    }) as typeof this.stdin.write;
  }

  nativeExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.#emitter.emit("exit", code, signal);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.nativeExit(code, signal);
    this.#emitter.emit("close", code, signal);
  }

  destroy(): void {
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    if (this.exitCode === null && this.signalCode === null) {
      this.exit(0);
    }
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => {
      resolve();
    });
  });
}
