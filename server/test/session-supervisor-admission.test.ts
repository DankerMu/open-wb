import { describe, expect, it } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import { INTERNAL_ERROR_ENVELOPE } from "./session-db-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  closeFixture,
  closeOnEof,
  createControlledRuntime,
  createRealFakeRuntime,
  expectCompensatedIdleSession,
  expectHistory,
  expectRunningAdmission,
  expectSettled,
  openAdmittedSession,
  requiredToken,
  waitFor,
} from "./session-supervisor-helpers.js";
import { holdNextPromptWrite, observePromise } from "./support/omp-rpc.js";

describe("SessionSupervisor admission and pre-progress metadata faults", () => {
  it("rejects a pre-dispatch duplicate without retiring the original admission", {
    timeout: 15_000,
  }, async () => {
    let held: { entered: Promise<void>; release(): void } | undefined;
    const runtime = createControlledRuntime((child) => {
      held = holdNextPromptWrite(child);
      closeOnEof(child);
      child.onCommand("prompt", (frame) => {
        child.emitLine({
          id: frame.id,
          type: "response",
          command: "prompt",
          success: true,
          data: { agentInvoked: true },
        });
        child.emitLine({ type: "agent_start" });
      });
    });
    const world = await openAdmittedSession(runtime.runtime, "original");
    const { fixture, session, admitted } = world;
    try {
      const first = fixture.supervisor.prompt(session, "original");
      const firstObservation = observePromise(first);
      const armedHold = await waitFor(
        () => (held === undefined ? undefined : held),
        "prompt-write hold armed",
      );
      await armedHold.entered;
      expect(firstObservation.outcome).toBe("pending");
      await expectHistory(fixture, world.cookie, session, { epoch: 1, seq: 0 });

      const duplicate = fixture.supervisor.prompt(session, "duplicate");
      const duplicateObservation = observePromise(duplicate);
      const duplicateFailure = await expectSettled(duplicate, "pre-dispatch duplicate", "rejected");
      expect(duplicateFailure).toBeInstanceOf(HttpError);
      expect((duplicateFailure as HttpError).code).toBe("session_busy");
      expect(duplicateObservation.outcome).toBe("rejected");
      expect(firstObservation.outcome).toBe("pending");

      armedHold.release();
      await expectSettled(first, "original pre-dispatch acceptance", "resolved");
      expect(firstObservation.outcome).toBe("resolved");
      expect(runtime.calls).toHaveLength(1);
      expect(runtime.children).toHaveLength(1);
      expectRunningAdmission(fixture, session, requiredToken(runtime.calls[0]?.token), admitted);
      await waitFor(
        () => (fixture.supervisor.streamCursor(session).seq === 1 ? true : undefined),
        "turn.start recorded",
      );
      await expectHistory(fixture, world.cookie, session, { epoch: 1, seq: 1 });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rejects a post-dispatch duplicate as busy while the original hang-prompt child stays admitted", {
    timeout: 15_000,
  }, async () => {
    const runtime = createRealFakeRuntime("hang-prompt");
    const { fixture, session, admitted } = await openAdmittedSession(
      runtime.runtime,
      "original hang",
    );
    try {
      const first = fixture.supervisor.prompt(session, "original hang");
      const firstObservation = observePromise(first);
      await expectSettled(first, "original hang-prompt dispatch", "resolved");
      expect(firstObservation.outcome).toBe("resolved");
      expect(runtime.calls).toHaveLength(1);
      const token = requiredToken(runtime.calls[0]?.token);
      expectRunningAdmission(fixture, session, token, admitted);

      const duplicate = fixture.supervisor.prompt(session, "duplicate hang");
      const duplicateObservation = observePromise(duplicate);
      const duplicateFailure = await expectSettled(
        duplicate,
        "post-dispatch duplicate",
        "rejected",
      );
      expect(duplicateFailure).toBeInstanceOf(HttpError);
      expect((duplicateFailure as HttpError).code).toBe("session_busy");
      expect(duplicateObservation.outcome).toBe("rejected");
      expect(firstObservation.outcome).toBe("resolved");
      expect(runtime.calls).toHaveLength(1);
      expect(runtime.children).toHaveLength(1);
      expectRunningAdmission(fixture, session, token, admitted);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rejects a session-file persistence fault on a nonterminal child without waiting for turn completion", {
    timeout: 15_000,
  }, async () => {
    const runtime = createRealFakeRuntime("hang-prompt");
    const { fixture, cookie, session, admitted } = await openAdmittedSession(
      runtime.runtime,
      "metadata hang",
    );
    try {
      fixture.db.exec(`CREATE TEMP TRIGGER reject_session_file
        BEFORE UPDATE OF omp_session_file ON chat_sessions
        WHEN NEW.id = '${session}'
        BEGIN SELECT RAISE(ABORT, 'session metadata sentinel'); END`);

      const pending = fixture.supervisor.prompt(session, "metadata hang");
      const observation = observePromise(pending);
      const failure = await expectSettled(pending, "session-file persistence fault", "rejected");
      expect(observation.outcome).toBe("rejected");
      expect(failure).toMatchObject({ code: "ERR_SQLITE_ERROR" });
      expect(String(failure)).toContain("session metadata sentinel");
      expect(runtime.calls).toHaveLength(1);
      const token = requiredToken(runtime.calls[0]?.token);
      await waitFor(
        () => (fixture.tokens.lookup(token) === null ? true : undefined),
        "metadata-failed token revocation",
      );
      expect(fixture.store.rollbackPrompt(admitted.assistantMessageId)).toBe(true);
      expectCompensatedIdleSession(fixture, session);

      const http = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "http metadata hang" }),
      );
      expect(http.statusCode).toBe(500);
      expect(http.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
    } finally {
      await closeFixture(fixture);
    }
  });
});
