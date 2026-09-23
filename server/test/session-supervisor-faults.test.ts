import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentUnavailableError } from "../src/sessions/omp/process.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { INTERNAL_ERROR_ENVELOPE } from "./session-db-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import { messageRow, messageRows, sessionRow } from "./session-store-helpers.js";
import {
  assertRetainedFaultOnShutdown,
  assistantIdFor,
  capturedFailure,
  closeAfterRetainedFault,
  closeOnEof,
  containsMessage,
  createControlledRuntime,
  createRealFakeRuntime,
  createSession,
  createStartEofRuntime,
  emitAssistantDelta,
  eventsFor,
  expectCompensatedIdleSession,
  type ObservedEvent,
  OWNER_ID,
  openBareSession,
  openRecordingSession,
  requiredCall,
  requiredToken,
  resumePath,
  type SupervisorApp,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionSupervisor adapter and pre-progress fault provenance", () => {
  it("preserves an epoch-write fault as generic instead of sanitized 502 and compensates the HTTP pair", async () => {
    const runtime = createRealFakeRuntime();
    const { fixture, cookie, session } = await openBareSession(runtime.runtime);
    const app = fixture;
    try {
      fixture.db.exec(`CREATE TEMP TRIGGER reject_epoch_write
        BEFORE UPDATE OF stream_epoch ON chat_sessions
        WHEN NEW.id = '${session}'
        BEGIN SELECT RAISE(ABORT, 'epoch write sentinel'); END`);

      const direct = fixture.store.acceptPrompt(session, OWNER_ID, "direct provenance");
      const directFailure = await capturedFailure(() =>
        app.supervisor.prompt(session, "direct provenance"),
      );
      expect(directFailure).not.toBeInstanceOf(AgentUnavailableError);
      expect(directFailure).toMatchObject({ code: "ERR_SQLITE_ERROR" });
      expect(fixture.store.rollbackPrompt(direct.assistantMessageId)).toBe(true);

      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "http provenance" }),
      );
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
      expect(response.payload).not.toContain("epoch write sentinel");
      expect(messageRows(fixture.db).filter((row) => row.session_id === session)).toEqual([]);
      expect(sessionRow(fixture.db, session)).toMatchObject({ status: "idle", stream_epoch: 0 });
      expect(runtime.calls).toEqual([]);
      fixture.db.exec("DROP TRIGGER reject_epoch_write");
    } finally {
      await fixture?.close();
    }
  });

  it("preserves the shared-registry issuance error while leaving the failed acquisition epoch independent", async () => {
    const runtime = createRealFakeRuntime();
    const tokens = new ThrowingTokenRegistry();
    const { fixture, cookie, session } = await openBareSession(runtime.runtime, { tokens });
    try {
      const direct = fixture.store.acceptPrompt(session, OWNER_ID, "registry provenance");
      await expect(fixture.supervisor.prompt(session, "registry provenance")).rejects.toBe(
        tokens.issueFailure,
      );
      expect(fixture.store.rollbackPrompt(direct.assistantMessageId)).toBe(true);

      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "registry compensation" }),
      );
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
      expect(response.payload).not.toContain(tokens.issueFailure.message);
      expect(messageRows(fixture.db).filter((row) => row.session_id === session)).toEqual([]);
      expect(sessionRow(fixture.db, session)).toMatchObject({ status: "idle", stream_epoch: 2 });
      expect(runtime.calls).toEqual([]);
    } finally {
      await fixture?.close();
    }
  });

  it("compensates a receipt-successful session-file persistence fault before exposing any business frame", {
    timeout: 15_000,
  }, async () => {
    const runtime = createRealFakeRuntime();
    const { fixture, events, cookie, session } = await openRecordingSession(runtime.runtime);
    try {
      fixture.db.exec(`CREATE TEMP TRIGGER reject_session_file
        BEFORE UPDATE OF omp_session_file ON chat_sessions
        WHEN NEW.id = '${session}'
        BEGIN SELECT RAISE(ABORT, 'session metadata sentinel'); END`);

      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "metadata persistence failure" }),
      );
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
      expect(eventsFor(events, session)).toEqual([]);
      expectCompensatedIdleSession(fixture, session);
      const token = requiredToken(requiredCall(runtime.calls, 0).token);
      await waitFor(
        () => (fixture?.tokens.lookup(token) === null ? true : undefined),
        "metadata-failed token revocation",
      );
      fixture.db.exec("DROP TRIGGER reject_session_file");
    } finally {
      await fixture?.close();
    }
  });
});

