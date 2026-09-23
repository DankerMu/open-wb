/**
 * Issue #103 authenticated session SSE transport.
 */
import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../../core/errors/index.js";
import type { SessionClock } from "../omp/runtime.js";
import { noStoreSessionHeaders, requireOwnedSession, type SessionOwnerStore } from "../rest.js";
import type { SessionSupervisor } from "../supervisor.js";
import type { RetainedEvent } from "./ring-buffer.js";

const HEARTBEAT_MS = 15_000;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
} as const;

export interface SessionEventStreamOptions {
  store: SessionOwnerStore;
  supervisor: SessionSupervisor;
  clock: SessionClock;
}

interface SessionIdParams {
  id: string;
}

interface StreamConnection {
  raw: ServerResponse;
  heartbeat: NodeJS.Timeout | undefined;
  phase: "replay" | "live";
  replay: RetainedEvent[];
  replayIndex: number;
  paused: boolean;
  logicalClosed: boolean;
  unsubscribe: () => void;
}

const realClock: SessionClock = {
  now() {
    return Date.now();
  },
  setTimeout(callback, ms) {
    return setTimeout(callback, ms);
  },
  clearTimeout(id) {
    clearTimeout(id as NodeJS.Timeout);
  },
};

export function defaultSessionClock(): SessionClock {
  return realClock;
}

export function registerSessionEventStream(
  app: FastifyInstance,
  options: SessionEventStreamOptions,
): void {
  const connections = new Set<StreamConnection>();
  let closing = false;

  app.addHook("preClose", (complete) => {
    closing = true;
    for (const connection of [...connections]) {
      releaseLogical(connection, options.clock);
      if (!connection.raw.destroyed) {
        connection.raw.destroy();
      }
    }
    complete();
  });

  app.get<{ Params: SessionIdParams }>(
    "/api/sessions/:id/events",
    { onRequest: noStoreSessionHeaders },
    (request, reply) => {
      requireOwnedSession(options.store, request);
      if (closing) {
        reply.header("Connection", "close");
        reply.raw.setHeader("Connection", "close");
        throw new HttpError("agent_unavailable");
      }
      attachEventStream(request, reply, options, connections, () => closing);
    },
  );
}

function attachEventStream(
  request: FastifyRequest<{ Params: SessionIdParams }>,
  reply: FastifyReply,
  options: SessionEventStreamOptions,
  connections: Set<StreamConnection>,
  isClosing: () => boolean,
): void {
  const sessionId = request.params.id;
  const lastEventId = lastEventIdFrom(request);
  if (isClosing()) {
    reply.header("Connection", "close");
    reply.raw.setHeader("Connection", "close");
    throw new HttpError("agent_unavailable");
  }
  reply.hijack();
  const raw = reply.raw;
  const connection: StreamConnection = {
    raw,
    heartbeat: undefined,
    phase: "replay",
    replay: [],
    replayIndex: 0,
    paused: false,
    logicalClosed: false,
    unsubscribe() {},
  };
  connections.add(connection);

  const onPhysicalClose = (): void => {
    releaseLogical(connection, options.clock);
    connections.delete(connection);
    raw.off("close", onPhysicalClose);
    raw.off("error", onTransportError);
    request.raw.off("aborted", onPhysicalClose);
    raw.off("drain", onDrain);
  };
  const onTransportError = (): void => {
    releaseLogical(connection, options.clock);
    if (!raw.destroyed) {
      raw.destroy();
    }
  };
  const onDrain = (): void => {
    if (connection.logicalClosed || !connection.paused) {
      return;
    }
    connection.paused = false;
    flushReplay(connection, options.clock);
  };
  raw.on("close", onPhysicalClose);
  raw.on("error", onTransportError);
  request.raw.once("aborted", onPhysicalClose);
  raw.on("drain", onDrain);
  connection.unsubscribe = () => {
    raw.off("drain", onDrain);
  };

  raw.writeHead(200, SSE_HEADERS);
  raw.flushHeaders();

  if (isClosing()) {
    releaseLogical(connection, options.clock);
    if (!raw.destroyed) {
      raw.destroy();
    }
    return;
  }

  const subscription = options.supervisor.subscribe(sessionId, lastEventId, (event) => {
    if (connection.logicalClosed) {
      return;
    }
    if (connection.phase === "replay" || connection.paused) {
      endOwned(connection, options.clock);
      return;
    }
    writeLive(connection, event, options.clock);
  });
  const releaseTransport = connection.unsubscribe;
  connection.unsubscribe = () => {
    releaseTransport();
    subscription.unsubscribe();
  };
  connection.replay = subscription.replay;
  if (subscription.mode === "gap") {
    const accepted = writeFrame(connection, gapFrame(), options.clock, false);
    if (connection.logicalClosed) {
      return;
    }
    if (!accepted) {
      pauseReplay(connection, options.clock);
      return;
    }
  }
  flushReplay(connection, options.clock);
}

