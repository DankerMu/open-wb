/**
 * Issue #103 authenticated session SSE at GET /api/sessions/:id/events.
 * Expected status, headers, frames, and envelopes are fixture literals.
 */
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { NOT_FOUND_ENVELOPE, UNAUTHORIZED_ENVELOPE } from "./auth-lifecycle-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor, UNKNOWN_SESSION_ID } from "./session-rest-helpers.js";
import {
  type ControlledRuntime,
  closeFixture,
  createRealFakeRuntime,
  createSession,
  createStartHeldRuntime,
  emitAssistantDelta,
  openBareSession,
  openBulkDeltaSession,
  openHeldPromptSession,
  openStartHeldSession,
  type SupervisorApp,
  startHeldTurn,
  waitFor,
  waitForContent,
} from "./session-supervisor-helpers.js";

const LARGE_DELTA = "x".repeat(200);
const GAP_FRAME = "id:\nevent: replay.gap\ndata: {}\n\n";

afterEach(() => {
  vi.useRealTimers();
});

describe("authenticated session event stream", () => {
  it("returns 200 SSE headers on an assembled owned GET without waiting for end", async () => {
    const runtime = createRealFakeRuntime();
    const { fixture, cookie, session } = await openBareSession(runtime.runtime);
    try {
      const response = await fixture.app.inject({
        method: "GET",
        url: `/api/sessions/${session}/events`,
        headers: { cookie },
        payloadAsStream: true,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.connection).toBe("keep-alive");
      expect(runtime.calls).toHaveLength(0);
      response.raw.res.destroy();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("flushes real HTTP SSE headers to an idle client before any event", {
    timeout: 15_000,
  }, async () => {
    const runtime = createRealFakeRuntime();
    const { fixture, cookie, session } = await openBareSession(runtime.runtime);
    try {
      await fixture.app.listen({ host: "127.0.0.1", port: 0 });
      const address = fixture.app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test app did not bind a TCP address");
      }
      const headers = await readHttpHeaders(
        address.port,
        `/api/sessions/${session}/events`,
        cookie,
      );
      expect(headers).toMatch(/^HTTP\/1\.1 200 /u);
      expect(headers).toMatch(/content-type: text\/event-stream; charset=utf-8/iu);
      expect(headers).toMatch(/cache-control: no-store/iu);
      expect(headers).toMatch(/connection: keep-alive/iu);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rejects anonymous, foreign-owner, and missing sessions before SSE frames", async () => {
    const runtime = createRealFakeRuntime();
    const { fixture, cookie, session } = await openBareSession(runtime.runtime);
    try {
      const anonymous = await fixture.app.inject({
        method: "GET",
        url: `/api/sessions/${session}/events`,
      });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toEqual(UNAUTHORIZED_ENVELOPE);
      expect(anonymous.headers["content-type"]).not.toMatch(/text\/event-stream/u);

      const foreignCookie = await cookieFor(fixture.app, "zhaoliu");
      const foreignResponse = await fixture.app.inject({
        method: "GET",
        url: `/api/sessions/${session}/events`,
        headers: { cookie: foreignCookie },
      });
      expect(foreignResponse.statusCode).toBe(404);
      expect(foreignResponse.json()).toEqual(NOT_FOUND_ENVELOPE);
      expect(foreignResponse.headers["content-type"]).not.toMatch(/text\/event-stream/u);

      const missing = await fixture.app.inject({
        method: "GET",
        url: `/api/sessions/${UNKNOWN_SESSION_ID}/events`,
        headers: { cookie },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual(NOT_FOUND_ENVELOPE);
      expect(missing.headers["content-type"]).not.toMatch(/text\/event-stream/u);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("round-trips exact JSON, empty-id gap, and comment keepalive at 15000ms", {
    timeout: 15_000,
  }, async () => {
    const { runtime, fixture, cookie, session, child } = await openHeldPromptSession();
    try {
      const special = "line1\nline2\u0000\uFEFFπ";
      emitAssistantDelta(child, special);
      await waitForContent(fixture, session, `Hello${special}`);

      const stream = await openEventStream(fixture, session, cookie, "1:1");
      const replay = await readUntil(stream, (text) => text.includes("event: text.delta"));
      expect(replay).toContain(
        `id: 1:2\nevent: text.delta\ndata: ${JSON.stringify({ messageId: 2, delta: "Hello" })}\n\n`,
      );
      expect(replay).toContain(
        `id: 1:3\nevent: text.delta\ndata: ${JSON.stringify({ messageId: 2, delta: special })}\n\n`,
      );

      runtime.clock.advance(14_999);
      expect(collected(stream)).not.toContain(": keepalive");
      runtime.clock.advance(1);
      expect(collected(stream)).toContain(": keepalive\n\n");

      const gapStream = await openEventStream(fixture, session, cookie, "");
      const gap = await readUntil(gapStream, (text) => text.includes("event: replay.gap"));
      expect(gap.startsWith(GAP_FRAME)).toBe(true);
      gapStream.abort();
      stream.abort();
      await waitFor(
        () => (fixture.supervisor.sessionStreamSubscriberCount(session) === 0 ? true : undefined),
        "keepalive subscribers cleared",
      );
    } finally {
      await closeFixture(fixture);
    }
  });

  it("pauses a false replay.gap write through heartbeat and resumes live delivery on drain", {
    timeout: 15_000,
  }, async () => {
    const opened = await openGapBackpressuredStream();
    const { runtime, fixture, cookie, session, stream, writes } = opened;
    try {
      expect(writes).toEqual([GAP_FRAME]);
      runtime.clock.advance(15_000);
      expect(writes).toEqual([GAP_FRAME]);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(1);

      stream.raw.emit("drain");
      await startHeldTurn({ runtime, fixture, cookie, session });
      const delivered = await readUntil(stream, (text) => text.includes("id: 1:2"));
      expect(delivered).toContain("id: 1:1\nevent: turn.start");
      expect(delivered).toContain("id: 1:2\nevent: text.delta");
      stream.abort();
      await waitFor(
        () => (fixture.supervisor.sessionStreamSubscriberCount(session) === 0 ? true : undefined),
        "drained gap subscriber cleared",
      );
    } finally {
      await closeFixture(fixture);
    }
  });

  it("ends a false replay.gap connection when live arrives before drain", {
    timeout: 15_000,
  }, async () => {
    const opened = await openGapBackpressuredStream();
    const { runtime, fixture, cookie, session, stream, writes } = opened;
    try {
      await startHeldTurn({ runtime, fixture, cookie, session });
      expect(writes).toEqual([GAP_FRAME]);
      await waitFor(
        () => (fixture.supervisor.sessionStreamSubscriberCount(session) === 0 ? true : undefined),
        "gap-paused subscriber cleared by live event",
      );
      stream.abort();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("fans identical live frames to two clients and drops the disconnected one", {
    timeout: 15_000,
  }, async () => {
    const opened = await openStartHeldSession();
    const { fixture, cookie, session } = opened;
    try {
      const first = await openEventStream(fixture, session, cookie);
      const second = await openEventStream(fixture, session, cookie);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(2);

      await startHeldTurn(opened);
      const firstText = await readUntil(first, (text) => text.includes("id: 1:2"));
      const secondText = await readUntil(second, (text) => text.includes("id: 1:2"));
      expect(firstText).toContain("id: 1:1\nevent: turn.start");
      expect(secondText).toContain("id: 1:1\nevent: turn.start");
      expect(firstText).toContain("id: 1:2\nevent: text.delta");
      expect(secondText).toContain("id: 1:2\nevent: text.delta");

      second.abort();
      await waitFor(
        () => (fixture.supervisor.sessionStreamSubscriberCount(session) === 1 ? true : undefined),
        "one subscriber remains",
      );
      first.abort();
      await waitFor(
        () => (fixture.supervisor.sessionStreamSubscriberCount(session) === 0 ? true : undefined),
        "disconnect clears subscribers",
      );
    } finally {
      await closeFixture(fixture);
    }
  });

  it("pauses a near-1000 replay on write false and resumes the suffix on drain", {
    timeout: 15_000,
  }, async () => {
    const { fixture, cookie, session } = await openBulkDeltaSession(900, LARGE_DELTA);
    try {
      expect(fixture.supervisor.streamCursor(session).seq).toBe(901);
      const stream = await openEventStream(fixture, session, cookie, "1:0");
      expect(stream.bufferedBytes()).toBeGreaterThan(0);
      expect(stream.bufferedBytes()).toBeLessThan(900 * LARGE_DELTA.length);
      expect(collected(stream)).not.toContain(": keepalive");
      const drained = await readUntil(stream, (text) => eventCount(text) === 901);
      expect(drained).toContain("id: 1:1\nevent: turn.start");
      expect(drained).toContain("id: 1:901\nevent: text.delta");
      expect(eventCount(drained)).toBe(901);
      stream.abort();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("ends a paused replay when live arrives and reconnects the retained suffix", {
    timeout: 15_000,
  }, async () => {
    const { runtime, fixture, cookie, session } = await openBulkDeltaSession(900, LARGE_DELTA);
    try {
      const child = await waitFor(() => runtime.children[0], "controlled child");
      const stream = await openEventStream(fixture, session, cookie, "1:0");
      expect(stream.bufferedBytes()).toBeGreaterThan(0);
      expect(stream.bufferedBytes()).toBeLessThan(900 * LARGE_DELTA.length);
      const lastId = lastDataId(stream.preview());
      expect(lastId).toMatch(/^1:\d+$/u);
      emitAssistantDelta(child, "!");
      await waitForContent(fixture, session, `${LARGE_DELTA.repeat(900)}!`);
      await waitFor(
        () => (fixture.supervisor.sessionStreamSubscriberCount(session) === 0 ? true : undefined),
        "paused client unsubscribed",
      );
      stream.abort();
      const reconnect = await openEventStream(fixture, session, cookie, lastId);
      const suffix = await readUntil(reconnect, (text) => text.includes("id: 1:902"));
      expect(suffix).toContain("id: 1:902\nevent: text.delta");
      reconnect.abort();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("contains a throwing live writer without stopping a healthy client or the runtime", {
    timeout: 15_000,
  }, async () => {
    const opened = await openStartHeldSession();
    const { fixture, cookie, session } = opened;
    try {
      const healthy = await openEventStream(fixture, session, cookie);
      fixture.supervisor.subscribe(session, null, () => {
        throw new Error("broken subscriber");
      });
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(2);

      await startHeldTurn(opened);
      const delivered = await readUntil(healthy, (text) => text.includes("id: 1:2"));
      expect(delivered).toContain("id: 1:1\nevent: turn.start");
      expect(fixture.store.getMessages(session, "u1")?.session.status).toBe("running");
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(1);
      healthy.abort();
    } finally {
      await closeFixture(fixture);
    }
  });

  it("ends an ordinary live write-false client without queueing later events", {
    timeout: 15_000,
  }, async () => {
    const { fixture, session, child, stream, observed } = await openLiveWriteFalseDelta(false);
    try {
      await waitForContent(fixture, session, "Hello!");
      await waitFor(
        () => (observed.ended || observed.destroyed ? true : undefined),
        "live write-false ends",
      );
      stream.resume();
      const body = await waitFor(
        () => (collected(stream).includes("id: 1:3") ? collected(stream) : undefined),
        "accepted live frame",
      );
      expect(body).toContain("id: 1:3");
      expect(body).not.toContain("id: 1:4");
      emitAssistantDelta(child, "later");
      await waitForContent(fixture, session, "Hello!later");
      expect(collected(stream)).not.toContain("id: 1:4");
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("destroys a response that emits a transport error", {
    timeout: 15_000,
  }, async () => {
    const { fixture, cookie, session } = await openHeldPromptSession();
    try {
      const stream = await openEventStream(fixture, session, cookie);
      const observed = observeRaw(stream.raw, {});
      queueMicrotask(() => {
        stream.raw.emit("error", new Error("controlled transport error"));
      });
      await waitFor(() => (observed.destroyed ? true : undefined), "errored response is destroyed");
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("keeps a held-end live-false response owned until actual close", {
    timeout: 15_000,
  }, async () => {
    const { fixture, session, observed } = await openLiveWriteFalseDelta(true);
    try {
      await waitFor(() => (observed.endedCalls > 0 ? true : undefined), "write-false requests end");
      expect(observed.destroyed).toBe(false);
      await fixture.app.close();
      expect(observed.destroyed).toBe(true);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
    } finally {
      fixture.db.close();
    }
  });

  it("rejects a request released after preClose instead of accepting a late SSE", {
    timeout: 15_000,
  }, async () => {
    const runtime = createRealFakeRuntime();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let closing!: () => void;
    const closingGate = new Promise<void>((resolve) => {
      closing = resolve;
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
    app.addHook("preHandler", async (request) => {
      if (request.url.endsWith("/events")) {
        entered();
        await held;
      }
    });
    app.addHook("preClose", (done) => {
      closing();
      done();
    });
    const cookie = await cookieFor(app, "zhangsan");
    const session = await createSession(app, cookie);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    let req: ClientRequest | undefined;
    let res: IncomingMessage | undefined;
    try {
      const response = new Promise<IncomingMessage>((resolve, reject) => {
        req = httpRequest(
          `${origin}/api/sessions/${session}/events`,
          { headers: { cookie } },
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
      await enteredGate;
      const closed = app.close();
      await closingGate;
      release();
      const closeDeadline = AbortSignal.timeout(2_000);
      await new Promise<void>((resolve, reject) => {
        const fail = (): void => {
          reject(
            new Error(
              "app.close must reject/close a stream attaching after preClose, not strand it",
            ),
          );
        };
        closeDeadline.addEventListener("abort", fail, { once: true });
        void closed.then(
          () => {
            closeDeadline.removeEventListener("abort", fail);
            resolve();
          },
          (error: unknown) => {
            closeDeadline.removeEventListener("abort", fail);
            reject(error);
          },
        );
      });
      const lateReply = await response;
      expect(lateReply.statusCode).toBe(502);
      expect(lateReply.headers.connection).toBe("close");
      expect(app.sessions.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
    } finally {
      release();
      res?.destroy();
      req?.destroy();
      try {
        await app.close();
      } catch {
        /* already closed */
      }
      db.close();
    }
  });

  it("closes paused and end-pending streams during app.close", {
    timeout: 15_000,
  }, async () => {
    const { fixture, cookie, session } = await openBulkDeltaSession(900, LARGE_DELTA);
    try {
      const paused = await openEventStream(fixture, session, cookie, "1:0");
      expect(paused.bufferedBytes()).toBeGreaterThan(0);
      await fixture.app.close();
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
    } finally {
      fixture.db.close();
    }
  });
});

interface OpenStream {
  abort(): void;
  resume(): void;
  bufferedBytes(): number;
  preview(): string;
  raw: ServerResponse;
}

interface GapBackpressuredStream {
  runtime: ControlledRuntime;
  fixture: SupervisorApp;
  cookie: string;
  session: string;
  stream: OpenStream;
  writes: string[];
}

const streamBytes = new WeakMap<OpenStream, string>();

async function openEventStream(
  fixture: SupervisorApp,
  session: string,
  cookie: string,
  lastEventId?: string,
) {
  const controller = new AbortController();
  const response = await fixture.app.inject({
    method: "GET",
    url: `/api/sessions/${session}/events`,
    headers: {
      cookie,
      ...(lastEventId === undefined ? {} : { "Last-Event-ID": lastEventId }),
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

async function openGapBackpressuredStream(): Promise<GapBackpressuredStream> {
  const runtime = createStartHeldRuntime();
  const writes: string[] = [];
  const { fixture, cookie, session } = await openBareSession(runtime.runtime, {
    configureApp(app) {
      app.addHook("onRequest", (request, reply, done) => {
        if (!request.url.endsWith("/events")) {
          done();
          return;
        }
        const originalWrite = reply.raw.write.bind(reply.raw);
        reply.raw.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
          writes.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
          if (writes.length === 1) {
            return false;
          }
          return originalWrite(chunk as never, encoding as never, callback as never);
        }) as typeof reply.raw.write;
        done();
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

async function openLiveWriteFalseDelta(holdEnd: boolean) {
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

function observeRaw(raw: ServerResponse, options: { writeFalse?: boolean; holdEnd?: boolean }) {
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

function collected(stream: OpenStream): string {
  return streamBytes.get(stream) ?? "";
}

async function readUntil(stream: OpenStream, match: (text: string) => boolean): Promise<string> {
  return waitFor(() => {
    stream.resume();
    const text = collected(stream);
    return match(text) ? text : undefined;
  }, "SSE bytes");
}

function eventCount(text: string): number {
  return [...text.matchAll(/^id: .+$/gmu)].filter((match) => match[0] !== "id: ").length;
}

function lastDataId(text: string): string | undefined {
  const matches = [...text.matchAll(/^id: (.+)$/gmu)];
  const last = matches[matches.length - 1];
  const id = last?.[1];
  return id === undefined || id.length === 0 ? undefined : id;
}

async function readHttpHeaders(port: number, target: string, cookie: string): Promise<string> {
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
