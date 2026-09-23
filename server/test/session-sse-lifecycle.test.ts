/**
 * Issue #103 SSE lifecycle: late attach, abort-before-attach, consumed request, shutdown.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeHeldEventsConnection,
  connectHeldEventsTcp,
  LARGE_DELTA,
  openEventStream,
  openHeldEventsTcp,
} from "./session-sse-helpers.js";
import { openBulkDeltaSession } from "./session-supervisor-helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("authenticated session event stream lifecycle", () => {
  it("rejects a request released after preClose instead of accepting a late SSE", {
    timeout: 15_000,
  }, async () => {
    let closing!: () => void;
    const closingGate = new Promise<void>((resolve) => {
      closing = resolve;
    });
    const held = await openHeldEventsTcp(undefined, (app) => {
      app.addHook("preClose", (done) => {
        closing();
        done();
      });
    });
    const connection = await connectHeldEventsTcp(held);
    try {
      await held.entered;
      const closed = held.app.close();
      await closingGate;
      held.release();
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
      const lateReply = await connection.response;
      expect(lateReply.statusCode).toBe(502);
      expect(lateReply.headers.connection).toBe("close");
      expect(held.app.sessions.supervisor.sessionStreamSubscriberCount(held.session)).toBe(0);
    } finally {
      await closeHeldEventsConnection(connection);
    }
  });

  it("does not register a subscriber after the raw response already closed", {
    timeout: 15_000,
  }, async () => {
    let rawClosed!: () => void;
    const rawClosedGate = new Promise<void>((resolve) => {
      rawClosed = resolve;
    });
    const held = await openHeldEventsTcp((_request, reply) => {
      reply.raw.once("close", rawClosed);
    });
    const connection = await connectHeldEventsTcp(held);
    try {
      await held.entered;
      connection.req.destroy();
      await rawClosedGate;
      held.release();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(held.app.sessions.supervisor.sessionStreamSubscriberCount(held.session)).toBe(0);
      expect(held.runtime.clock.pending()).toBe(0);
    } finally {
      await closeHeldEventsConnection(connection);
    }
  });

  it("still returns 200 SSE after a middleware consumed the request body", {
    timeout: 15_000,
  }, async () => {
    const held = await openHeldEventsTcp(async (request) => {
      for await (const _chunk of request.raw) {
        /* drain GET body so IncomingMessage completes without aborting the response */
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    });
    const connection = await connectHeldEventsTcp(held);
    try {
      await held.entered;
      held.release();
      const deadline = AbortSignal.timeout(2_000);
      const lateReply = await Promise.race([
        connection.response,
        new Promise<never>((_resolve, reject) => {
          deadline.addEventListener(
            "abort",
            () => {
              reject(
                new Error(
                  "normally consumed request must still receive SSE200 on its live response",
                ),
              );
            },
            { once: true },
          );
        }),
      ]);
      expect(lateReply.statusCode).toBe(200);
      expect(held.app.sessions.supervisor.sessionStreamSubscriberCount(held.session)).toBe(1);
    } finally {
      await closeHeldEventsConnection(connection);
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
