/**
 * Issue #909 groups 6 and 7 at the supervisor (production createApp → registerSessions over scripted
 * controlled children, real SQLite): the `error` detail is sanitised with createApp's secret list,
 * the three error columns are stored before the event is published, and the published event and the
 * snapshot carry the same failure (upstream-failure「失败的公开形状」「上游原文净化」). Expected
 * payloads are spec literals (the sentence table, the detail rules of「回合失败分类」and the
 * sanitiser's six steps), never computed by the code under test.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { ensureOmpStateLayout } from "../src/sessions/omp/state-layout.js";
import { ofType, sessionEvents, waitForEvent } from "./session-approval-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  assertRetainedFaultOnShutdown,
  assistantIdFor,
  closeAfterRetainedFault,
  closeOnEof,
  createControlledRuntime,
  createSession,
  openRecordingSession,
  type RecordingWorld,
  requiredCall,
  requiredToken,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";

const REAL = { timeout: 15_000 };
const START: OmpFrame = { type: "agent_start" };
const TERMINAL: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };
const KEY = "k-909-secret";
const BASE_URL = "http://u:p4ss-secret@127.0.0.1:9/tenant-0123456789/v1?key=q-secret-0123";
/** The configured base URL whole, then its password, long path segment and query string alone. */
const BASE_URL_LINE = `via ${BASE_URL}; p4ss-secret; tenant-0123456789; key=q-secret-0123`;
const KEY_401 =
  "401 Incorrect API key provided\nIncorrect API key provided (type=invalid_request_error)";
const STATUS_500 =
  "502 模型服务返回 HTTP 500：boom\n模型服务返回 HTTP 500：boom (type=wb_upstream param=status.500)";
/** The fake upstream's `secret` message (support/fake-upstream-failures.mjs), with this file's key. */
const SECRET_MESSAGE = `rejected key ${KEY}; Authorization: Bearer leak-token-0123456789; sk-leakleakleakleakleak\nraw-http-request=/tmp/leak.json`;
/** Its sanitised first line: the key, the bearer token and the `sk-` run removed (steps 3 and 4). */
const SECRET_LINE = "rejected key [已移除]; Authorization: Bearer [已移除] [已移除]";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function failedEnd(errorStatus: number, errorMessage: string): OmpFrame {
  return {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorStatus, errorMessage },
  };
}

const ABORTED_END: OmpFrame = {
  type: "message_end",
  message: { role: "assistant", stopReason: "aborted" },
};

