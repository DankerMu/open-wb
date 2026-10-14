/**
 * Issue #909 groups 4 and 5 at the supervisor (production createApp → registerSessions over
 * scripted controlled children, real SQLite, injected clock): `turn.retry` is published and
 * replayable but never stored (upstream-failure「重试提示事件」), the thinking of a failed round
 * survives a successful retry (design D11, accepted residual), the published `error` stays the two
 * keys `{messageId, message}` with the sentence projection, and the sessions `log` port gets one
 * `upstream_failed` record per failed turn whose reason is not `agent_failed`
 * (upstream-failure「上游失败日志」). Expected payloads are spec literals.
 */
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { SpawnLog } from "../src/sessions/omp/spawn-gate.js";
import { ofType, sessionEvents, waitForEvent } from "./session-approval-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import { messageRow } from "./session-store-helpers.js";
import {
  assistantIdFor,
  closeOnEof,
  createControlledRuntime,
  createSession,
  OWNER_ID,
  openRecordingSession,
  type RecordingWorld,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";

const REAL = { timeout: 15_000 };
const BUSY =
  "502 模型服务返回 HTTP 503：busy\n模型服务返回 HTTP 503：busy (type=wb_upstream param=status.503)";
const KEY_401 =
  "401 Incorrect API key provided\nIncorrect API key provided (type=invalid_request_error)";
const AUTH_LINE = "鉴权失败：模型服务拒绝了配置的 API 密钥（HTTP 401）";

const START: OmpFrame = { type: "agent_start" };
const TERMINAL: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };
const RETRY_START: OmpFrame = {
  type: "auto_retry_start",
  attempt: 1,
  maxAttempts: 1,
  delayMs: 431,
  errorMessage: BUSY,
};

function failedEnd(errorStatus: number, errorMessage: string): OmpFrame {
  return {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorStatus, errorMessage },
  };
}

function update(type: "text_delta" | "thinking_delta", delta: string): OmpFrame {
  return {
    type: "message_update",
    assistantMessageEvent: { type, contentIndex: 0, delta },
    message: { role: "assistant", content: [] },
  };
}

const STOPPED_END: OmpFrame = {
  type: "message_end",
  message: { role: "assistant", stopReason: "stop" },
};

/** One scripted reply per prompt text; every child closes on stdin EOF. */
type Script = (child: FakeChild) => void;

const SCRIPTS: Record<string, Script> = {
  "fail 401": (child) => {
    for (const frame of [START, failedEnd(401, KEY_401), TERMINAL]) child.emitLine(frame);
  },
  "fail 503 after one retry": (child) => {
    for (const frame of [
      START,
      failedEnd(502, BUSY),
      RETRY_START,
      START,
      failedEnd(502, BUSY),
      { type: "auto_retry_end", success: false, attempt: 1, finalError: BUSY },
      TERMINAL,
    ]) {
      child.emitLine(frame);
    }
  },
  // Exits after the prompt write settled (an exit inside it would fail the dispatch: a 502).
  "process exits": (child) => {
    child.emitLine(START);
    setTimeout(() => {
      child.endStdout();
      child.exit(1);
    }, 10);
  },
  "recover after one retry": (child) => {
    for (const frame of [
      START,
      update("thinking_delta", "第一轮"),
      failedEnd(502, BUSY),
      RETRY_START,
      START,
      update("thinking_delta", "第二轮"),
      update("text_delta", "答"),
      STOPPED_END,
      { type: "auto_retry_end", success: true, attempt: 1 },
      TERMINAL,
    ]) {
      child.emitLine(frame);
    }
  },
  "hold after retry": (child) => {
    for (const frame of [START, failedEnd(502, BUSY)]) child.emitLine(frame);
  },
};

function scriptedRuntime() {
  return createControlledRuntime((child) => {
    closeOnEof(child);
    child.onCommand("prompt", (frame) => {
      SCRIPTS[String(frame.message)]?.(child);
    });
  });
}

async function openWorld(log?: SpawnLog) {
  const runtime = scriptedRuntime();
  const world = await openRecordingSession(runtime.runtime, {
    ...(log === undefined ? {} : { assembly: { log } }),
  });
  return { runtime, world };
}

async function prompt(world: RecordingWorld, session: string, text: string): Promise<void> {
  const response = await postPrompt(
    world.fixture.app,
    session,
    world.cookie,
    JSON.stringify({ message: text }),
  );
  expect(response.statusCode).toBe(202);
}