function flushReplay(connection: StreamConnection, clock: SessionClock): void {
  while (!connection.logicalClosed && connection.replayIndex < connection.replay.length) {
    const event = connection.replay[connection.replayIndex];
    if (event === undefined) {
      connection.replayIndex += 1;
      continue;
    }
    const accepted = writeFrame(connection, dataFrame(event), clock, false);
    connection.replayIndex += 1;
    if (!accepted) {
      pauseReplay(connection, clock);
      return;
    }
  }
  if (connection.logicalClosed) {
    return;
  }
  connection.phase = "live";
  connection.replay = [];
  connection.paused = false;
  armHeartbeat(connection, clock);
}

function pauseReplay(connection: StreamConnection, clock: SessionClock): void {
  if (connection.logicalClosed) {
    return;
  }
  connection.paused = true;
  stopHeartbeat(connection, clock);
}

function writeLive(connection: StreamConnection, event: RetainedEvent, clock: SessionClock): void {
  const accepted = writeFrame(connection, dataFrame(event), clock, true);
  if (!accepted && !connection.logicalClosed) {
    endOwned(connection, clock);
  }
}

function writeFrame(
  connection: StreamConnection,
  frame: string,
  clock: SessionClock,
  liveBackpressureEnds: boolean,
): boolean {
  if (connection.logicalClosed || connection.raw.destroyed || connection.raw.writableEnded) {
    releaseLogical(connection, clock);
    return false;
  }
  try {
    const accepted = connection.raw.write(frame);
    if (!accepted && liveBackpressureEnds) {
      endOwned(connection, clock);
      return false;
    }
    return accepted;
  } catch {
    destroyOwned(connection, clock);
    return false;
  }
}

function armHeartbeat(connection: StreamConnection, clock: SessionClock): void {
  stopHeartbeat(connection, clock);
  if (connection.logicalClosed || connection.paused) {
    return;
  }
  const timer = clock.setTimeout(() => {
    if (connection.logicalClosed || connection.paused) {
      return;
    }
    try {
      const accepted = connection.raw.write(": keepalive\n\n");
      if (!accepted) {
        endOwned(connection, clock);
        return;
      }
    } catch {
      destroyOwned(connection, clock);
      return;
    }
    armHeartbeat(connection, clock);
  }, HEARTBEAT_MS);
  connection.heartbeat = timer as NodeJS.Timeout;
}

function stopHeartbeat(connection: StreamConnection, clock: SessionClock): void {
  if (connection.heartbeat === undefined) {
    return;
  }
  clock.clearTimeout(connection.heartbeat);
  connection.heartbeat = undefined;
}

function releaseLogical(connection: StreamConnection, clock: SessionClock): void {
  if (connection.logicalClosed) {
    return;
  }
  connection.logicalClosed = true;
  connection.paused = false;
  stopHeartbeat(connection, clock);
  connection.unsubscribe();
}

function endOwned(connection: StreamConnection, clock: SessionClock): void {
  releaseLogical(connection, clock);
  if (!connection.raw.writableEnded && !connection.raw.destroyed) {
    connection.raw.end();
  }
}

function destroyOwned(connection: StreamConnection, clock: SessionClock): void {
  releaseLogical(connection, clock);
  if (!connection.raw.destroyed) {
    connection.raw.destroy();
  }
}

function lastEventIdFrom(request: FastifyRequest): string | null {
  const header = request.headers["last-event-id"];
  if (typeof header === "string") {
    return header;
  }
  if (Array.isArray(header) && typeof header[0] === "string") {
    return header[0];
  }
  return null;
}

function dataFrame(event: RetainedEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function gapFrame(): string {
  return "id:\nevent: replay.gap\ndata: {}\n\n";
}
