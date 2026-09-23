import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import {
  type ControlledRuntime,
  closeFixture,
  createRealFakeRuntime,
  createSession,
  createStartHeldRuntime,
  emitAssistantDelta,
  openBareSession,
  openHeldPromptSession,
  type RealFakeRuntime,
  type SupervisorApp,
  waitFor,
} from "./session-supervisor-helpers.js";

export const LARGE_DELTA = "x".repeat(200);
export const GAP_FRAME = "id:\nevent: replay.gap\ndata: {}\n\n";

export interface OpenStream {
  abort(): void;
  resume(): void;
  bufferedBytes(): number;
  preview(): string;
  raw: ServerResponse;
}

export interface GapBackpressuredStream {
  runtime: ControlledRuntime;
  fixture: SupervisorApp;
  cookie: string;
  session: string;
  stream: OpenStream;
  writes: string[];
}

export interface HeldEventsTcp {
  runtime: RealFakeRuntime;
  app: FastifyInstance;
  db: DatabaseSync;
  cookie: string;
  session: string;
  entered: Promise<void>;
  release: () => void;
}

export interface HeldEventsConnection {
  held: HeldEventsTcp;
  req: ClientRequest;
  res: IncomingMessage | undefined;
  response: Promise<IncomingMessage>;
}

const streamBytes = new WeakMap<OpenStream, string>();

export async function openEventStream(
  fixture: SupervisorApp,
  session: string,
  cookie: string,
  lastEventId?: string,
  client?: string,
) {
  const controller = new AbortController();
  const response = await fixture.app.inject({
    method: "GET",
    url: `/api/sessions/${session}/events`,
    headers: {
      cookie,
      ...(lastEventId === undefined ? {} : { "Last-Event-ID": lastEventId }),
      ...(client === undefined ? {} : { "x-oracle-client": client }),
    },
    payloadAsStream: true,
    signal: controller.signal,
  });
  expect(response.statusCode).toBe(200);
  const readable = response.stream();
  readable.pause();
  const handle: OpenStream = {
    raw: response.raw.res,
    abort() {
      controller.abort();
      response.raw.res.destroy();
    },
    resume() {
      readable.resume();
    },
    bufferedBytes() {
      return readable.readableLength;
    },
    preview() {
      const chunk = readable.read();
      if (chunk === null) {
        return collected(handle);
      }
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const previous = streamBytes.get(handle) ?? "";
      streamBytes.set(handle, previous + text);
      return previous + text;
    },
  };
  streamBytes.set(handle, "");
  readable.on("data", (chunk: Buffer | string) => {
    const previous = streamBytes.get(handle) ?? "";
    streamBytes.set(handle, previous + chunk.toString());
  });
  return handle;
}

export async function openGapBackpressuredStream(): Promise<GapBackpressuredStream> {
  const runtime = createStartHeldRuntime();
  const writes: string[] = [];
  const { fixture, cookie, session } = await openBareSession(runtime.runtime, {
    configureApp(app) {
      wrapEventWrites(app, (_request, reply, originalWrite) => {
        return ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
          writes.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
          if (writes.length === 1) {
            return false;
          }
          return originalWrite(chunk as never, encoding as never, callback as never);
        }) as typeof reply.raw.write;
      });
    },
  });
  try {
    const stream = await openEventStream(fixture, session, cookie, "");
    return { runtime, fixture, cookie, session, stream, writes };
  } catch (error) {
    await closeFixture(fixture);
    throw error;
  }
}

export async function openLiveWriteFalseDelta(holdEnd: boolean) {
  const { fixture, cookie, session, child } = await openHeldPromptSession();
  try {
    const stream = await openEventStream(fixture, session, cookie, "1:2");
    const observed = observeRaw(stream.raw, { writeFalse: true, holdEnd });
    emitAssistantDelta(child, "!");
    return { fixture, session, child, stream, observed };
  } catch (error) {
    await closeFixture(fixture);
    throw error;
  }
}

export async function openHeartbeatPair(mode: "false" | "throw") {
  const runtime = createRealFakeRuntime();
  const writes = new Map<string, string[]>();
  const { fixture, cookie, session } = await openBareSession(runtime.runtime, {
    configureApp(app) {
      wrapEventWrites(app, (request, reply, originalWrite) => {
        const name = request.headers["x-oracle-client"];
        if (typeof name !== "string") {
          return undefined;
        }
        const recorded: string[] = [];
        writes.set(name, recorded);
        return ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
          const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
          recorded.push(text);
          if (name === "failing" && text.startsWith(":")) {
            if (mode === "throw") {
              throw new Error("controlled heartbeat writer failure");
            }
            return false;
          }
          return originalWrite(chunk as never, encoding as never, callback as never);
        }) as typeof reply.raw.write;
      });
    },
  });
  try {
    const failing = await openEventStream(fixture, session, cookie, undefined, "failing");
    const healthy = await openEventStream(fixture, session, cookie, undefined, "healthy");
    return { runtime, fixture, session, failing, healthy, writes };
  } catch (error) {
    await closeFixture(fixture);
    throw error;
  }
}

