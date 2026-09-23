import { setImmediate as tick } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postPrompt } from "./session-rest-helpers.js";
import { messageRow } from "./session-store-helpers.js";
import {
  type ControlledRuntime,
  closeFixture,
  closeOnEof,
  createControlledRuntime,
  emitAssistantDelta,
  expectHistory,
  IDLE_MS,
  OWNER_ID,
  openBareSession,
  requiredCall,
  requiredToken,
  type SupervisorApp,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { holdNextPromptWrite } from "./support/omp-rpc.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionSupervisor generation streamCursor", () => {
  it("seals idle sessions and records without an observer across two healthy turns", {
    timeout: 15_000,
  }, async () => {
    const runtime = createStartHeldRuntime();
    const { fixture, cookie, session } = await openBareSession(runtime.runtime);
    try {
      await expectHistory(fixture, cookie, session, { epoch: 0, seq: null });

      const first = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "first turn" }),
      );
      expect(first.statusCode).toBe(202);
      const firstChild = await waitForChild(runtime);
      await waitFor(
        () =>
          fixture.store.getMessages(session, OWNER_ID)?.messages[1]?.content === "Hello"
            ? true
            : undefined,
        "first turn pending overlay",
      );
      await expectHistory(fixture, cookie, session, { epoch: 1, seq: 2 });
      completeHeldTurn(firstChild);
      await waitForTurn(fixture, session, "done");
      await expectHistory(fixture, cookie, session, { epoch: 1, seq: 3 });

      const second = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "second turn" }),
      );
      expect(second.statusCode).toBe(202);
      await waitForTurn(fixture, session, "done");
      await expectHistory(fixture, cookie, session, { epoch: 1, seq: 6 });
      expect(runtime.calls).toHaveLength(1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("keeps a numeric cursor through native exit residuals and seals only after publication drain", {
    timeout: 15_000,
  }, async () => {
    const recorded: string[] = [];
    const runtime = createStartHeldRuntime();
    const { fixture, cookie, session } = await openBareSession(runtime.runtime, {
      onEvent(_sessionId, _epoch, event) {
        recorded.push(event.type);
      },
    });
    try {
      const accepted = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "native residual" }),
      );
      expect(accepted.statusCode).toBe(202);
      const child = await waitForChild(runtime);
      await waitFor(
        () =>
          fixture.store.getMessages(session, OWNER_ID)?.messages[1]?.content === "Hello"
            ? true
            : undefined,
        "residual start overlay",
      );
      await expectHistory(fixture, cookie, session, { epoch: 1, seq: 2 });

      child.nativeExit(1);
      await waitFor(
        () =>
          fixture.tokens.lookup(requiredToken(runtime.calls[0]?.token)) === null ? true : undefined,
        "native token revocation",
      );
      await expectHistory(fixture, cookie, session, { epoch: 1, seq: 2 });
      expect(messageRow(fixture.db, assistantId(fixture, session)).content).toBe("");

      emitAssistantDelta(child, "!");
      await waitFor(
        () =>
          fixture.store.getMessages(session, OWNER_ID)?.messages[1]?.content === "Hello!"
            ? true
            : undefined,
        "residual delta overlay",
      );
      await expectHistory(fixture, cookie, session, { epoch: 1, seq: 3 });

      child.emitLine({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "child crashed" },
      });
      child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
      await waitForTurn(fixture, session, "failed");
      expect(recorded).toEqual(["turn.start", "text.delta", "text.delta", "error", "turn.end"]);
      expect(fixture.store.getMessages(session, OWNER_ID)?.messages[1]).toMatchObject({
        content: "Hello!",
        status: "failed",
      });
      child.endStdout();
      await waitFor(
        () => (fixture.supervisor.streamCursor(session).seq === null ? true : undefined),
        "publication drain seal",
      );
      await expectHistory(fixture, cookie, session, { epoch: 1, seq: null });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("seals an idle generation on idle death and starts the next epoch at sequence 1", {
    timeout: 15_000,
  }, async () => {
    const runtime = createStartHeldRuntime();
    const { fixture, cookie, session } = await openBareSession(runtime.runtime);
    try {
      const first = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "before idle" }),
      );
      expect(first.statusCode).toBe(202);
      const firstChild = await waitForChild(runtime);
      completeHeldTurn(firstChild);
      await waitForTurn(fixture, session, "done");
      await expectHistory(fixture, cookie, session, { epoch: 1, seq: 3 });
      const firstToken = requiredToken(requiredCall(runtime.calls, 0).token);
      expect(fixture.tokens.lookup(firstToken)).toBe(session);

      runtime.clock.advance(IDLE_MS);
      await waitFor(
        () => (fixture.tokens.lookup(firstToken) === null ? true : undefined),
        "idle token revocation",
      );
      await expectHistory(fixture, cookie, session, { epoch: 1, seq: null });

      const resumed = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "after idle" }),
      );
      expect(resumed.statusCode).toBe(202);
      await waitForTurn(fixture, session, "done");
      await expectHistory(fixture, cookie, session, { epoch: 2, seq: 3 });
      expect(runtime.calls).toHaveLength(2);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("does not let a completed pump release the next pending dispatch reservation", {
    timeout: 15_000,
  }, async () => {
    let turns = 0;
    const runtime = createControlledRuntime((child) => {
      child.onCommand("prompt", () => {
        child.emitLine({ type: "agent_start" });
        emitAssistantDelta(child, turns === 0 ? "A" : "B");
        turns += 1;
        child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
      });
    });
    let fixture: SupervisorApp | undefined;
    let held: { entered: Promise<void>; release(): void } | undefined;
    let next: Promise<void> | undefined;
    let nextError: unknown;
    let reentered = false;
    let released = false;
    const seen: Array<{ type: string; cursor: { epoch: number; seq: number | null } }> = [];
    const opened = await openBareSession(runtime.runtime, {
      onEvent(sessionId, _epoch, event) {
        const app = fixture;
        if (app === undefined) {
          throw new Error("missing supervisor fixture");
        }
        seen.push({ type: event.type, cursor: app.supervisor.streamCursor(sessionId) });
        if (event.type === "turn.end" && !reentered) {
          reentered = true;
          const child = runtime.children[0];
          if (child === undefined) {
            throw new Error("missing child");
          }
          held = holdNextPromptWrite(child);
          app.store.acceptPrompt(sessionId, OWNER_ID, "second held dispatch");
          next = app.supervisor.prompt(sessionId, "second held dispatch");
          void next.catch((error) => {
            nextError = error;
          });
        }
      },
    });
    fixture = opened.fixture;
    try {
      const response = await postPrompt(
        opened.fixture.app,
        opened.session,
        opened.cookie,
        JSON.stringify({ message: "first" }),
      );
      expect(response.statusCode).toBe(202);
      const armed = await waitFor(() => held, "reentrant dispatch hold");
      await armed.entered;
      await tick();
      expect(opened.fixture.supervisor.streamCursor(opened.session)).toEqual({
        epoch: 1,
        seq: 3,
      });
      const child = runtime.children[0];
      if (child === undefined) {
        throw new Error("missing child");
      }
      child.nativeExit(2);
      expect(opened.fixture.supervisor.streamCursor(opened.session)).toEqual({
        epoch: 1,
        seq: 3,
      });
      armed.release();
      released = true;
      await next;
      expect(nextError).toBeUndefined();
      await waitFor(() => (seen.length === 6 ? true : undefined), "second turn publications");
      expect(seen.map((item) => item.cursor)).toEqual(
        seen.map((_item, index) => ({ epoch: 1, seq: index + 1 })),
      );
      child.endStdout();
    } finally {
      if (held !== undefined && !released) {
        held.release();
      }
      runtime.children[0]?.endStdout();
      await next?.catch(() => {});
      await opened.fixture.close();
    }
  });

  it("covers 1000 start-evicted deltas then a 1048-byte flush at cursor 1:1002", {
    timeout: 15_000,
  }, async () => {
    const runtime = createControlledRuntime((child) => {
      closeOnEof(child);
      child.onCommand("prompt", () => {
        child.emitLine({ type: "agent_start" });
        for (let n = 0; n < 1_000; n += 1) {
          emitAssistantDelta(child, "a");
        }
        emitAssistantDelta(child, "b".repeat(1_048));
      });
    });
    const { fixture, cookie, session } = await openBareSession(runtime.runtime);
    try {
      const accepted = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "overlap" }),
      );
      expect(accepted.statusCode).toBe(202);
      const expected = `${"a".repeat(1_000)}${"b".repeat(1_048)}`;
      await waitFor(
        () =>
          fixture.store.getMessages(session, OWNER_ID)?.messages[1]?.content === expected
            ? true
            : undefined,
        "2048-character overlay",
      );
      const history = await fixture.app.inject({
        method: "GET",
        url: `/api/sessions/${session}/messages`,
        headers: { cookie },
      });
      expect(history.statusCode).toBe(200);
      const body = history.json() as {
        messages: Array<{ role: string; content: string }>;
        streamCursor: { epoch: number; seq: number | null };
      };
      const assistant = body.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toBe(expected);
      expect(body.streamCursor).toEqual({ epoch: 1, seq: 1_002 });
      expect(messageRow(fixture.db, assistantId(fixture, session)).content).toBe(expected);
    } finally {
      await closeFixture(fixture);
    }
  });
});

function createStartHeldRuntime() {
  let prompts = 0;
  return createControlledRuntime((child) => {
    closeOnEof(child);
    child.onCommand("prompt", () => {
      child.emitLine({ type: "agent_start" });
      emitAssistantDelta(child, "Hello");
      prompts += 1;
      if (prompts > 1) {
        child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
      }
    });
  });
}

function completeHeldTurn(child: { emitLine(frame: object): void }): void {
  child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
}

async function waitForChild(runtime: ControlledRuntime) {
  return waitFor(() => runtime.children[0], "controlled child");
}

function assistantId(fixture: SupervisorApp, session: string): number {
  const assistant = fixture.store
    .getMessages(session, OWNER_ID)
    ?.messages.find((message) => message.role === "assistant");
  if (assistant === undefined) {
    throw new Error("missing assistant message");
  }
  return assistant.id;
}
