/**
 * Session module registration: store, supervisor, REST, and ordered teardown.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ChatEvent } from "./events.js";
import { registerSessionRoutes } from "./rest.js";
import { createSessionStore, type SessionStore } from "./store.js";
import { SessionSupervisor, type SessionSupervisorRuntime } from "./supervisor.js";
import type { TokenRegistry } from "./tokens.js";

export interface RegisterSessionsOptions {
  db: DatabaseSync;
  tokens: TokenRegistry;
  runtime: SessionSupervisorRuntime;
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
  });
  supervisor = new SessionSupervisor({
    store,
    tokens: options.tokens,
    runtime: options.runtime,
    onError: options.onError,
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  store.reconcileOnStartup();
  registerSessionRoutes(app, { store, supervisor });
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
