/**
 * Issue #931 session list event connection at GET /api/sessions/events (S1f tasks 6.1 / 6.2; the
 * PATCH-triggered write failure case is #932's).
 * Real listener, native stream reading; expected headers, frames and envelopes are spec literals.
 */
import type { ServerResponse } from "node:http";
import { setImmediate as waitImmediate } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { UNAUTHORIZED_ENVELOPE } from "./auth-lifecycle-helpers.js";
import { patch, patched } from "./session-archive-helpers.js";
import {
  accountOf,
  bounded,
  CHANGED_FRAME,
  count,
  EVENTS_URL,
  HEARTBEAT_FRAME,
  HEARTBEAT_MS,
  type ListClient,
  openList,
  startRequest,
  textOf,
} from "./session-list-events-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE } from "./session-rest-helpers.js";
import { readHttpHeaders } from "./session-sse-helpers.js";
import {
  createRealFakeRuntime,
  createSession,
  openBareSession,
  type SupervisorApp,
  waitFor,
} from "./session-supervisor-helpers.js";
import type { TestClock } from "./support/omp-runtime.js";

const SESSION_A = "0123456789abcdef0123456789abcdef";
const SESSION_B = "fedcba9876543210fedcba9876543210";
const CLIENT_HEADER = "x-list-client";

function rewoundFrame(sessionId: string): string {
  return `event: session.rewound\ndata: {"sessionId":"${sessionId}"}\n\n`;
}

interface World {
  fixture: SupervisorApp;
  app: FastifyInstance;
  clock: TestClock;
  origin: string;
  port: number;
  zhangsan: { cookie: string; id: string };
  /** Server-side responses of connections opened with the `x-list-client` marker, by marker. */
  raws: Map<string, ServerResponse>;
  /** Releases requests opened with `x-list-client: held`; resolves `entered` when one is parked. */
  hold: { entered: Promise<void>; release: () => void };
  /**
   * Resolves inside a `preClose` hook registered after the module's own, with what that hook saw
   * synchronously: which marked server-side responses were already destroyed, and the timer count.
   */
  closing: Promise<{ destroyed: Map<string, boolean>; timers: number }>;
  /**
   * The `x-list-client: stalled` connection: its transport refuses every heartbeat (`write`
   * returns false, nothing is sent) and never finishes an `end()`, like a reader that stopped.
   */
  stalled: { writes: string[]; ends: number };
  clients: ListClient[];
  close(): Promise<void>;
}

let world: World | undefined;

afterEach(async () => {
  const current = world;
  world = undefined;
  if (current === undefined) {
    return;
  }
  current.hold.release();
  for (const client of current.clients) {
    client.req.destroy();
  }
  await current.close();
});

