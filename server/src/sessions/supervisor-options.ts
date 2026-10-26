/**
 * The session supervisor's construction options and its runtime settings (supervisor.ts re-exports
 * both): what createApp and registerSessions hand it.
 */
import type { effectiveCapabilities } from "./composer-align.js";
import type { ChatEvent } from "./events.js";
import type { SpawnImpl } from "./omp/process.js";
import type { SessionClock } from "./omp/runtime.js";
import type { SpawnLog } from "./omp/spawn-gate.js";
import type { WorkspaceRootOf } from "./session-cwd.js";
import type { SessionStore } from "./store.js";
import type { ComposerConfig } from "./store-composer.js";
import type { TokenRegistry } from "./tokens.js";

export interface SessionSupervisorRuntime {
  bin: string;
  sandboxRoot: string;
  stateDir: string;
  modelId: string; // The single model's id when the assembly gives no whitelist; no spawn reads it.
  idleMs?: number;
  /** Global live-process cap resolved by agent-config; undefined → DEFAULT_OMP_MAX_PROCESSES (16). */
  maxProcesses?: number;
  /** Concurrent spawn cap resolved by agent-config; undefined → os.availableParallelism(). */
  spawnConcurrency?: number;
  ompUser?: string;
  browserBin?: string;
  spawnImpl?: SpawnImpl;
  clock?: SessionClock;
  handshakeTimeoutMs?: number;
}

export interface SessionSupervisorOptions {
  store: SessionStore;
  tokens: TokenRegistry;
  runtime: SessionSupervisorRuntime;
  /** The workspace store's owner-scoped rootOf: a bound session's cwd (session-cwd.ts). */
  workspaceRootOf: WorkspaceRootOf;
  /**
   * Must return synchronously. A returned thenable is an owned programming error;
   * its rejection is consumed and is not a second fault. A thrown then getter uses
   * the existing synchronous fault path. Every spawn path also hands it, raw and never retained,
   * each session config file it could not remove (omp-runtime「子进程 spawn 契约」).
   */
  onError: (error: Error) => void;
  /**
   * Optional and synchronous. Ordinary non-thenable returns are ignored. A returned
   * thenable stops publication for that pump and retires its runtime through the
   * existing ownership path. Omitted means no observer.
   */
  onEvent?: (sessionId: string, epoch: number, event: ChatEvent<number>) => void;
  /** Synchronous handshake-timeout record sink, never an onError fault; omitted → discarded. */
  log?: SpawnLog;
  /** createApp's sanitiser bound to its secret list (#909): every `error` detail goes through it. */
  redactUpstream: (text: string) => string;
  /** The skills of a session's cwd right now, for the branch-family command check (branching.ts). */
  skills: (ownerId: string, workspaceId: string | null) => Promise<readonly { name: string }[]>;
  /** What turns a session's raw composer columns into the mode and model of its spawns. */
  composer: ComposerConfig;
  /** The prompt of an expert its owner can see, else null (experts「专家提示词注入」); never cached. */
  expertPrompt: Parameters<typeof effectiveCapabilities>[0];
  /**
   * The registered mount names of a workspace right now (the sandbox facade's, D21): a bound
   * session's file-change candidates inside one are dropped untouched. Omitted means none.
   */
  mountNamesOf?: (workspaceId: string) => ReadonlySet<string>;
}
