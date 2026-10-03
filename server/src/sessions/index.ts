/**
 * Session module registration: store, supervisor, REST, SSE, and ordered teardown.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { emit } from "../core/audit/index.js";
import type { ChatEvent } from "./events.js";
import type { SpawnLog } from "./omp/spawn-gate.js";
import { registerSessionRoutes } from "./rest.js";
import { registerCommandRoutes } from "./rest-commands.js";
import type { WorkspaceRootOf } from "./session-cwd.js";
import { createSessionDeleter } from "./session-delete.js";
import { sessionSkillsResolver } from "./slash-commands.js";
import { createSessionStore, type SessionStore } from "./store.js";
import { createSessionMetadataStore } from "./store-metadata.js";
import { defaultSessionClock, registerSessionEventStream } from "./stream/sse.js";
import { SessionSupervisor, type SessionSupervisorRuntime } from "./supervisor.js";
import type { TokenRegistry } from "./tokens.js";

export interface RegisterSessionsOptions {
  db: DatabaseSync;
  tokens: TokenRegistry;
  runtime: SessionSupervisorRuntime;
  /**
   * The workspace store's owner-scoped rootOf (createApp's one store), used only to resolve a
   * bound session's omp cwd; sessions never builds a workspace store or computes a root itself.
   */
  workspaceRootOf: WorkspaceRootOf;
  /**
   * The omp agent directory whose `skills/` the slash whitelist lists (platform skills; the
   * project skills come from the session cwd under `runtime.sandboxRoot`). The caller passes
   * `ompAgentDir(stateDir)` for the same stateDir as `runtime`, i.e. `$HOME/.omp/agent` of the
   * spawn's `HOME`, omp's default agent dir; sessions never computes it a second way.
   */
  agentDir: string;
  /**
   * Must return synchronously. A returned thenable is retained beside the source
   * fault without calling this sink again. registerSessions forwards the return
   * unchanged.
   */
  onError: (error: Error) => void;
  /**
   * Optional synchronous observer. Ordinary returns are ignored; a returned thenable
   * is an owned programming error. Omitted means no observer. The return is forwarded
   * unchanged.
   */
  onEvent?: (sessionId: string, epoch: number, event: ChatEvent<number>) => void;
  /** Optional synchronous handshake-timeout record sink, forwarded unchanged; omitted → discarded. */
  log?: SpawnLog;
}

export function registerSessions(
  app: FastifyInstance,
  options: RegisterSessionsOptions,
): { store: SessionStore; supervisor: SessionSupervisor } {
  let supervisor!: SessionSupervisor;
  const store = createSessionStore(options.db, {
    onFlushError: (failure) => {
      supervisor.handleFlushError(failure);
    },
    emit,
  });
  supervisor = new SessionSupervisor({
    store,
    tokens: options.tokens,
    runtime: options.runtime,
    workspaceRootOf: options.workspaceRootOf,
    onError: options.onError,
    skills: sessionSkillsResolver(
      options.agentDir,
      options.runtime.sandboxRoot,
      options.workspaceRootOf,
    ),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  store.reconcileOnStartup();
  const metadata = createSessionMetadataStore(options.db, { emit });
  const deleter = createSessionDeleter({
    store,
    supervisor,
    metadata,
    stateDir: options.runtime.stateDir,
    onError: options.onError,
  });
  registerSessionRoutes(app, {
    store,
    supervisor,
    metadata,
    workspaceRootOf: options.workspaceRootOf,
    deleter,
    agentDir: options.agentDir,
    sandboxRoot: options.runtime.sandboxRoot,
  });
  registerCommandRoutes(app, {
    agentDir: options.agentDir,
    sandboxRoot: options.runtime.sandboxRoot,
    workspaceRootOf: options.workspaceRootOf,
  });
  registerSessionEventStream(app, {
    store,
    supervisor,
    clock: options.runtime.clock ?? defaultSessionClock(),
    isDeleting: (sessionId) => deleter.isDeleting(sessionId),
  });
  app.addHook("preClose", (complete) => {
    void closeSessions(supervisor, store).then(
      () => {
        complete();
      },
      (error: unknown) => {
        complete(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
  return { store, supervisor };
}

async function closeSessions(supervisor: SessionSupervisor, store: SessionStore): Promise<void> {
  let shutdownError: unknown;
  try {
    await supervisor.shutdown();
  } catch (error) {
    shutdownError = error;
  }
  try {
    store.close();
  } catch (error) {
    if (shutdownError === undefined) {
      throw error;
    }
    throw new AggregateError([asError(shutdownError), asError(error)], "session teardown failed");
  }
  if (shutdownError !== undefined) {
    throw shutdownError;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