export function observeRaw(
  raw: ServerResponse,
  options: { writeFalse?: boolean; holdEnd?: boolean },
) {
  const state = { ended: false, destroyed: false, endedCalls: 0 };
  const originalWrite = raw.write.bind(raw);
  const originalEnd = raw.end.bind(raw);
  raw.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    const accepted = originalWrite(chunk as never, encoding as never, callback as never);
    if (options.writeFalse) {
      return false;
    }
    return accepted;
  }) as typeof raw.write;
  raw.end = ((...args: never[]) => {
    state.endedCalls += 1;
    if (options.holdEnd) {
      return raw;
    }
    return originalEnd(...args);
  }) as typeof raw.end;
  raw.on("finish", () => {
    state.ended = true;
  });
  raw.on("close", () => {
    state.destroyed = raw.destroyed;
  });
  return {
    get ended() {
      return state.ended;
    },
    get destroyed() {
      return state.destroyed;
    },
    get endedCalls() {
      return state.endedCalls;
    },
  };
}

export function collected(stream: OpenStream): string {
  return streamBytes.get(stream) ?? "";
}

export async function readUntil(
  stream: OpenStream,
  match: (text: string) => boolean,
): Promise<string> {
  return waitFor(() => {
    stream.resume();
    const text = collected(stream);
    return match(text) ? text : undefined;
  }, "SSE bytes");
}

export function eventCount(text: string): number {
  return [...text.matchAll(/^id: .+$/gmu)].filter((match) => match[0] !== "id: ").length;
}

export function lastDataId(text: string): string | undefined {
  const matches = [...text.matchAll(/^id: (.+)$/gmu)];
  const last = matches[matches.length - 1];
  const id = last?.[1];
  return id === undefined || id.length === 0 ? undefined : id;
}

export async function readHttpHeaders(
  port: number,
  target: string,
  cookie: string,
): Promise<string> {
  const socket = createConnection({ host: "127.0.0.1", port });
  let received = "";
  const deadline = AbortSignal.timeout(2_000);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\nConnection: keep-alive\r\n\r\n`,
    );
    await new Promise<void>((resolve, reject) => {
      const fail = (): void => {
        reject(new Error("SSE headers must arrive before first heartbeat; no response within 2s"));
      };
      deadline.addEventListener("abort", fail, { once: true });
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("latin1");
        if (received.includes("\r\n\r\n")) {
          deadline.removeEventListener("abort", fail);
          resolve();
        }
      });
      socket.once("error", reject);
      socket.once("end", () => reject(new Error("socket ended before headers")));
    });
    return received.slice(0, received.indexOf("\r\n\r\n") + 4);
  } finally {
    socket.destroy();
  }
}

export async function openHeldEventsTcp(
  onHold?: (
    request: { raw: IncomingMessage },
    reply: { raw: ServerResponse },
  ) => void | Promise<void>,
  extra?: (app: FastifyInstance) => void,
): Promise<HeldEventsTcp> {
  const runtime = createRealFakeRuntime();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredGate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const db = openDb(":memory:");
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      tokens: new TokenRegistry(),
      runtime: runtime.runtime,
      onError() {},
    },
  });
  extra?.(app);
  app.addHook("preHandler", async (request, reply) => {
    if (request.url.endsWith("/events")) {
      await onHold?.(request, reply);
      entered();
      await held;
    }
  });
  const cookie = await cookieFor(app, "zhangsan");
  const session = await createSession(app, cookie);
  return { runtime, app, db, cookie, session, entered: enteredGate, release };
}

export async function connectHeldEventsTcp(held: HeldEventsTcp): Promise<HeldEventsConnection> {
  const origin = await held.app.listen({ host: "127.0.0.1", port: 0 });
  let req!: ClientRequest;
  let res: IncomingMessage | undefined;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req = httpRequest(
      `${origin}/api/sessions/${held.session}/events`,
      { headers: { cookie: held.cookie } },
      (reply) => {
        res = reply;
        reply.resume();
        resolve(reply);
      },
    );
    req.on("error", (error) => {
      reject(error);
    });
    req.end();
  });
  void response.catch(() => {});
  return {
    held,
    get req() {
      return req;
    },
    get res() {
      return res;
    },
    response,
  };
}

export async function closeHeldEventsConnection(connection: HeldEventsConnection): Promise<void> {
  await closeHeldEventsTcp(connection.held, connection.req, connection.res);
}

async function closeHeldEventsTcp(
  held: HeldEventsTcp,
  req?: ClientRequest,
  res?: IncomingMessage,
): Promise<void> {
  held.release();
  res?.destroy();
  req?.destroy();
  try {
    await held.app.close();
  } catch {
    /* already closed */
  }
  held.db.close();
}

function wrapEventWrites(
  app: FastifyInstance,
  decorate: (
    request: { headers: Record<string, unknown> },
    reply: { raw: ServerResponse },
    originalWrite: ServerResponse["write"],
  ) => ServerResponse["write"] | undefined,
): void {
  app.addHook("onRequest", (request, reply, done) => {
    if (!request.url.endsWith("/events")) {
      done();
      return;
    }
    const originalWrite = reply.raw.write.bind(reply.raw);
    const next = decorate(request, reply, originalWrite);
    if (next !== undefined) {
      reply.raw.write = next;
    }
    done();
  });
}