/** One scripted reply per prompt text (the text is the key); every child closes on stdin EOF. */
function scriptedRuntime(scripts: Record<string, OmpFrame[]>) {
  return createControlledRuntime((child: FakeChild) => {
    closeOnEof(child);
    child.onCommand("prompt", (frame) => {
      for (const line of scripts[String(frame.message)] ?? []) child.emitLine(line);
    });
  });
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

type Snapshot = { messages: Array<{ role: string; status: string; error: unknown }> };

async function snapshotOf(world: RecordingWorld, session = world.session): Promise<Snapshot> {
  const response = await world.fixture.app.inject({
    method: "GET",
    url: `/api/sessions/${session}/messages`,
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Snapshot;
}

function errorColumns(db: DatabaseSync, id: number) {
  return db
    .prepare(
      "SELECT status, error_reason, error_status, error_detail FROM chat_messages WHERE id = ?",
    )
    .get(id);
}

describe("upstream-failure「落库先于发布」", () => {
  it(
    "the publication callback already reads the three columns while the row is still running",
    REAL,
    async () => {
      const runtime = scriptedRuntime({
        "fail 500": [START, failedEnd(502, STATUS_500), TERMINAL],
      });
      let db: DatabaseSync | undefined;
      const seen: unknown[] = [];
      const world = await openRecordingSession(runtime.runtime, {
        onEvent(_session, _epoch, event) {
          if (event.type === "error" && db !== undefined) {
            seen.push(errorColumns(db, event.data.messageId));
          }
        },
      });
      db = world.fixture.db;
      try {
        await prompt(world, world.session, "fail 500");
        await waitForTurn(world.fixture, world.session, "failed");
        const assistant = assistantIdFor(world.fixture, world.session);
        expect(seen).toEqual([
          {
            status: "running",
            error_reason: "upstream_error",
            error_status: 500,
            error_detail: "模型服务返回 HTTP 500：boom",
          },
        ]);
        expect(errorColumns(world.fixture.db, assistant)).toMatchObject({ status: "failed" });
        expect(ofType(sessionEvents(world), "error")).toEqual([
          {
            type: "error",
            data: {
              messageId: assistant,
              message: "上游出错：模型服务内部错误",
              reason: "upstream_error",
              status: 500,
              detail: "模型服务返回 HTTP 500：boom",
            },
          },
        ]);
      } finally {
        await world.fixture.close();
      }
    },
  );
});

describe("upstream-failure「刷新后看到同一条错误」", () => {
  it(
    "a 401 turn publishes the five keys, then turn.end failed; the snapshot carries the same four",
    REAL,
    async () => {
      const runtime = scriptedRuntime({ "fail 401": [START, failedEnd(401, KEY_401), TERMINAL] });
      const world = await openRecordingSession(runtime.runtime);
      try {
        await prompt(world, world.session, "fail 401");
        await waitForTurn(world.fixture, world.session, "failed");
        const assistant = assistantIdFor(world.fixture, world.session);
        const events = sessionEvents(world).map((entry) => entry.event);
        expect(events.slice(-2).map((event) => event.type)).toEqual(["error", "turn.end"]);
        expect(events.at(-1)).toEqual({
          type: "turn.end",
          data: { messageId: assistant, status: "failed" },
        });
        const [error] = ofType(sessionEvents(world), "error");
        expect(error?.data).toEqual({
          messageId: assistant,
          message: "鉴权失败：模型服务拒绝了配置的 API 密钥",
          reason: "auth_failed",
          status: 401,
          detail: KEY_401,
        });
        expect(Object.keys(error?.data ?? {})).toEqual([
          "messageId",
          "message",
          "reason",
          "status",
          "detail",
        ]);
        const { messageId: _id, ...withoutId } = error?.data ?? { messageId: 0 };
        const [user, reply] = (await snapshotOf(world)).messages;
        expect(user?.error).toBeNull();
        expect(reply?.status).toBe("failed");
        expect(reply?.error).toEqual(withoutId);
        expect(Object.keys(reply?.error ?? {})).toEqual(["reason", "message", "status", "detail"]);
      } finally {
        await world.fixture.close();
      }
    },
  );

  it(
    "an errorStatus of 600 (outside 100–599) is stored and published with status null",
    REAL,
    async () => {
      const runtime = scriptedRuntime({
        "fail 600": [START, failedEnd(600, "600 weird"), TERMINAL],
      });
      const world = await openRecordingSession(runtime.runtime);
      try {
        await prompt(world, world.session, "fail 600");
        await waitForTurn(world.fixture, world.session, "failed");
        const assistant = assistantIdFor(world.fixture, world.session);
        expect(errorColumns(world.fixture.db, assistant)).toEqual({
          status: "failed",
          error_reason: "model_call_failed",
          error_status: null,
          error_detail: "600 weird",
        });
        const failure = {
          reason: "model_call_failed",
          message: "模型调用失败",
          status: null,
          detail: "600 weird",
        };
        expect(ofType(sessionEvents(world), "error")[0]?.data).toEqual({
          messageId: assistant,
          ...failure,
        });
        // The web's「消息 error 键严格解析」accepts exactly this shape (status null).
        expect((await snapshotOf(world)).messages.map((message) => message.error)).toEqual([
          null,
          failure,
        ]);
      } finally {
        await world.fixture.close();
      }
    },
  );

  it("a stopped turn stores no error and its snapshot error reads null", REAL, async () => {
    const runtime = scriptedRuntime({ stop: [START, ABORTED_END, TERMINAL] });
    const world = await openRecordingSession(runtime.runtime);
    try {
      await prompt(world, world.session, "stop");
      await waitForEvent(world, "turn.end");
      const assistant = assistantIdFor(world.fixture, world.session);
      expect(errorColumns(world.fixture.db, assistant)).toEqual({
        status: "stopped",
        error_reason: null,
        error_status: null,
        error_detail: null,
      });
      expect((await snapshotOf(world)).messages.map((message) => message.error)).toEqual([
        null,
        null,
      ]);
    } finally {
      await world.fixture.close();
    }
  });
});

describe("upstream-failure「上游原文净化」through createApp's secret list (task 6.3)", () => {
  it(
    "a 400 echoing the configured key, a bearer, an sk- run and dump lines stores and publishes none of them",
    REAL,
    async () => {
      const scripts: Record<string, OmpFrame[]> = {};
      const scripted = scriptedRuntime(scripts);
      // omp's own dump line names a file under the state dir (design Context, case 1 / 12).
      const dump = `raw-http-request=${scripted.runtime.stateDir}/xdg/state/omp/logs/http-400-requests/1.json`;
      // The base URL parts sit on a line of their own: a dump line would be dropped whole.
      const text = `400 ${SECRET_MESSAGE}\n${SECRET_MESSAGE} (type=scripted_error)\n${BASE_URL_LINE}\n${dump}`;
      scripts["fail 400"] = [START, failedEnd(400, text), TERMINAL];
      const world = await openRecordingSession(scripted.runtime, {
        assembly: { upstream: { baseUrl: BASE_URL, apiKey: KEY } },
      });
      try {
        await prompt(world, world.session, "fail 400");
        await waitForTurn(world.fixture, world.session, "failed");
        const assistant = assistantIdFor(world.fixture, world.session);
        // Step 2 drops both dump lines, the second one taking the JSON message's tail with it;
        // step 3 replaces each listed base URL part.
        const expected = `400 ${SECRET_LINE}\n${SECRET_LINE}\nvia [已移除]; [已移除]; [已移除]; [已移除]`;
        const stored = errorColumns(world.fixture.db, assistant);
        expect(stored).toEqual({
          status: "failed",
          error_reason: "request_rejected",
          error_status: 400,
          error_detail: expected,
        });
        const [error] = ofType(sessionEvents(world), "error");
        expect(error?.data.detail).toBe(expected);
        const [, reply] = (await snapshotOf(world)).messages;
        expect(reply?.error).toEqual({
          reason: "request_rejected",
          message: "请求被拒：模型服务拒绝了这次请求",
          status: 400,
          detail: expected,
        });
        const leaks = [KEY, "leak-token-0123456789", "sk-leak", "raw-http-request=", "127.0.0.1"];
        leaks.push("p4ss-secret", "tenant-0123456789", "q-secret-0123");
        for (const actual of [stored?.error_detail, error?.data.detail, reply?.error]) {
          for (const leak of leaks) {
            expect(JSON.stringify(actual)).not.toContain(leak);
          }
        }
      } finally {
        await world.fixture.close();
      }
    },
  );

  it(
    "a runtime failure naming the state dir, its realpath and the sandbox root stores and publishes them removed",
    REAL,
    async () => {
      const scripted = scriptedRuntime({ "spawn fails": [START] });
      // The state dir is a symlink, so its realpath is a second, different path in the list.
      const real = realpathSync(mkdtempSync(join(tmpdir(), "wb-909-state-real-")));
      const links = mkdtempSync(join(tmpdir(), "wb-909-state-link-"));
      temps.push(real, links);
      const link = join(links, "state");
      symlinkSync(real, link);
      ensureOmpStateLayout(link);
      scripted.runtime.stateDir = link;
      const sandbox = scripted.runtime.sandboxRoot;
      mkdirSync(sandbox, { recursive: true });
      const literal = `spawn failed: ${link}/home/.omp/agent/models.yml unreadable`;
      throwOnPrompt(`${literal}; ${real}/b; ${sandbox}/ws/c.txt`);
      const world = await openRecordingSession(scripted.runtime, {
        assembly: { upstream: { baseUrl: BASE_URL, apiKey: KEY } },
      });
      try {
        await prompt(world, world.session, "spawn fails");
        await waitForTurn(world.fixture, world.session, "failed");
        const assistant = assistantIdFor(world.fixture, world.session);
        const expected =
          "spawn failed: [已移除]/home/.omp/agent/models.yml unreadable; [已移除]/b; [已移除]/ws/c.txt";
        expect(errorColumns(world.fixture.db, assistant)).toEqual({
          status: "failed",
          error_reason: "agent_failed",
          error_status: null,
          error_detail: expected,
        });
        expect(ofType(sessionEvents(world), "error").map((event) => event.data)).toEqual([
          {
            messageId: assistant,
            message: "Agent 运行失败",
            reason: "agent_failed",
            status: null,
            detail: expected,
          },
        ]);
        const [, reply] = (await snapshotOf(world)).messages;
        expect(reply?.error).toEqual({
          reason: "agent_failed",
          message: "Agent 运行失败",
          status: null,
          detail: expected,
        });
      } finally {
        await world.fixture.close();
      }
    },
  );
});

describe("upstream-failure「上游原文净化」: realpaths are taken when a failure is sanitised", () => {
  for (const key of ["stateDir", "sandboxRoot"] as const) {
    it(
      `${key} under a symlinked parent, missing at createApp and created before the failure: its realpath form is removed`,
      REAL,
      async () => {
        const scripted = scriptedRuntime({ "spawn fails": [START] });
        const real = realpathSync(mkdtempSync(join(tmpdir(), "wb-909-parent-real-")));
        const links = mkdtempSync(join(tmpdir(), "wb-909-parent-link-"));
        temps.push(real, links);
        symlinkSync(real, join(links, "parent"));
        const configured = join(links, "parent", "dir");
        scripted.runtime[key] = configured;
        throwOnPrompt(`cannot open ${real}/dir/a.json; ${configured}/b`);
        expect(existsSync(configured)).toBe(false);
        const world = await openRecordingSession(scripted.runtime);
        try {
          if (key === "stateDir") {
            ensureOmpStateLayout(configured);
          } else {
            mkdirSync(configured, { recursive: true });
          }
          await prompt(world, world.session, "spawn fails");
          await waitForTurn(world.fixture, world.session, "failed");
          const assistant = assistantIdFor(world.fixture, world.session);
          const expected = "cannot open [已移除]/a.json; [已移除]/b";
          expect(errorColumns(world.fixture.db, assistant)).toMatchObject({
            error_reason: "agent_failed",
            error_detail: expected,
          });
          expect(ofType(sessionEvents(world), "error")[0]?.data.detail).toBe(expected);
        } finally {
          await world.fixture.close();
        }
      },
    );

    it(
      `${key} configured with '//' and '/./' under a symlinked parent: its normalised, unresolved form is removed`,
      REAL,
      async () => {
        const scripted = scriptedRuntime({ "spawn fails": [START] });
        const real = realpathSync(mkdtempSync(join(tmpdir(), "wb-909-norm-real-")));
        const links = mkdtempSync(join(tmpdir(), "wb-909-norm-link-"));
        temps.push(real, links);
        symlinkSync(real, join(links, "parent"));
        // Concatenated, not joined: `join` would normalise the very form this case is about.
        const configured = `${links}//parent/./dir`;
        const normalised = `${links}/parent/dir`;
        scripted.runtime[key] = configured;
        if (key === "stateDir") {
          ensureOmpStateLayout(configured);
        } else {
          mkdirSync(configured, { recursive: true });
        }
        throwOnPrompt(`cannot open ${normalised}/a.json; ${real}/dir/b; ${configured}/c`);
        const world = await openRecordingSession(scripted.runtime);
        try {
          await prompt(world, world.session, "spawn fails");
          await waitForTurn(world.fixture, world.session, "failed");
          const assistant = assistantIdFor(world.fixture, world.session);
          const expected = "cannot open [已移除]/a.json; [已移除]/b; [已移除]/c";
          expect(errorColumns(world.fixture.db, assistant)).toMatchObject({
            error_reason: "agent_failed",
            error_detail: expected,
          });
          expect(ofType(sessionEvents(world), "error")[0]?.data.detail).toBe(expected);
        } finally {
          await world.fixture.close();
        }
      },
    );

    it(
      `${key} configured with a trailing '/', missing when the failure is sanitised: the form without the slash is removed`,
      REAL,
      async () => {
        const scripted = scriptedRuntime({ "spawn fails": [START] });
        const base = realpathSync(mkdtempSync(join(tmpdir(), "wb-909-slash-")));
        temps.push(base);
        const configured = `${base}/missing/`;
        scripted.runtime[key] = configured;
        // Creating the session (sandbox root) or the spawn (state dir) makes the dir; the hook removes
        // it again before the failure, so no realpath stands in for the slash-less form.
        throwOnPrompt(`cannot open ${base}/missing; ${configured}a`, () => {
          rmSync(configured, { recursive: true, force: true });
        });
        expect(existsSync(configured)).toBe(false);
        const world = await openRecordingSession(scripted.runtime);
        try {
          await prompt(world, world.session, "spawn fails");
          await waitForTurn(world.fixture, world.session, "failed");
          const assistant = assistantIdFor(world.fixture, world.session);
          expect(existsSync(configured)).toBe(false);
          const expected = "cannot open [已移除]; [已移除]a";
          expect(errorColumns(world.fixture.db, assistant)).toMatchObject({
            error_reason: "agent_failed",
            error_detail: expected,
          });
          expect(ofType(sessionEvents(world), "error")[0]?.data.detail).toBe(expected);
        } finally {
          await world.fixture.close();
        }
      },
    );
  }
});

describe("upstream-failure「落库先于发布」: a failed column write publishes nothing", () => {
  it(
    "recordError throwing: no error event, the fault is retained and the slot retired",
    REAL,
    async () => {
      const runtime = scriptedRuntime({
        "fail 500": [START, failedEnd(502, STATUS_500), TERMINAL],
      });
      const world = await openRecordingSession(runtime.runtime);
      let shutdownReported = false;
      try {
        world.fixture.db.exec(`CREATE TEMP TRIGGER reject_error_columns
          BEFORE UPDATE OF error_reason ON chat_messages
          BEGIN SELECT RAISE(ABORT, 'error column sentinel'); END`);
        await prompt(world, world.session, "fail 500");
        const published = () => ofType(sessionEvents(world), "error");
        await waitFor(
          () => (world.errors.length > 0 || published().length > 0 ? true : undefined),
          "the store fault or a published error",
        );
        expect(published()).toEqual([]);
        expect(world.errors.map(String)).toEqual([
          expect.stringContaining("error column sentinel"),
        ]);
        const assistant = assistantIdFor(world.fixture, world.session);
        expect(errorColumns(world.fixture.db, assistant)).toMatchObject({
          error_reason: null,
          error_status: null,
          error_detail: null,
        });
        const token = requiredToken(requiredCall(runtime.calls, 0).token);
        await waitFor(
          () => (world.fixture.tokens.lookup(token) === null ? true : undefined),
          "the retired slot's token revocation",
        );
        await assertRetainedFaultOnShutdown(world.fixture, "error column sentinel");
        shutdownReported = true;
      } finally {
        await closeAfterRetainedFault(world.fixture, shutdownReported);
      }
    },
  );
});

describe("chat-sessions「会话 REST」: every message carries an error value", () => {
  it(
    "a done turn, then a failed one: users and the done reply read null, the failed reply the object",
    REAL,
    async () => {
      const runtime = scriptedRuntime({
        ok: [
          START,
          { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
          TERMINAL,
        ],
        "fail 401": [START, failedEnd(401, KEY_401), TERMINAL],
      });
      const world = await openRecordingSession(runtime.runtime);
      try {
        const second = await createSession(world.fixture.app, world.cookie);
        await prompt(world, world.session, "ok");
        await waitForTurn(world.fixture, world.session, "done");
        await prompt(world, world.session, "fail 401");
        await waitForTurn(world.fixture, world.session, "failed");
        const { messages } = await snapshotOf(world);
        expect(messages.map((message) => [message.role, message.status])).toEqual([
          ["user", "done"],
          ["assistant", "done"],
          ["user", "done"],
          ["assistant", "failed"],
        ]);
        expect(messages.slice(0, 3).map((message) => message.error)).toEqual([null, null, null]);
        expect(messages[3]?.error).toMatchObject({ reason: "auth_failed", status: 401 });
        expect((await snapshotOf(world, second)).messages).toEqual([]);
      } finally {
        await world.fixture.close();
      }
    },
  );
});

/**
 * 钩子辅助: the runtime's own failure texts are fixed strings, so every turn's frame stream is
 * wrapped to throw `text` (naming the server paths) after its agent_start.
 */
function throwOnPrompt(text: string, beforeThrow: () => void = () => {}): void {
  const original = SessionRuntime.prototype.prompt;
  vi.spyOn(SessionRuntime.prototype, "prompt").mockImplementation(function (
    this: SessionRuntime,
    message: string,
  ) {
    const stream = original.call(this, message);
    return Object.assign(throwAfterStart(stream, text, beforeThrow), {
      dispatched: stream.dispatched,
    });
  });
}

/** Yields the stream's frames through its first `agent_start`, runs `beforeThrow`, throws `message`. */
function throwAfterStart(
  stream: AsyncIterable<OmpFrame>,
  message: string,
  beforeThrow: () => void,
): AsyncIterable<OmpFrame> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const frame of stream) {
        yield frame;
        if (frame.type === "agent_start") {
          beforeThrow();
          throw new Error(message);
        }
      }
    },
  };
}