describe("SessionSupervisor SQLite fault containment", () => {
  it("owns a background flush failure once, publishes no terminal commit, and permits explicit recovery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runtime = createStartEofRuntime((child) => {
      emitAssistantDelta(child, "timer pending");
    });
    const { fixture, errors, events, cookie, session } = await openRecordingSession(
      runtime.runtime,
    );
    let shutdownReported = false;
    try {
      fixture.db.exec(`CREATE TEMP TRIGGER reject_timer_flush
        BEFORE UPDATE OF content ON chat_messages
        WHEN NEW.session_id = '${session}'
        BEGIN SELECT RAISE(ABORT, 'timer flush sentinel'); END`);

      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "background flush" }),
      );
      expect(response.statusCode).toBe(202);
      const assistantId = assistantIdFor(fixture, session);
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(
        () => (errors.length === 1 ? errors[0] : undefined),
        "background flush error sink",
      );
      expectUncommittedDelta(fixture, events, session, assistantId);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(errors).toHaveLength(1);
      expect(messageRow(fixture.db, assistantId).content).toBe("");

      fixture.db.exec("DROP TRIGGER reject_timer_flush");
      expect(fixture.store.finishTurn(assistantId, "failed")).toBe(true);
      expect(messageRow(fixture.db, assistantId)).toMatchObject({
        content: "timer pending",
        status: "failed",
      });
      vi.useRealTimers();
      await assertRetainedFaultOnShutdown(fixture, "timer flush sentinel");
      shutdownReported = true;
    } finally {
      vi.useRealTimers();
      await closeAfterRetainedFault(fixture, shutdownReported);
    }
  });

  it("contains an immediate threshold flush fault before text publication and leaves its bytes for explicit finish", async () => {
    const threshold = "x".repeat(2_048);
    const runtime = createStartEofRuntime((child) => {
      emitAssistantDelta(child, threshold);
    });
    const { fixture, errors, events, cookie, session } = await openRecordingSession(
      runtime.runtime,
    );
    let shutdownReported = false;
    try {
      fixture.db.exec(`CREATE TEMP TRIGGER reject_threshold_flush
        BEFORE UPDATE OF content ON chat_messages
        WHEN NEW.session_id = '${session}'
        BEGIN SELECT RAISE(ABORT, 'threshold flush sentinel'); END`);

      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "threshold flush" }),
      );
      expect(response.statusCode).toBe(202);
      const assistantId = assistantIdFor(fixture, session);
      await waitFor(() => (errors.length === 1 ? errors[0] : undefined), "threshold error sink");
      expect(eventsFor(events, session).map((entry) => entry.event.type)).toEqual(["turn.start"]);
      expect(messageRow(fixture.db, assistantId)).toMatchObject({ content: "", status: "running" });

      fixture.db.exec("DROP TRIGGER reject_threshold_flush");
      expect(fixture.store.finishTurn(assistantId, "failed")).toBe(true);
      expect(messageRow(fixture.db, assistantId)).toMatchObject({
        content: threshold,
        status: "failed",
      });
      await assertRetainedFaultOnShutdown(fixture, "threshold flush sentinel");
      shutdownReported = true;
    } finally {
      await closeAfterRetainedFault(fixture, shutdownReported);
    }
  });

  it("contains a step-start write fault before publishing a numeric step and permits a later explicit finish", async () => {
    const runtime = createStartEofRuntime((child) => {
      child.emitLine({
        type: "tool_execution_start",
        toolCallId: "unpersisted-step",
        toolName: "bash",
        args: { command: "echo broken" },
      });
    });
    const { fixture, errors, events, cookie, session } = await openRecordingSession(
      runtime.runtime,
    );
    let shutdownReported = false;
    try {
      fixture.db.exec(`CREATE TEMP TRIGGER reject_step_insert
        BEFORE INSERT ON chat_steps
        BEGIN SELECT RAISE(ABORT, 'step insert sentinel'); END`);

      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "step storage fault" }),
      );
      expect(response.statusCode).toBe(202);
      const assistantId = assistantIdFor(fixture, session);
      await waitFor(() => (errors.length === 1 ? errors[0] : undefined), "step error sink");
      expect(eventsFor(events, session).map((entry) => entry.event.type)).toEqual(["turn.start"]);
      expect(messageRows(fixture.db).find((row) => row.id === assistantId)).toMatchObject({
        status: "running",
      });

      fixture.db.exec("DROP TRIGGER reject_step_insert");
      expect(fixture.store.finishTurn(assistantId, "failed")).toBe(true);
      expect(messageRow(fixture.db, assistantId).status).toBe("failed");
      await assertRetainedFaultOnShutdown(fixture, "step insert sentinel");
      shutdownReported = true;
    } finally {
      await closeAfterRetainedFault(fixture, shutdownReported);
    }
  });

  it("contains a terminal transaction fault without publishing turn.end and retains residual text for explicit repair", async () => {
    const runtime = createStartEofRuntime((child) => {
      emitAssistantDelta(child, "terminal residual");
      child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
    });
    const { fixture, errors, events, cookie, session } = await openRecordingSession(
      runtime.runtime,
    );
    let shutdownReported = false;
    try {
      fixture.db.exec(`CREATE TEMP TRIGGER reject_terminal_session
        BEFORE UPDATE OF status ON chat_sessions
        WHEN NEW.id = '${session}' AND NEW.status = 'done'
        BEGIN SELECT RAISE(ABORT, 'terminal write sentinel'); END`);

      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "terminal storage fault" }),
      );
      expect(response.statusCode).toBe(202);
      const assistantId = assistantIdFor(fixture, session);
      await waitFor(() => (errors.length === 1 ? errors[0] : undefined), "terminal error sink");
      expectUncommittedDelta(fixture, events, session, assistantId);

      fixture.db.exec("DROP TRIGGER reject_terminal_session");
      expect(fixture.store.finishTurn(assistantId, "done")).toBe(true);
      expect(messageRow(fixture.db, assistantId)).toMatchObject({
        content: "terminal residual",
        status: "done",
      });
      await assertRetainedFaultOnShutdown(fixture, "terminal write sentinel");
      shutdownReported = true;
    } finally {
      await closeAfterRetainedFault(fixture, shutdownReported);
    }
  });
});