async function openWorld(): Promise<World> {
  const runtime = createRealFakeRuntime();
  const raws = new Map<string, ServerResponse>();
  const stalled: World["stalled"] = { writes: [], ends: 0 };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredGate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closing!: (seen: { destroyed: Map<string, boolean>; timers: number }) => void;
  const closingGate = new Promise<{ destroyed: Map<string, boolean>; timers: number }>(
    (resolve) => {
      closing = resolve;
    },
  );
  const { fixture } = await openBareSession(runtime.runtime, {
    configureApp(app) {
      app.addHook("preClose", (done) => {
        closing({
          destroyed: new Map([...raws].map(([marker, raw]) => [marker, raw.destroyed])),
          timers: runtime.clock.pending(),
        });
        done();
      });
      app.addHook("onRequest", (request, reply, done) => {
        const marker = request.headers[CLIENT_HEADER];
        if (typeof marker === "string") {
          raws.set(marker, reply.raw);
          if (marker === "throwing") {
            reply.raw.write = (() => {
              throw new Error("controlled list event writer failure");
            }) as typeof reply.raw.write;
          }
          if (marker === "stalled") {
            reply.raw.write = ((chunk: unknown) => {
              stalled.writes.push(String(chunk));
              return false;
            }) as typeof reply.raw.write;
            reply.raw.end = (() => {
              stalled.ends += 1;
              return reply.raw;
            }) as typeof reply.raw.end;
          }
        }
        done();
      });
      app.addHook("preHandler", async (request) => {
        if (request.headers[CLIENT_HEADER] === "held") {
          entered();
          await held;
        }
      });
    },
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await fixture.close();
  };
  try {
    const origin = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const opened: World = {
      fixture,
      app: fixture.app,
      clock: runtime.clock,
      origin,
      port: Number(new URL(origin).port),
      zhangsan: await accountOf(fixture.app, "zhangsan"),
      raws,
      hold: { entered: enteredGate, release },
      closing: closingGate,
      stalled,
      clients: [],
      close,
    };
    world = opened;
    return opened;
  } catch (error) {
    await close();
    throw error;
  }
}

describe("session list event endpoint", () => {
  it("建立连接与心跳: 200, the three SSE headers, no event, one comment line per 15000 ms", async () => {
    const opened = await openWorld();
    const head = await readHttpHeaders(opened.port, EVENTS_URL, opened.zhangsan.cookie);
    expect(head.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
    expect(head).toContain("\r\nContent-Type: text/event-stream; charset=utf-8\r\n");
    expect(head).toContain("\r\nCache-Control: no-store\r\n");
    expect(head).toContain("\r\nConnection: keep-alive\r\n");

    const client = await openList(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "beat" });
    expect(client.res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(client.res.headers["cache-control"]).toBe("no-store");
    expect(client.res.headers.connection).toBe("keep-alive");

    // Bytes the server handed to the socket, read synchronously: none at 14999 ms, some at 15000.
    const socket = opened.raws.get("beat")?.socket;
    const headBytes = socket?.bytesWritten;
    expect(headBytes).toBeGreaterThan(0);
    opened.clock.advance(HEARTBEAT_MS - 1);
    expect(socket?.bytesWritten).toBe(headBytes);
    expect(client.text()).toBe("");
    opened.clock.advance(1);
    expect(socket?.bytesWritten).toBeGreaterThan(headBytes ?? 0);
    // The heartbeat bounds the wait: nothing preceded it, and it is exactly one comment line.
    expect(await textOf(client, HEARTBEAT_FRAME)).toBe(HEARTBEAT_FRAME);
    expect(client.closed()).toBe(false);

    opened.clock.advance(HEARTBEAT_MS);
    expect(await textOf(client, HEARTBEAT_FRAME.repeat(2))).toBe(HEARTBEAT_FRAME.repeat(2));
    expect(client.closed()).toBe(false);
  });

  it("未认证与关停: anonymous is a JSON 401; shutdown destroys open connections and rejects late ones with 502", {
    timeout: 15_000,
  }, async () => {
    const opened = await openWorld();
    const anonymous = await opened.app.inject({ method: "GET", url: EVENTS_URL });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(anonymous.json()).toEqual(UNAUTHORIZED_ENVELOPE);
    const overHttp = await startRequest(opened, undefined).response;
    expect(overHttp.statusCode).toBe(401);
    expect(overHttp.headers["content-type"]).toBe("application/json; charset=utf-8");
    overHttp.resume();

    const timers = opened.clock.pending();
    const open = await openList(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "open" });
    expect(opened.clock.pending()).toBe(timers + 1);
    const late = startRequest(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "held" });
    late.req.on("error", () => {});
    await opened.hold.entered;

    const closed = opened.close();
    // Destroyed by the module's own preClose hook, not by whatever the listener does afterwards.
    const seen = await opened.closing;
    expect(seen.destroyed.get("open")).toBe(true);
    expect(seen.timers).toBe(timers);
    opened.hold.release();
    await bounded(closed, "app.close with an open list event connection");

    await waitFor(() => (open.closed() ? true : undefined), "open list connection destroyed");
    expect(open.text()).toBe("");
    const lateReply = await late.response;
    expect(lateReply.statusCode).toBe(502);
    expect(lateReply.headers.connection).toBe("close");
    expect(lateReply.headers["content-type"]).toBe("application/json; charset=utf-8");
    let body = "";
    lateReply.setEncoding("utf8");
    for await (const chunk of lateReply) {
      body += chunk as string;
    }
    expect(JSON.parse(body)).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
  });

  it("不回放: a reconnect with Last-Event-ID gets nothing replayed and no frame carries id", async () => {
    const opened = await openWorld();
    const notifier = opened.app.sessions.listEvents;
    const first = await openList(opened, opened.zhangsan.cookie);
    notifier.notify(opened.zhangsan.id);
    expect(await textOf(first, CHANGED_FRAME)).toBe(CHANGED_FRAME);
    await waitImmediate();
    notifier.notify(opened.zhangsan.id);
    expect(await textOf(first, CHANGED_FRAME.repeat(2))).toBe(CHANGED_FRAME.repeat(2));
    expect(first.text()).not.toMatch(/^id:/mu);
    const timers = opened.clock.pending();
    first.req.destroy();
    await waitFor(
      () => (opened.clock.pending() === timers - 1 ? true : undefined),
      "first connection released",
    );

    const second = await openList(opened, opened.zhangsan.cookie, { "Last-Event-ID": "1:5" });
    opened.clock.advance(HEARTBEAT_MS);
    // Heartbeat as the sentinel: it is the only thing the new connection ever received.
    expect(await textOf(second, HEARTBEAT_FRAME)).toBe(HEARTBEAT_FRAME);
    notifier.notify(opened.zhangsan.id);
    const live = HEARTBEAT_FRAME + CHANGED_FRAME;
    expect(await textOf(second, live)).toBe(live);
    expect(second.text()).not.toMatch(/^id:/mu);
  });

  it("isolates accounts: a notify reaches every connection of that owner and no other account", async () => {
    const opened = await openWorld();
    const notifier = opened.app.sessions.listEvents;
    const lisi = await accountOf(opened.app, "lisi");
    expect(lisi.id).not.toBe(opened.zhangsan.id);
    const mine = [
      await openList(opened, opened.zhangsan.cookie),
      await openList(opened, opened.zhangsan.cookie),
    ];
    const theirs = [await openList(opened, lisi.cookie), await openList(opened, lisi.cookie)];

    notifier.notify(opened.zhangsan.id);
    // Sentinel for the other account: a rewound frame written after the notify above.
    notifier.notifyRewound(lisi.id, SESSION_A);
    for (const client of theirs) {
      expect(await textOf(client, rewoundFrame(SESSION_A))).toBe(rewoundFrame(SESSION_A));
    }
    opened.clock.advance(HEARTBEAT_MS);
    for (const client of mine) {
      const expected = CHANGED_FRAME + HEARTBEAT_FRAME;
      expect(await textOf(client, expected)).toBe(expected);
    }
    for (const client of theirs) {
      const expected = rewoundFrame(SESSION_A) + HEARTBEAT_FRAME;
      expect(await textOf(client, expected)).toBe(expected);
    }
  });
});

