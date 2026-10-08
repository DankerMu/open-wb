/**
 * Session module registration: store, supervisor, REST, SSE, and ordered teardown.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { emit } from "../core/audit/index.js";
import type { ChatEvent } from "./events.js";
import { registerSessionListEvents, type SessionListNotifier } from "./list-events.js";
import type { SpawnLog } from "./omp/spawn-gate.js";
import { registerSessionRoutes } from "./rest.js";
import { registerCommandRoutes } from "./rest-commands.js";
import { registerProjectConfigRoutes } from "./rest-project-config.js";
import type { WorkspaceRootOf } from "./session-cwd.js";
import { createSessionDeleter } from "./session-delete.js";
import { sessionSkillsResolver } from "./slash-commands.js";
import { createSessionStore, type SessionStore } from "./store.js";
import { createSessionMetadataStore, type SessionMetadataStoreOptions } from "./store-metadata.js";
import type { TodoWarn } from "./store-todo.js";
import { defaultSessionClock, registerSessionEventStream } from "./stream/sse.js";
import { SessionSupervisor, type SessionSupervisorRuntime } from "./supervisor.js";
import type { TokenRegistry } from "./tokens.js";
import { createTurnSnapshots, type TurnSnapshotService } from "./turn-snapshot.js";

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
   * The workspace store's `createTemporary` for an owner (createApp's one store), called inside
   * the session-create transaction when the request names no workspace. Sessions does not import
   * the workspaces module for it.
   */
  createTemporaryWorkspace: SessionMetadataStoreOptions["createTemporaryWorkspace"];
  /**
   * The omp agent directory whose `skills/` the slash whitelist lists (platform skills; the
   * project skills come from the session cwd under `runtime.sandboxRoot`). The caller passes
   * `ompAgentDir(stateDir)` for the same stateDir as `runtime`, i.e. `$HOME/.omp/agent` of the
   * spawn's `HOME`, omp's default agent dir; sessions never computes it a second way.
   */
  agentDir: string;
  /**
   * The app's one workspace-snapshots service (createApp binds it to the managed snapshots
   * directory and the snapshot settings); the prompt route snapshots a bound session's workspace
   * through it before each dispatch, and undo and delete remove snapshot directories through it.
   * Sessions does not import the workspaces module for it.
   */
  snapshots: TurnSnapshotService;
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
  /** Optional synchronous warn sink for a dropped task-list candidate (#864); omitted → discarded. */
  warn?: TodoWarn;
}

export function registerSessions(
  app: FastifyInstance,
  options: RegisterSessionsOptions,
): { store: SessionStore; supervisor: SessionSupervisor; listEvents: SessionListNotifier } {
  let supervisor!: SessionSupervisor;
  // Created where its route is registered (below); the turn observer and the routes run later.
  let listEvents!: SessionListNotifier;
  const store = createSessionStore(options.db, {
    onFlushError: (failure) => {
      supervisor.handleFlushError(failure);
    },
    emit,
    warn: options.warn,
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
    onEvent(sessionId, epoch, event) {
      try {
        notifyTurnChange(store, listEvents, sessionId, event);
      } catch {
        // The list notification is best effort: it never faults the turn that caused it.
      }
      return options.onEvent?.(sessionId, epoch, event);
    },
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  store.reconcileOnStartup();
  const metadata = createSessionMetadataStore(options.db, {
    emit,
    sandboxRoot: options.runtime.sandboxRoot,
    createTemporaryWorkspace: options.createTemporaryWorkspace,
  });
  const turnSnapshots = createTurnSnapshots({
    db: options.db,
    snapshots: options.snapshots,
    workspaceRootOf: options.workspaceRootOf,
    onError: options.onError,
  });
  const deleter = createSessionDeleter({
    store,
    supervisor,
    metadata,
    turnSnapshots,
    stateDir: options.runtime.stateDir,
    sandboxRoot: options.runtime.sandboxRoot,
    onError: options.onError,
  });
  registerSessionRoutes(app, {
    db: options.db,
    store,
    supervisor,
    metadata,
    workspaceRootOf: options.workspaceRootOf,
    deleter,
    agentDir: options.agentDir,
    sandboxRoot: options.runtime.sandboxRoot,
    listEvents: {
      notify(ownerId) {
        listEvents.notify(ownerId);
      },
      notifyRewound(ownerId, sessionId) {
        listEvents.notifyRewound(ownerId, sessionId);
      },
    },
    turnSnapshots,
  });
  registerCommandRoutes(app, {
    agentDir: options.agentDir,
    sandboxRoot: options.runtime.sandboxRoot,
    workspaceRootOf: options.workspaceRootOf,
  });
  registerProjectConfigRoutes(app, {
    sandboxRoot: options.runtime.sandboxRoot,
    workspaceRootOf: options.workspaceRootOf,
  });
  const clock = options.runtime.clock ?? defaultSessionClock();
  registerSessionEventStream(app, {
    store,
    supervisor,
    clock,
    isDeleting: (sessionId) => deleter.isDeleting(sessionId),
  });
  listEvents = registerSessionListEvents(app, { clock });
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
  return { store, supervisor, listEvents };
}

/** A turn's terminal state and an approval's insertion or settlement change the owner's list. */
function notifyTurnChange(
  store: SessionStore,
  listEvents: SessionListNotifier,
  sessionId: string,
  event: ChatEvent<number>,
): void {
  if (
    event.type !== "turn.end" &&
    event.type !== "approval.request" &&
    event.type !== "approval.resolved"
  ) {
    return;
  }
  const ownerId = store.runtimeState(sessionId)?.ownerId;
  if (ownerId !== undefined) {
    listEvents.notify(ownerId);
  }
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