describe("SessionSupervisor retirement and observer containment", () => {
  it("serializes a replacement behind old native retirement while another session remains usable", async () => {
    let failFirstTransport: (() => void) | undefined;
    const runtime = createControlledRuntime((child, _call, ordinal) => {
      if (ordinal === 0) {
        child.onCommand("prompt", () => {
          child.emitLine({ type: "agent_start" });
          failFirstTransport = () => {
            child.stdout.emit("error", new Error("first transport fault"));
          };
        });
        return;
      }
      closeOnEof(child);
      child.onCommand("prompt", () => {
        child.emitLine({ type: "agent_start" });
        child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
      });
    });
    const { fixture, cookie, session: sessionA } = await openBareSession(runtime.runtime);
    try {
      const sessionB = await createSession(fixture.app, cookie);
      const first = await postPrompt(
        fixture.app,
        sessionA,
        cookie,
        JSON.stringify({ message: "first transport" }),
      );
      expect(first.statusCode).toBe(202);
      if (failFirstTransport === undefined) {
        throw new Error("first controlled prompt did not arm transport failure");
      }
      failFirstTransport();
      await waitForTurn(fixture, sessionA, "failed");
      const firstChild = runtime.children[0];
      if (firstChild === undefined) {
        throw new Error("missing retired controlled child");
      }
      const retiredToken = requiredToken(requiredCall(runtime.calls, 0).token);
      expect(fixture.tokens.lookup(retiredToken)).toBe(sessionA);

      const replacement = postPrompt(
        fixture.app,
        sessionA,
        cookie,
        JSON.stringify({ message: "replacement must wait" }),
      );
      const replacementObservation = observePromise(replacement);
      await Promise.resolve();
      expect(replacementObservation.outcome).toBe("pending");
      expect(runtime.calls).toHaveLength(1);

      const independent = await postPrompt(
        fixture.app,
        sessionB,
        cookie,
        JSON.stringify({ message: "other session remains available" }),
      );
      expect(independent.statusCode).toBe(202);
      await waitForTurn(fixture, sessionB, "done");
      expect(runtime.calls).toHaveLength(2);
      expect(replacementObservation.outcome).toBe("pending");

      firstChild.nativeExit(2);
      firstChild.endStdout();
      const replacementResponse = await replacement;
      expect(replacementResponse.statusCode).toBe(202);
      await waitForTurn(fixture, sessionA, "done");
      const replacementCall = requiredCall(runtime.calls, 2);
      const replacementToken = requiredToken(replacementCall.token);
      expect(replacementToken).not.toBe(retiredToken);
      expect(resumePath(replacementCall.args)).toBe("/tmp/open-wb-fake-session.jsonl");
      expect(fixture.tokens.lookup(retiredToken)).toBeNull();
      expect(fixture.tokens.lookup(replacementToken)).toBe(sessionA);

      firstChild.nativeExit(9);
      expect(fixture.tokens.lookup(replacementToken)).toBe(sessionA);
    } finally {
      await fixture?.close();
    }
  });

  it("retires a live child when the first published observer throws and does not wait for native exit", {
    timeout: 15_000,
  }, async () => {
    const observerFailure = new Error("observer start sentinel");
    const runtime = createStartEofRuntime();
    const { fixture, errors, events, cookie, session } = await openRecordingSession(
      runtime.runtime,
      {
        onEvent(_sessionId, _epoch, event) {
          if (event.type === "turn.start") {
            throw observerFailure;
          }
        },
      },
    );
    try {
      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "observer start fault" }),
      );
      expect(response.statusCode).toBe(202);
      await waitFor(() => (errors.length === 1 ? errors[0] : undefined), "observer error sink");
      expect(errors).toEqual([observerFailure]);
      expect(eventsFor(events, session).map((entry) => entry.event.type)).toEqual(["turn.start"]);
      const token = requiredToken(requiredCall(runtime.calls, 0).token);
      await waitFor(
        () => (fixture?.tokens.lookup(token) === null ? true : undefined),
        "observer-failed token revocation",
      );
      const child = runtime.children[0];
      expect(child !== undefined && (child.exitCode !== null || child.signalCode !== null)).toBe(
        true,
      );
      await assertRetainedFaultOnShutdown(fixture, observerFailure.message);
    } finally {
      await closeAfterRetainedFault(fixture, true);
    }
  });

  it("keeps a local-only terminal SQLite fault as infrastructure without publishing a modeled error", {
    timeout: 15_000,
  }, async () => {
    const runtime = createControlledRuntime((child) => {
      closeOnEof(child);
      child.onCommand("prompt", (frame) => {
        child.emitLine({
          id: frame.id,
          type: "response",
          command: "prompt",
          success: true,
          data: { agentInvoked: false },
        });
      });
    });
    const { fixture, errors, events, cookie, session } = await openRecordingSession(
      runtime.runtime,
    );
    let shutdownReported = false;
    try {
      fixture.db.exec(`CREATE TEMP TRIGGER reject_local_terminal
        BEFORE UPDATE OF status ON chat_sessions
        WHEN NEW.id = '${session}' AND NEW.status = 'done'
        BEGIN SELECT RAISE(ABORT, 'private local terminal sentinel'); END`);

      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "local-only terminal storage fault" }),
      );
      expect(response.statusCode).toBe(202);
      expect(eventsFor(events, session)).toEqual([]);
      await waitFor(
        () => (errors.length === 1 ? errors[0] : undefined),
        "local terminal error sink",
      );
      expect(String(errors[0])).toContain("private local terminal sentinel");
      const token = requiredToken(requiredCall(runtime.calls, 0).token);
      expect(fixture.tokens.lookup(token)).toBeNull();
      await assertRetainedFaultOnShutdown(fixture, "private local terminal sentinel");
      shutdownReported = true;
    } finally {
      await closeAfterRetainedFault(fixture, shutdownReported);
    }
  });

  it("contains an observer and error-sink throw until shutdown reports the retained cleanup failure", async () => {
    const observerFailure = new Error("observer failure sentinel");
    const sinkFailure = new Error("error sink failure sentinel");
    const receivedBySink: Error[] = [];
    const runtime = createStartEofRuntime();
    const { fixture, cookie, session } = await openBareSession(runtime.runtime, {
      onEvent() {
        throw observerFailure;
      },
      onError(error) {
        receivedBySink.push(error);
        throw sinkFailure;
      },
    });
    const app = fixture;
    try {
      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "observer containment" }),
      );
      expect(response.statusCode).toBe(202);
      await waitFor(
        () => (receivedBySink.length === 1 ? receivedBySink[0] : undefined),
        "observer failure to reach error sink",
      );
      expect(receivedBySink).toEqual([observerFailure]);
      const shutdownFailure = await capturedFailure(() => app.close());
      expect(containsMessage(shutdownFailure, sinkFailure.message)).toBe(true);
    } finally {
      await closeAfterRetainedFault(fixture, true);
    }
  });
});

class ThrowingTokenRegistry extends TokenRegistry {
  readonly issueFailure = new Error("registry issue sentinel");

  override issue(_sessionId: string): string {
    throw this.issueFailure;
  }
}

function expectUncommittedDelta(
  fixture: SupervisorApp,
  events: readonly ObservedEvent[],
  session: string,
  assistantId: number,
): void {
  expect(eventsFor(events, session).map((entry) => entry.event.type)).toEqual([
    "turn.start",
    "text.delta",
  ]);
  expect(messageRow(fixture.db, assistantId)).toMatchObject({ content: "", status: "running" });
}
