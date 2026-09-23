import { afterEach, describe, expect, it, vi } from "vitest";
import { postPrompt } from "./session-rest-helpers.js";
import { messageRow } from "./session-store-helpers.js";
import {
  assertRetainedFaultOnShutdown,
  assistantIdFor,
  type ControlledRuntime,
  capturedFailure,
  closeAfterRetainedFault,
  containsMessage,
  createStartEofRuntime,
  emitAssistantDelta,
  openBareSession,
  requiredCall,
  requiredToken,
  type SupervisorApp,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";

const SINK_CONTRACT = "session observation sink must return synchronously";

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionSupervisor synchronous observation sinks", () => {
  it("retains a fulfilled event-sink Promise as one programming fault and retires its native runtime", {
    timeout: 15_000,
  }, async () => {
    const runtime = createStartEofRuntime((child) => {
      emitAssistantDelta(child, "after fulfilled return");
    });
    const received: string[] = [];
    const observed = await observeEventSinkFault(runtime, "fulfilled event sink", () => {
      received.push("turn.start");
      return Promise.resolve("fulfilled event sink");
    });
    expect(received).toEqual(["turn.start"]);
    expect(observed.faults).toHaveLength(1);
    expect(observed.faults[0]?.message).toContain("synchronous");
    const child = runtime.children[0];
    expect(child !== undefined && (child.exitCode !== null || child.signalCode !== null)).toBe(
      true,
    );
  });

  it("contains a rejected event-sink Promise without a second fault or a detached rejection", {
    timeout: 15_000,
  }, async () => {
    const runtime = createStartEofRuntime();
    const rejection = new Error("rejected event sink sentinel");
    const observed = await observeEventSinkFault(runtime, "rejected event sink", () =>
      Promise.reject(rejection),
    );
    expect(observed.faults.map((error) => error.message)).toEqual([SINK_CONTRACT]);
    expect(observed.faults[0]).not.toBe(rejection);
  });

  it("reports a pending event-sink return without waiting for that Promise to settle", {
    timeout: 15_000,
  }, async () => {
    const runtime = createStartEofRuntime();
    let settlePending: (() => void) | undefined;
    let settled = false;
    await observeEventSinkFault(runtime, "pending event sink", () => {
      return new Promise<void>((resolve) => {
        settlePending = () => {
          settled = true;
          resolve();
        };
      });
    });
    expect(settled).toBe(false);
    settlePending?.();
  });

  it("uses a callable thenable receiver so its rejection is contained and the child is retired", {
    timeout: 15_000,
  }, async () => {
    const runtime = createStartEofRuntime();
    const rejection = new Error("callable thenable rejection sentinel");
    const callable = Object.assign(() => undefined, {
      reason: undefined as Error | undefined,
    });
    // biome-ignore lint/suspicious/noThenProperty: intentional invalid sink return
    Object.defineProperty(callable, "then", {
      configurable: true,
      value(this: { reason?: Error }, _fulfilled?: unknown, rejected?: (reason: unknown) => void) {
        rejected?.(this.reason);
      },
    });
    const observed = await observeEventSinkFault(runtime, "callable thenable", () => {
      callable.reason = rejection;
      return callable;
    });
    expect(observed.faults.map((error) => error.message)).toEqual([SINK_CONTRACT]);
    expect(observed.faults.some((error) => error === rejection)).toBe(false);
  });

  it("retains the original error thrown by an event-sink then getter", {
    timeout: 15_000,
  }, async () => {
    const getterFailure = new Error("then getter sentinel");
    const runtime = createStartEofRuntime();
    const returned = {};
    // biome-ignore lint/suspicious/noThenProperty: intentional invalid sink return
    Object.defineProperty(returned, "then", {
      configurable: true,
      get(): () => void {
        throw getterFailure;
      },
    });
    const observed = await observeEventSinkFault(runtime, "throwing then getter", () => returned);
    expect(observed.faults).toEqual([getterFailure]);
  });

  it("ignores ordinary numeric event and error sink returns", {
    timeout: 15_000,
  }, async () => {
    const runtime = createStartEofRuntime((child) => {
      emitAssistantDelta(child, "ordinary return");
      child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
    });
    const published: string[] = [];
    const faults: Error[] = [];
    const { fixture, cookie, session } = await openBareSession(runtime.runtime, {
      onEvent(_sessionId, _epoch, event) {
        return published.push(event.type);
      },
      onError(error) {
        return faults.push(error);
      },
    });
    try {
      await acceptPrompt({ fixture, cookie, session }, "ordinary numeric returns");
      await waitForTurn(fixture, session, "done");
      expect(published).toEqual(["turn.start", "text.delta", "turn.end"]);
      expect(faults).toEqual([]);
      expect(messageRow(fixture.db, assistantIdFor(fixture, session))).toMatchObject({
        content: "ordinary return",
        status: "done",
      });
      await fixture.app.close();
      expect(fixture.db.prepare("SELECT 1 AS usable").get()).toEqual({ usable: 1 });
    } finally {
      await closeAfterRetainedFault(fixture, false);
    }
  });

  it("retains a source flush fault and one extra fault when the error sink returns a thenable", async () => {
    const source = new Error("error sink source sentinel");
    const observed = await observeErrorSinkFault(source, () => {
      const thenable = {};
      // biome-ignore lint/suspicious/noThenProperty: intentional invalid sink return
      Object.defineProperty(thenable, "then", {
        configurable: true,
        value(onFulfilled?: (value: unknown) => unknown) {
          onFulfilled?.("returned error thenable");
        },
      });
      return thenable;
    });
    expect(observed.received.map((error) => error.message)).toEqual([source.message]);
    expect(containsMessage(observed.shutdown, source.message)).toBe(true);
    expect(containsMessage(observed.shutdown, "synchronous")).toBe(true);
    expect(observed.calls).toBe(1);
  });

  it("retains one extra fault when a source failure's error sink returns a rejected Promise", async () => {
    const source = new Error("rejected error sink source sentinel");
    const rejection = new Error("rejected error sink sentinel");
    const observed = await observeErrorSinkFault(source, (error) => {
      if (error.message !== source.message) {
        return;
      }
      return Promise.reject(rejection);
    });
    expect(containsMessage(observed.shutdown, source.message)).toBe(true);
    expect(containsMessage(observed.shutdown, "synchronous")).toBe(true);
    expect(containsMessage(observed.shutdown, rejection.message)).toBe(false);
    expect(observed.calls).toBe(1);
  });
});

