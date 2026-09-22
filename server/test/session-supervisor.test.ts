import { describe, expect, it } from "vitest";
import { AGENT_UNAVAILABLE_ENVELOPE, postPrompt } from "./session-rest-helpers.js";
import {
  messageRow,
  messageRows,
  seedMessage,
  seedSession,
  seedStep,
  sessionId,
  sessionRow,
  stepRow,
  stepRows,
} from "./session-store-helpers.js";
import {
  closeOnEof,
  createControlledRuntime,
  createRealFakeRuntime,
  createStartEofRuntime,
  eventsFor,
  IDLE_MS,
  OWNER_ID,
  openBareSession,
  openRecordingSession,
  requiredCall,
  requiredToken,
  resumePath,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";

interface AssistantStep {
  id: number;
  ordinal: number;
  name: string;
  detail: string;
  status: string;
}

interface AssistantMessage {
  id: number;
  role: string;
  content: string;
  status: string;
  steps: readonly AssistantStep[];
}

describe("SessionSupervisor real child persistence and lifecycle", () => {
  it("persists a normal child turn, reuses its generation, and resumes only after idle retirement", {
    timeout: 15_000,
  }, async () => {
    const runtime = createRealFakeRuntime();
    const terminalStates: string[] = [];
    let capture:
      | {
          store: {
            getMessages(sessionId: string, ownerId: string): { session: { status: string } } | null;
          };
        }
      | undefined;
    const { fixture, errors, events, cookie, session } = await openRecordingSession(
      runtime.runtime,
      {
        onEvent(sessionId, _epoch, event) {
          if (event.type === "turn.end") {
            const status = capture?.store.getMessages(sessionId, OWNER_ID)?.session.status;
            terminalStates.push(status ?? "missing");
          }
        },
      },
    );
    capture = fixture;
    try {
      const firstResponse = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "first normal turn" }),
      );
      expect(firstResponse.statusCode).toBe(202);
      const firstTurn = await waitForTurn(fixture, session, "done");
      const firstAssistant = assistantFrom(firstTurn);
      expect(firstAssistant).toMatchObject({
        content: "Hello from fake-omp",
        status: "done",
        steps: [
          expect.objectContaining({
            ordinal: 0,
            name: "bash",
            detail: '{"output":"workbuddy-smoke"}',
            status: "done",
          }),
        ],
      });
      expect(firstAssistant.steps).toHaveLength(1);
      expect(typeof firstAssistant.steps[0]?.id).toBe("number");
      expect(sessionRow(fixture.db, session)).toMatchObject({
        status: "done",
        omp_session_file: "/tmp/open-wb-fake-session.jsonl",
        stream_epoch: 1,
      });
      expect(eventsFor(events, session).map((entry) => entry.event.type)).toEqual([
        "turn.start",
        "text.delta",
        "text.delta",
        "text.delta",
        "step.start",
        "step.end",
        "turn.end",
      ]);
      expect(terminalStates).toEqual(["done"]);

      const firstCall = requiredCall(runtime.calls, 0);
      const firstToken = requiredToken(firstCall.token);
      expect(fixture.tokens.lookup(firstToken)).toBe(session);
      expect(runtime.calls).toHaveLength(1);

      const secondResponse = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "reuse healthy child" }),
      );
      expect(secondResponse.statusCode).toBe(202);
      await waitForTurn(fixture, session, "done");
      expect(runtime.calls).toHaveLength(1);
      expect(sessionRow(fixture.db, session).stream_epoch).toBe(1);
      expect(fixture.tokens.lookup(firstToken)).toBe(session);

      const firstChild = runtime.children[0];
      if (firstChild === undefined) {
        throw new Error("missing first fake-omp child");
      }
      runtime.clock.advance(IDLE_MS);
      await waitFor(
        () => (firstChild.exitCode !== null || firstChild.signalCode !== null ? true : undefined),
        "idle child exit",
      );
      expect(fixture.tokens.lookup(firstToken)).toBeNull();

      const afterIdle = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "resume after idle" }),
      );
      expect(afterIdle.statusCode).toBe(202);
      await waitForTurn(fixture, session, "done");
      const resumedCall = requiredCall(runtime.calls, 1);
      const resumedToken = requiredToken(resumedCall.token);
      expect(resumePath(resumedCall.args)).toBe("/tmp/open-wb-fake-session.jsonl");
      expect(resumedToken).not.toBe(firstToken);
      expect(fixture.tokens.lookup(resumedToken)).toBe(session);
      expect(sessionRow(fixture.db, session).stream_epoch).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await fixture?.close();
    }
  });

  it("drains the two crash deltas, revokes the native token, and resumes at the next epoch", {
    timeout: 15_000,
  }, async () => {
    const runtime = createRealFakeRuntime("crash-after-deltas");
    const { fixture, errors, events, cookie, session } = await openRecordingSession(
      runtime.runtime,
    );
    try {
      const accepted = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "persist residual crash output" }),
      );
      expect(accepted.statusCode).toBe(202);
      const failed = await waitForTurn(fixture, session, "failed");
      expect(assistantFrom(failed)).toMatchObject({ content: "Hello from ", status: "failed" });
      expect(eventsFor(events, session).map((entry) => entry.event.type)).toEqual([
        "turn.start",
        "text.delta",
        "text.delta",
        "error",
        "turn.end",
      ]);
      expect(sessionRow(fixture.db, session)).toMatchObject({
        status: "failed",
        omp_session_file: "/tmp/open-wb-fake-session.jsonl",
        stream_epoch: 1,
      });
      const crashedToken = requiredToken(requiredCall(runtime.calls, 0).token);
      expect(fixture.tokens.lookup(crashedToken)).toBeNull();
      expect(errors).toEqual([]);

      runtime.setScenario(undefined);
      const recovered = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "resume persisted crash session" }),
      );
      expect(recovered.statusCode).toBe(202);
      await waitForTurn(fixture, session, "done");
      const replacement = requiredCall(runtime.calls, 1);
      const replacementToken = requiredToken(replacement.token);
      expect(resumePath(replacement.args)).toBe("/tmp/open-wb-fake-session.jsonl");
      expect(replacementToken).not.toBe(crashedToken);
      expect(fixture.tokens.lookup(crashedToken)).toBeNull();
      expect(fixture.tokens.lookup(replacementToken)).toBe(session);
      expect(sessionRow(fixture.db, session).stream_epoch).toBe(2);
      await expect(fixture.app.close()).resolves.toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      await fixture?.close();
    }
  });

  it("returns 502 and compensates an unprogressed admission when handshake state omits sessionFile", {
    timeout: 15_000,
  }, async () => {
    const runtime = createRealFakeRuntime("missing-session");
    const { fixture, cookie, session } = await openBareSession(runtime.runtime);
    try {
      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "missing session file" }),
      );
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
      expect(messageRows(fixture.db).filter((row) => row.session_id === session)).toEqual([]);
      expect(sessionRow(fixture.db, session)).toMatchObject({
        title: null,
        status: "idle",
        omp_session_file: null,
        stream_epoch: 1,
      });
      const failedToken = requiredToken(requiredCall(runtime.calls, 0).token);
      expect(fixture.tokens.lookup(failedToken)).toBeNull();
    } finally {
      await fixture?.close();
    }
  });

  it("publishes a scripted stopReason error before one failed turn.end without poisoning onError", {
    timeout: 15_000,
  }, async () => {
    const runtime = createRealFakeRuntime("error");
    const { fixture, errors, events, cookie, session } = await openRecordingSession(
      runtime.runtime,
    );
    try {
      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "scripted upstream error" }),
      );
      expect(response.statusCode).toBe(202);
      const failed = await waitForTurn(fixture, session, "failed");
      const assistant = assistantFrom(failed);
      expect(eventsFor(events, session).map((entry) => entry.event)).toEqual([
        {
          type: "error",
          data: { messageId: assistant.id, message: "fake omp scripted error" },
        },
        { type: "turn.end", data: { messageId: assistant.id, status: "failed" } },
      ]);
      expect(errors).toEqual([]);
      await expect(fixture.app.close()).resolves.toBeUndefined();
    } finally {
      await fixture?.close();
    }
  });

  it("waits for the exact local-only response id and settles one done turn without agent_end", async () => {
    let completeLocal: (() => void) | undefined;
    const runtime = createControlledRuntime((child) => {
      closeOnEof(child);
      child.onCommand("prompt", (frame) => {
        child.emitLine({ id: "unrelated-local-id", type: "prompt_result", agentInvoked: false });
        completeLocal = () => {
          child.emitLine({ id: frame.id, type: "prompt_result", agentInvoked: false });
        };
      });
    });
    const { fixture, events, cookie, session } = await openRecordingSession(runtime.runtime);
    try {
      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "local slash command" }),
      );
      expect(response.statusCode).toBe(202);
      expect(fixture.store.getMessages(session, OWNER_ID)?.session.status).toBe("running");
      if (completeLocal === undefined) {
        throw new Error("controlled prompt never received an outbound id");
      }
      completeLocal();
      const completed = await waitForTurn(fixture, session, "done");
      const assistant = assistantFrom(completed);
      expect(eventsFor(events, session).map((entry) => entry.event)).toEqual([
        { type: "turn.end", data: { messageId: assistant.id, status: "done" } },
      ]);
    } finally {
      await fixture?.close();
    }
  });

  it("assigns zero-based per-turn step ordinals and numeric public IDs, then resets ordinals on a reused generation", async () => {
    const reusedToolCallId = "shared-tool";
    let promptOrdinal = 0;
    const runtime = createStartEofRuntime((child) => {
      const turn = promptOrdinal;
      promptOrdinal += 1;
      child.emitLine({
        type: "tool_execution_start",
        toolCallId: reusedToolCallId,
        toolName: "bash",
        args: { command: turn === 0 ? "first-a" : "second" },
      });
      if (turn === 0) {
        child.emitLine({
          type: "tool_execution_start",
          toolCallId: "second-tool",
          toolName: "read",
          args: { path: "notes.md" },
        });
        child.emitLine({
          type: "tool_execution_end",
          toolCallId: reusedToolCallId,
          toolName: "bash",
          result: { output: "a" },
        });
        child.emitLine({
          type: "tool_execution_end",
          toolCallId: "second-tool",
          toolName: "read",
          result: { text: "ok" },
        });
      } else {
        child.emitLine({
          type: "tool_execution_end",
          toolCallId: reusedToolCallId,
          toolName: "bash",
          result: { output: "b" },
        });
      }
      child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
    });
    const { fixture, events, cookie, session } = await openRecordingSession(runtime.runtime);
    try {
      const firstResponse = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "first multi-step turn" }),
      );
      expect(firstResponse.statusCode).toBe(202);
      const firstTurn = await waitForTurn(fixture, session, "done");
      const firstAssistant = assistantFrom(firstTurn);
      const firstDbSteps = stepRows(fixture.db).filter(
        (row) => row.message_id === firstAssistant.id,
      );
      expect(firstDbSteps.map((row) => row.ordinal)).toEqual([0, 1]);
      expect(firstAssistant.steps.map((step) => step.ordinal)).toEqual([0, 1]);
      expect(firstAssistant.steps.map((step) => step.id)).toEqual(
        firstDbSteps.map((row) => row.id),
      );
      const firstPublic = eventsFor(events, session)
        .map((entry) => entry.event)
        .filter((event) => event.type === "step.start" || event.type === "step.end");
      expect(firstPublic).toEqual([
        {
          type: "step.start",
          data: {
            messageId: firstAssistant.id,
            stepId: firstDbSteps[0]?.id,
            name: "bash",
            detail: '{"command":"first-a"}',
          },
        },
        {
          type: "step.start",
          data: {
            messageId: firstAssistant.id,
            stepId: firstDbSteps[1]?.id,
            name: "read",
            detail: '{"path":"notes.md"}',
          },
        },
        {
          type: "step.end",
          data: {
            messageId: firstAssistant.id,
            stepId: firstDbSteps[0]?.id,
            status: "done",
            detail: '{"output":"a"}',
          },
        },
        {
          type: "step.end",
          data: {
            messageId: firstAssistant.id,
            stepId: firstDbSteps[1]?.id,
            status: "done",
            detail: '{"text":"ok"}',
          },
        },
      ]);

      const secondResponse = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "reuse generation with same toolCallId" }),
      );
      expect(secondResponse.statusCode).toBe(202);
      const secondTurn = await waitForTurn(fixture, session, "done");
      const secondAssistant = latestAssistantFrom(secondTurn);
      const secondDbSteps = stepRows(fixture.db).filter(
        (row) => row.message_id === secondAssistant.id,
      );
      expect(secondDbSteps.map((row) => row.ordinal)).toEqual([0]);
      expect(secondAssistant.steps.map((step) => step.ordinal)).toEqual([0]);
      expect(secondAssistant.steps.map((step) => step.id)).toEqual(
        secondDbSteps.map((row) => row.id),
      );
      expect(secondDbSteps[0]?.id).not.toBe(firstDbSteps[0]?.id);
      expect(secondDbSteps[0]?.id).not.toBe(firstDbSteps[1]?.id);
      const secondPublic = eventsFor(events, session)
        .map((entry) => entry.event)
        .filter(
          (event) =>
            (event.type === "step.start" || event.type === "step.end") &&
            event.data.messageId === secondAssistant.id,
        );
      expect(secondPublic).toEqual([
        {
          type: "step.start",
          data: {
            messageId: secondAssistant.id,
            stepId: secondDbSteps[0]?.id,
            name: "bash",
            detail: '{"command":"second"}',
          },
        },
        {
          type: "step.end",
          data: {
            messageId: secondAssistant.id,
            stepId: secondDbSteps[0]?.id,
            status: "done",
            detail: '{"output":"b"}',
          },
        },
      ]);
      expect(runtime.calls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("reconciles stale rows before prompt routes and waits for active cleanup without closing caller SQLite", {
    timeout: 15_000,
  }, async () => {
    const staleSession = sessionId("a");
    const terminalSession = sessionId("b");
    let staleMessageId = 0;
    let staleStepId = 0;
    let terminalMessageId = 0;
    const runtime = createRealFakeRuntime("hang-prompt");
    const { fixture, cookie, session } = await openBareSession(runtime.runtime, {
      prepare(db) {
        seedSession(db, {
          id: staleSession,
          ownerId: OWNER_ID,
          title: "stale running session",
          status: "running",
          ompSessionFile: "stale.jsonl",
          streamEpoch: 4,
          createdAt: 10,
          updatedAt: 11,
        });
        staleMessageId = seedMessage(db, {
          sessionId: staleSession,
          role: "assistant",
          content: "stale content",
          status: "running",
          createdAt: 12,
        });
        staleStepId = seedStep(db, {
          messageId: staleMessageId,
          ordinal: 0,
          name: "stale step",
          detail: "stale detail",
          status: "running",
          startedAt: 13,
          endedAt: null,
        });
        seedSession(db, {
          id: terminalSession,
          ownerId: OWNER_ID,
          title: "preserve terminal",
          status: "done",
          ompSessionFile: "terminal.jsonl",
          streamEpoch: 7,
          createdAt: 20,
          updatedAt: 21,
        });
        terminalMessageId = seedMessage(db, {
          sessionId: terminalSession,
          role: "assistant",
          content: "terminal content",
          status: "done",
          createdAt: 22,
        });
        seedStep(db, {
          messageId: terminalMessageId,
          ordinal: 0,
          name: "terminal step",
          detail: "terminal detail",
          status: "done",
          startedAt: 23,
          endedAt: 24,
        });
      },
    });
    try {
      expect(sessionRow(fixture.db, staleSession).status).toBe("failed");
      expect(messageRow(fixture.db, staleMessageId).status).toBe("failed");
      expect(stepRow(fixture.db, staleStepId).status).toBe("failed");
      expect(sessionRow(fixture.db, terminalSession)).toMatchObject({
        status: "done",
        omp_session_file: "terminal.jsonl",
        stream_epoch: 7,
      });
      expect(messageRow(fixture.db, terminalMessageId)).toMatchObject({
        content: "terminal content",
        status: "done",
      });
      const response = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "active during shutdown" }),
      );
      expect(response.statusCode).toBe(202);
      const activeToken = requiredToken(requiredCall(runtime.calls, 0).token);
      await expect(fixture.app.close()).resolves.toBeUndefined();
      expect(fixture.tokens.lookup(activeToken)).toBeNull();
      expect(
        messageRows(fixture.db).find(
          (row) => row.session_id === session && row.role === "assistant",
        ),
      ).toMatchObject({
        status: "failed",
      });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM chat_sessions").get()).toEqual({
        count: 3,
      });
      expect(() => fixture?.store.create(OWNER_ID)).toThrow();
    } finally {
      await fixture?.close();
    }
  });
});

function assistantFrom(tree: { messages: readonly AssistantMessage[] }) {
  const assistant = tree.messages.find((message) => message.role === "assistant");
  if (assistant === undefined) {
    throw new Error("completed turn has no assistant message");
  }
  return assistant;
}

function latestAssistantFrom(tree: { messages: readonly AssistantMessage[] }) {
  const assistants = tree.messages.filter((message) => message.role === "assistant");
  const assistant = assistants.at(-1);
  if (assistant === undefined) {
    throw new Error("completed turn has no assistant message");
  }
  return assistant;
}
