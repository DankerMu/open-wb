/**
 * Issue #931 session list event connection: a per-account notifier and `GET /api/sessions/events`.
 * Notification only: no payload beyond the event name, no event ring, no `id:` lines, no replay.
 */
import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import type { SessionClock } from "./omp/runtime.js";
import { currentPrincipal, noStoreSessionHeaders } from "./rest.js";
import { HEARTBEAT_MS, rejectWhenClosing, SSE_HEADERS, writeHeartbeat } from "./stream/sse.js";

const CHANGED_FRAME = "event: sessions.changed\ndata: {}\n\n";

export interface SessionListNotifier {
  /** Tells every list connection of this owner to re-read the list. Never throws. */
  notify(ownerId: string): void;
  /** Tells every list connection of this owner that a session was rewound. Never throws. */
  notifyRewound(ownerId: string, sessionId: string): void;
}

export interface SessionListEventsOptions {
  clock: SessionClock;
}

interface ListConnection {
  ownerId: string;
  raw: ServerResponse;
  heartbeat: unknown;
  /** A `sessions.changed` was handed to `write` and its callback has not fired yet. */
  changedPending: boolean;
  closed: boolean;
}

export function registerSessionListEvents(
  app: FastifyInstance,
  options: SessionListEventsOptions,
): SessionListNotifier {
  const { clock } = options;
  const byOwner = new Map<string, Set<ListConnection>>();
  let closing = false;

  const release = (connection: ListConnection): void => {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    clock.clearTimeout(connection.heartbeat);
    const owned = byOwner.get(connection.ownerId);
    owned?.delete(connection);
    if (owned?.size === 0) {
      byOwner.delete(connection.ownerId);
    }
  };
  const destroy = (connection: ListConnection): void => {
    release(connection);
    if (!connection.raw.destroyed) {
      connection.raw.destroy();
    }
  };
  /** The per-session stream's rule: a heartbeat the transport does not take ends the connection. */
  const armHeartbeat = (connection: ListConnection): void => {
    connection.heartbeat = clock.setTimeout(() => {
      if (connection.closed) {
        return;
      }
      try {
        if (!writeHeartbeat(connection.raw)) {
          release(connection);
          connection.raw.end();
          return;
        }
      } catch {
        destroy(connection);
        return;
      }
      armHeartbeat(connection);
    }, HEARTBEAT_MS);
  };
  /** A failed write closes this connection only; nothing reaches the notifier's caller. */
  const send = (connection: ListConnection, frame: string, written?: () => void): void => {
    if (connection.raw.destroyed || connection.raw.writableEnded) {
      destroy(connection);
      return;
    }
    try {
      connection.raw.write(frame, (error) => {
        written?.();
        if (error) {
          destroy(connection);
        }
      });
    } catch {
      destroy(connection);
    }
  };
  const each = (ownerId: string, visit: (connection: ListConnection) => void): void => {
    for (const connection of [...(byOwner.get(ownerId) ?? [])]) {
      visit(connection);
    }
  };

  app.addHook("preClose", (complete) => {
    closing = true;
    for (const owned of [...byOwner.values()]) {
      for (const connection of [...owned]) {
        destroy(connection);
      }
    }
    complete();
  });

  app.get("/api/sessions/events", { onRequest: noStoreSessionHeaders }, (request, reply) => {
    const ownerId = currentPrincipal(request).id;
    rejectWhenClosing(reply, closing);
    reply.hijack();
    const raw = reply.raw;
    const connection: ListConnection = {
      ownerId,
      raw,
      heartbeat: undefined,
      changedPending: false,
      closed: false,
    };
    const onClose = (): void => {
      release(connection);
    };
    raw.on("close", onClose);
    raw.on("error", () => {
      destroy(connection);
    });
    request.raw.once("aborted", onClose);
    if (raw.destroyed || raw.writableEnded || request.raw.aborted) {
      return;
    }
    const owned = byOwner.get(ownerId) ?? new Set<ListConnection>();
    byOwner.set(ownerId, owned);
    owned.add(connection);
    raw.writeHead(200, SSE_HEADERS);
    raw.flushHeaders();
    armHeartbeat(connection);
  });

  return {
    notify(ownerId) {
      each(ownerId, (connection) => {
        if (connection.changedPending) {
          return;
        }
        connection.changedPending = true;
        send(connection, CHANGED_FRAME, () => {
          connection.changedPending = false;
        });
      });
    },
    notifyRewound(ownerId, sessionId) {
      const frame = `event: session.rewound\ndata: ${JSON.stringify({ sessionId })}\n\n`;
      each(ownerId, (connection) => {
        send(connection, frame);
      });
    },
  };
}
