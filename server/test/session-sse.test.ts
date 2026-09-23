/**
 * Issue #103 authenticated session SSE at GET /api/sessions/:id/events.
 * Expected status, headers, frames, and envelopes are fixture literals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOT_FOUND_ENVELOPE, UNAUTHORIZED_ENVELOPE } from "./auth-lifecycle-helpers.js";
import { cookieFor, UNKNOWN_SESSION_ID } from "./session-rest-helpers.js";
import {
  collected,
  eventCount,
  GAP_FRAME,
  LARGE_DELTA,
  lastDataId,
  observeRaw,
  openEventStream,
  openGapBackpressuredStream,
  openHeartbeatPair,
  openLiveWriteFalseDelta,
  readHttpHeaders,
  readUntil,
} from "./session-sse-helpers.js";
import {
  closeFixture,
  createRealFakeRuntime,
  emitAssistantDelta,
  openBareSession,
  openBulkDeltaSession,
  openHeldPromptSession,
  openStartHeldSession,
  startHeldTurn,
  waitFor,
  waitForContent,
} from "./session-supervisor-helpers.js";

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

  it.each(["false", "throw"] as const)(
    "contains a heartbeat %s writer without stopping a healthy client",
    { timeout: 15_000 },
    async (mode) => {
      const opened = await openHeartbeatPair(mode);
      const { runtime, fixture, session, failing, healthy, writes } = opened;
      try {
        expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(2);
        expect(runtime.clock.pending()).toBe(2);

        runtime.clock.advance(14_999);
        expect(writes.get("failing")).toEqual([]);
        expect(writes.get("healthy")).toEqual([]);
        runtime.clock.advance(1);
        expect(writes.get("failing")).toEqual([": keepalive\n\n"]);
        expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(1);
        expect(runtime.clock.pending()).toBe(1);
        if (mode === "false") {
          expect(failing.raw.writableEnded).toBe(true);
        } else {
          expect(failing.raw.destroyed).toBe(true);
        }

        runtime.clock.advance(15_000);
        expect(writes.get("failing")).toEqual([": keepalive\n\n"]);
        expect(writes.get("healthy")).toEqual([": keepalive\n\n", ": keepalive\n\n"]);
        expect(healthy.raw.destroyed).toBe(false);
        expect(healthy.raw.writableEnded).toBe(false);

        await fixture.app.close();
        expect(runtime.clock.pending()).toBe(0);
        expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
      } finally {
        fixture.db.close();
      }
    },
  );

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
});