describe("session list notifier backpressure and isolation", () => {
  it("coalesces: five notifies while the reader is paused arrive as fewer than five, then the latch resets", async () => {
    const opened = await openWorld();
    const notifier = opened.app.sessions.listEvents;
    const client = await openList(opened, opened.zhangsan.cookie);
    client.res.pause();
    // One synchronous section: no write callback can run between these five calls.
    for (let index = 0; index < 5; index += 1) {
      notifier.notify(opened.zhangsan.id);
    }
    await waitImmediate();
    await waitImmediate();
    // Sentinel written after every sessions.changed of the burst.
    notifier.notifyRewound(opened.zhangsan.id, SESSION_A);
    client.res.resume();
    const burst = await waitFor(
      () => (client.text().includes(rewoundFrame(SESSION_A)) ? client.text() : undefined),
      "burst sentinel",
    );
    const received = count(burst, CHANGED_FRAME);
    expect(received).toBeGreaterThanOrEqual(1);
    expect(received).toBeLessThan(5);
    expect(burst).toBe(CHANGED_FRAME.repeat(received) + rewoundFrame(SESSION_A));

    // Drained: a later notify is written again.
    notifier.notify(opened.zhangsan.id);
    expect(await textOf(client, burst + CHANGED_FRAME)).toBe(burst + CHANGED_FRAME);
  });

  it("一条连接写失败不影响请求: a throwing writer closes only its own connection", async () => {
    const opened = await openWorld();
    const notifier = opened.app.sessions.listEvents;
    const broken = await openList(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "throwing" });
    const healthy = await openList(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "healthy" });
    const timers = opened.clock.pending();

    expect(() => notifier.notify(opened.zhangsan.id)).not.toThrow();
    expect(opened.raws.get("throwing")?.destroyed).toBe(true);
    expect(opened.raws.get("healthy")?.destroyed).toBe(false);
    expect(opened.clock.pending()).toBe(timers - 1);
    expect(await textOf(healthy, CHANGED_FRAME)).toBe(CHANGED_FRAME);
    await waitFor(() => (broken.closed() ? true : undefined), "broken connection closed");
    expect(broken.text()).toBe("");

    await waitImmediate();
    expect(() => notifier.notifyRewound(opened.zhangsan.id, SESSION_A)).not.toThrow();
    expect(() => notifier.notify(opened.zhangsan.id)).not.toThrow();
    const expected = CHANGED_FRAME + rewoundFrame(SESSION_A) + CHANGED_FRAME;
    expect(await textOf(healthy, expected)).toBe(expected);
    expect(healthy.closed()).toBe(false);
  });

  it("一条连接写失败不影响请求: a socket reset by the peer is closed and the other connection still receives", async () => {
    const opened = await openWorld();
    const notifier = opened.app.sessions.listEvents;
    const reset = await openList(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "reset" });
    const healthy = await openList(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "healthy" });
    const timers = opened.clock.pending();

    // Same synchronous section: the server has not observed the reset when notify runs.
    reset.res.socket.resetAndDestroy();
    expect(opened.raws.get("reset")?.destroyed).toBe(false);
    expect(() => notifier.notify(opened.zhangsan.id)).not.toThrow();

    expect(await textOf(healthy, CHANGED_FRAME)).toBe(CHANGED_FRAME);
    await waitFor(
      () => (opened.raws.get("reset")?.destroyed === true ? true : undefined),
      "reset connection closed",
    );
    await waitFor(
      () => (opened.clock.pending() === timers - 1 ? true : undefined),
      "reset connection released",
    );
    expect(() => notifier.notify(opened.zhangsan.id)).not.toThrow();
    expect(await textOf(healthy, CHANGED_FRAME.repeat(2))).toBe(CHANGED_FRAME.repeat(2));
    expect(opened.raws.get("healthy")?.destroyed).toBe(false);
  });

  it("一条连接写失败不影响请求: PATCH {pinned:true} beside a connection the peer reset is 200, that connection is closed and the other receives", async () => {
    const opened = await openWorld();
    const target = { fixture: opened.fixture, cookie: opened.zhangsan.cookie, session: "" };
    target.session = await createSession(opened.app, target.cookie);
    const reset = await openList(opened, target.cookie, { [CLIENT_HEADER]: "reset" });
    const healthy = await openList(opened, target.cookie, { [CLIENT_HEADER]: "healthy" });
    const timers = opened.clock.pending();

    reset.res.socket.resetAndDestroy();
    const view = await patched(patch(target, { pinned: true }));
    expect(view.pinnedAt).toEqual(expect.any(Number));

    expect(await textOf(healthy, CHANGED_FRAME)).toBe(CHANGED_FRAME);
    await waitFor(
      () => (opened.raws.get("reset")?.destroyed === true ? true : undefined),
      "reset connection closed",
    );
    await waitFor(
      () => (opened.clock.pending() === timers - 1 ? true : undefined),
      "reset connection released",
    );
    expect(reset.text()).toBe("");
    expect(opened.raws.get("healthy")?.destroyed).toBe(false);
    expect(healthy.closed()).toBe(false);
  });

  it("a refused heartbeat stops delivery but keeps the connection for the module's preClose to destroy", {
    timeout: 15_000,
  }, async () => {
    const opened = await openWorld();
    const notifier = opened.app.sessions.listEvents;
    const baseline = opened.clock.pending();
    await openList(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "stalled" });
    const healthy = await openList(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "healthy" });
    expect(opened.clock.pending()).toBe(baseline + 2);

    opened.clock.advance(HEARTBEAT_MS);
    expect(await textOf(healthy, HEARTBEAT_FRAME)).toBe(HEARTBEAT_FRAME);
    expect(opened.stalled).toEqual({ writes: [HEARTBEAT_FRAME], ends: 1 });
    // Logically closed: its heartbeat is not re-armed, yet the transport is still there.
    expect(opened.clock.pending()).toBe(baseline + 1);
    expect(opened.raws.get("stalled")?.destroyed).toBe(false);

    expect(() => notifier.notify(opened.zhangsan.id)).not.toThrow();
    expect(() => notifier.notifyRewound(opened.zhangsan.id, SESSION_A)).not.toThrow();
    opened.clock.advance(HEARTBEAT_MS);
    const expected = HEARTBEAT_FRAME + CHANGED_FRAME + rewoundFrame(SESSION_A) + HEARTBEAT_FRAME;
    expect(await textOf(healthy, expected)).toBe(expected);
    // No sessions.changed, no rewound frame and no second heartbeat reached the refused transport.
    expect(opened.stalled).toEqual({ writes: [HEARTBEAT_FRAME], ends: 1 });
    expect(opened.raws.get("stalled")?.destroyed).toBe(false);

    const closed = opened.close();
    const seen = await opened.closing;
    expect(seen.destroyed.get("stalled")).toBe(true);
    expect(seen.destroyed.get("healthy")).toBe(true);
    expect(seen.timers).toBe(baseline);
    await bounded(closed, "app.close with a logically closed list event connection", 10_000);
  });

  it("notifyRewound carries the session id and is never coalesced", async () => {
    const opened = await openWorld();
    const notifier = opened.app.sessions.listEvents;
    const client = await openList(opened, opened.zhangsan.cookie);
    notifier.notifyRewound(opened.zhangsan.id, SESSION_A);
    notifier.notifyRewound(opened.zhangsan.id, SESSION_A);
    notifier.notifyRewound(opened.zhangsan.id, SESSION_B);
    const expected =
      `event: session.rewound\ndata: {"sessionId":"${SESSION_A}"}\n\n`.repeat(2) +
      `event: session.rewound\ndata: {"sessionId":"${SESSION_B}"}\n\n`;
    expect(await textOf(client, expected)).toBe(expected);
    opened.clock.advance(HEARTBEAT_MS);
    expect(await textOf(client, expected + HEARTBEAT_FRAME)).toBe(expected + HEARTBEAT_FRAME);
  });

  it("releases a connection the client closed: no heartbeat timer is left and notify is a no-op", async () => {
    const opened = await openWorld();
    const notifier = opened.app.sessions.listEvents;
    const baseline = opened.clock.pending();
    const gone = await openList(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "gone" });
    const stays = await openList(opened, opened.zhangsan.cookie, { [CLIENT_HEADER]: "stays" });
    expect(opened.clock.pending()).toBe(baseline + 2);

    gone.req.destroy();
    await waitFor(
      () => (opened.clock.pending() === baseline + 1 ? true : undefined),
      "heartbeat timer of the closed connection cleared",
    );
    const goneRaw = opened.raws.get("gone");
    if (goneRaw === undefined) {
      throw new Error("closed connection was never observed server-side");
    }
    let lateWrites = 0;
    goneRaw.write = (() => {
      lateWrites += 1;
      return false;
    }) as typeof goneRaw.write;

    expect(() => notifier.notify(opened.zhangsan.id)).not.toThrow();
    expect(() => notifier.notifyRewound(opened.zhangsan.id, SESSION_A)).not.toThrow();
    opened.clock.advance(HEARTBEAT_MS);
    const expected = CHANGED_FRAME + rewoundFrame(SESSION_A) + HEARTBEAT_FRAME;
    expect(await textOf(stays, expected)).toBe(expected);
    expect(lateWrites).toBe(0);
    expect(opened.clock.pending()).toBe(baseline + 1);

    stays.req.destroy();
    await waitFor(
      () => (opened.clock.pending() === baseline ? true : undefined),
      "last heartbeat timer cleared",
    );
  });
});