async function messagesOf(world: RecordingWorld): Promise<unknown> {
  const response = await world.fixture.app.inject({
    method: "GET",
    url: `/api/sessions/${world.session}/messages`,
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { messages: unknown }).messages;
}

describe("upstream-failure「重试提示可回放不可快照」", () => {
  it(
    "turn.retry takes a ring sequence, replays after an earlier cursor and changes no stored field",
    REAL,
    async () => {
      const { runtime, world } = await openWorld();
      try {
        await prompt(world, world.session, "hold after retry");
        await waitForEvent(world, "turn.start");
        const child = await waitFor(() => runtime.children[0], "controlled child");
        // The failed round's message_end publishes nothing: the stored rows are settled here.
        const before = await messagesOf(world);
        child.emitLine(RETRY_START);
        const [published] = await waitForEvent(world, "turn.retry");
        const assistant = assistantIdFor(world.fixture, world.session);
        expect(published).toEqual({ type: "turn.retry", data: { messageId: assistant } });

        const replayed = world.fixture.supervisor.subscribe(world.session, "1:1", () => {});
        expect(replayed.mode).toBe("replay");
        expect(replayed.replay).toEqual([
          { id: "1:2", type: "turn.retry", data: { messageId: assistant } },
        ]);
        replayed.unsubscribe();

        const after = await messagesOf(world);
        expect(after).toEqual(before);
        expect(messageRow(world.fixture.db, assistant).status).toBe("running");
        child.emitLine(TERMINAL);
        await waitForTurn(world.fixture, world.session, "failed");
      } finally {
        await world.fixture.close();
      }
    },
  );
});

describe("chat-stream retry at the supervisor (design D11)", () => {
  it(
    "a recovered turn ends done with one turn.start and keeps the failed round's thinking",
    REAL,
    async () => {
      const { world } = await openWorld();
      try {
        await prompt(world, world.session, "recover after one retry");
        await waitForTurn(world.fixture, world.session, "done");
        const types = sessionEvents(world).map((entry) => entry.event.type);
        expect(types.filter((type) => type === "turn.start")).toHaveLength(1);
        expect(types.filter((type) => type === "turn.retry")).toHaveLength(1);
        expect(types).not.toContain("error");
        expect(types.at(-1)).toBe("turn.end");
        const assistant = assistantIdFor(world.fixture, world.session);
        expect(messageRow(world.fixture.db, assistant)).toMatchObject({
          status: "done",
          content: "答",
        });
        const stored = world.fixture.db
          .prepare("SELECT thinking FROM chat_messages WHERE id = ?")
          .get(assistant) as { thinking: string };
        expect(stored.thinking).toBe("第一轮第二轮");
      } finally {
        await world.fixture.close();
      }
    },
  );
});

describe("the published error event of PR 3 (two keys, sentence projection)", () => {
  it(
    "a 401 turn publishes exactly {messageId, message} with 鉴权失败…（HTTP 401）",
    REAL,
    async () => {
      const { world } = await openWorld();
      try {
        await prompt(world, world.session, "fail 401");
        await waitForTurn(world.fixture, world.session, "failed");
        const [error] = ofType(sessionEvents(world), "error");
        const assistant = assistantIdFor(world.fixture, world.session);
        expect(error).toEqual({
          type: "error",
          data: { messageId: assistant, message: AUTH_LINE },
        });
        expect(Object.keys(error?.data ?? {}).sort()).toEqual(["message", "messageId"]);
      } finally {
        await world.fixture.close();
      }
    },
  );
});

describe("upstream-failure「每个失败回合一行」", () => {
  it(
    "401, 503 after one retry, a process exit and a recovered turn yield exactly two records",
    REAL,
    async () => {
      const records: unknown[] = [];
      const { world } = await openWorld((record) => {
        records.push(record);
      });
      try {
        const sessions = [world.session];
        for (let made = 1; made < 4; made += 1) {
          sessions.push(await createSession(world.fixture.app, world.cookie));
        }
        const texts = [
          "fail 401",
          "fail 503 after one retry",
          "process exits",
          "recover after one retry",
        ];
        const ends = ["failed", "failed", "failed", "done"] as const;
        for (const [index, session] of sessions.entries()) {
          await prompt(world, session, texts[index] ?? "");
          await waitForTurn(world.fixture, session, ends[index] ?? "done");
        }
        expect(records).toEqual([
          { event: "upstream_failed", sessionId: sessions[0], reason: "auth_failed", status: 401 },
          {
            event: "upstream_failed",
            sessionId: sessions[1],
            reason: "upstream_error",
            status: 503,
          },
        ]);
        // The process exit still published its agent_failed error, unlogged.
        expect(ofType(sessionEvents(world, sessions[2]), "error")).toEqual([
          {
            type: "error",
            data: {
              messageId: assistantIdFor(world.fixture, sessions[2] ?? ""),
              message: "Agent 运行失败",
            },
          },
        ]);
      } finally {
        await world.fixture.close();
      }
    },
  );

  it(
    "a throwing or thenable-returning log changes neither the turn nor onError",
    REAL,
    async () => {
      for (const log of [
        () => {
          throw new Error("log sink down");
        },
        () => Promise.reject(new Error("async log sink")) as unknown as undefined,
      ]) {
        const { world } = await openWorld(log as SpawnLog);
        try {
          await prompt(world, world.session, "fail 401");
          await waitForTurn(world.fixture, world.session, "failed");
          expect(ofType(sessionEvents(world), "turn.end")).toEqual([
            {
              type: "turn.end",
              data: { messageId: assistantIdFor(world.fixture, world.session), status: "failed" },
            },
          ]);
          expect(world.errors).toEqual([]);
          expect(world.fixture.store.runtimeState(world.session)?.ownerId).toBe(OWNER_ID);
        } finally {
          await world.fixture.close();
        }
      }
    },
  );
});
