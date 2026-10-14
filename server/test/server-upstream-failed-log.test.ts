/**
 * Issue #909 task 5.4: http-service-skeleton「上游失败记录」at the production seam — the
 * `appAssemblyOf(config)` the main path hands to createApp (its `log` is the entry's managed stderr
 * writer), over scripted controlled children. Oracles: process.stderr/stdout write spies. The
 * scripted 401 text carries the configured key verbatim, so a record that leaked the failure text
 * would show it.
 */
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { appAssemblyOf, resolveServerConfig } from "../src/server.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { settle } from "./session-approval-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor, postPrompt } from "./session-rest-helpers.js";
import {
  closeOnEof,
  createControlledRuntime,
  createSession,
  OWNER_ID,
  waitFor,
} from "./session-supervisor-helpers.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const UPSTREAM_KEY = "k-909-log-secret";

type WriteCallback = (error?: Error | null) => void;

function spyWrites(stream: NodeJS.WriteStream) {
  return vi.spyOn(stream, "write").mockImplementation(((_chunk: unknown, ...rest: unknown[]) => {
    rest.find((arg): arg is WriteCallback => typeof arg === "function")?.(null);
    return true;
  }) as typeof stream.write);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("http-service-skeleton「上游失败记录」", () => {
  it("the production assembly writes one upstream_failed line for a 401 turn and none for a process exit", {
    timeout: 20_000,
  }, async () => {
    const runtime = createControlledRuntime((child) => {
      closeOnEof(child);
      child.onCommand("prompt", (frame) => {
        child.emitLine({ type: "agent_start" });
        if (frame.message === "exit") {
          // After the prompt write settled: an exit inside it would fail the dispatch (a 502).
          setTimeout(() => {
            child.endStdout();
            child.exit(1);
          }, 10);
          return;
        }
        child.emitLine({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorStatus: 401,
            errorMessage: `401 rejected key ${UPSTREAM_KEY}\nrejected key ${UPSTREAM_KEY} (type=scripted_error)`,
          },
        });
        child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
      });
    });
    const config = resolveServerConfig(
      { MODEL_UPSTREAM_BASE_URL: "http://127.0.0.1:9/v1", MODEL_UPSTREAM_API_KEY: UPSTREAM_KEY },
      ENTRY,
    );
    const production = appAssemblyOf(config);
    const db = openDb(":memory:");
    const app = createApp({
      db,
      authRuntime: fixedRuntime(() => FIXED_NOW),
      assembly: { ...production, runtime: runtime.runtime, tokens: new TokenRegistry() },
    });
    const stdout = spyWrites(process.stdout);
    const stderr = spyWrites(process.stderr);
    try {
      const cookie = await cookieFor(app, "zhangsan");
      const rejected = await createSession(app, cookie);
      const crashed = await createSession(app, cookie);
      for (const [session, text] of [
        [rejected, "fail"],
        [crashed, "exit"],
      ] as const) {
        const response = await postPrompt(app, session, cookie, JSON.stringify({ message: text }));
        expect(response.statusCode).toBe(202);
        await waitFor(
          () =>
            app.sessions.store.getMessages(session, OWNER_ID)?.session.status === "failed"
              ? true
              : undefined,
          `${text} turn to fail`,
        );
      }
      await settle(4);
      const lines = stderr.mock.calls.map((call) => String(call[0]));
      expect(lines).toEqual([
        `{"event":"upstream_failed","sessionId":"${rejected}","reason":"auth_failed","status":401}\n`,
      ]);
      expect(lines.join("")).not.toContain(UPSTREAM_KEY);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      await app.close();
      db.close();
    }
  });
});