async function observeEventSinkFault(
  runtime: ControlledRuntime,
  message: string,
  onEvent: () => unknown,
) {
  const faults: Error[] = [];
  const opened = await openBareSession(runtime.runtime, {
    onEvent,
    onError(error) {
      faults.push(error);
    },
  });
  const fixture = opened.fixture;
  try {
    await acceptPrompt(opened, message);
    await waitFor(() => (faults.length === 1 ? faults[0] : undefined), `${message} fault`);
    const token = requiredToken(requiredCall(runtime.calls, 0).token);
    await waitFor(
      () => (fixture.tokens.lookup(token) === null ? true : undefined),
      `${message} token revocation`,
    );
    await assertRetainedFaultOnShutdown(fixture, faults[0]?.message ?? "missing sink fault");
    return { faults };
  } finally {
    await closeAfterRetainedFault(fixture, true);
  }
}

async function observeErrorSinkFault(source: Error, onError: (error: Error) => unknown) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const runtime = createStartEofRuntime((child) => {
    emitAssistantDelta(child, source.message);
  });
  let calls = 0;
  const received: Error[] = [];
  const opened = await openBareSession(runtime.runtime, {
    onError(error) {
      calls += 1;
      received.push(error);
      return onError(error);
    },
  });
  let shutdownReported = false;
  try {
    opened.fixture.db.exec(`CREATE TEMP TRIGGER reject_error_sink_flush
      BEFORE UPDATE OF content ON chat_messages
      WHEN NEW.session_id = '${opened.session}'
      BEGIN SELECT RAISE(ABORT, '${source.message}'); END`);
    await acceptPrompt(opened, source.message);
    await vi.advanceTimersByTimeAsync(2_000);
    await waitFor(() => (calls === 1 ? calls : undefined), `${source.message} error sink`);
    vi.useRealTimers();
    const shutdown = await capturedFailure(() => opened.fixture.app.close());
    expect(opened.fixture.db.prepare("SELECT 1 AS usable").get()).toEqual({ usable: 1 });
    shutdownReported = true;
    return { calls, received, shutdown };
  } finally {
    vi.useRealTimers();
    await closeAfterRetainedFault(opened.fixture, shutdownReported);
  }
}

function acceptPrompt(
  opened: { fixture: SupervisorApp; cookie: string; session: string },
  message: string,
) {
  return postPrompt(
    opened.fixture.app,
    opened.session,
    opened.cookie,
    JSON.stringify({ message }),
  ).then((response) => {
    expect(response.statusCode).toBe(202);
  });
}
