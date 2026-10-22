/**
 * s1d-model-registry group 5 (tasks 5.2 / 5.4, design D18): upstream-failure「上游原文净化」's new scenario
 * 「注册表登记的密钥不进会话」at the production seam — createApp with `assembly.models` the real registry on
 * the app's own database and no `assembly.upstream`, over scripted controlled children (the precedent is
 * `session-message-error.test.ts`「through createApp's secret list」). The key and base URL are
 * registered through the store after createApp, then replaced by a second pair: the sessions-side
 * sanitiser must read the registry's secret list afresh on every failure. Expected details are the
 * sanitiser's step-3 literals; the scripted 401 text echoes the registered key and base URL verbatim.
 */
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { createRegistry } from "../src/models/registry.js";
import { createModelStore } from "../src/models/store.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { ofType, sessionEvents } from "./session-approval-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  assistantIdFor,
  closeOnEof,
  createControlledRuntime,
  createSession,
  openRecordingSession,
  type RecordingWorld,
  waitForTurn,
} from "./session-supervisor-helpers.js";

const REAL = { timeout: 15_000 };
const MODEL = "m-registered";
/** Low-entropy sentinels (no `sk-` prefix, so step 4 cannot be what removes them; no `@` in the URLs). */
const FIRST = {
  apiKey: "wb-issue1647-registry-key-one",
  baseUrl: "http://127.0.0.1:9/registry-tenant-one/v1",
};
const SECOND = {
  apiKey: "wb-issue1647-registry-key-two",
  baseUrl: "http://127.0.0.1:9/registry-tenant-two/v1",
};
const START: OmpFrame = { type: "agent_start" };
const TERMINAL: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };

/** What a 401 echoing `upstream` reads as: the key, the base URL whole and its long path segment. */
function echo(upstream: typeof FIRST): string {
  return `401 rejected key ${upstream.apiKey}\nvia ${upstream.baseUrl}; ${tenant(upstream)}`;
}

function tenant(upstream: typeof FIRST): string {
  return upstream.baseUrl.split("/")[3] ?? "";
}

const EXPECTED_DETAIL = "401 rejected key [已移除]\nvia [已移除]; [已移除]";

function failed401(text: string): OmpFrame[] {
  return [
    START,
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorStatus: 401, errorMessage: text },
    },
    TERMINAL,
  ];
}

function storedDetail(db: DatabaseSync, id: number): unknown {
  return db
    .prepare("SELECT error_reason, error_status, error_detail FROM chat_messages WHERE id = ?")
    .get(id);
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

async function readBack(world: RecordingWorld, session: string): Promise<string[]> {
  const bodies: string[] = [];
  for (const url of [`/api/sessions/${session}/messages`, "/api/sessions"]) {
    const response = await world.fixture.app.inject({
      method: "GET",
      url,
      headers: { cookie: world.cookie },
    });
    expect(response.statusCode).toBe(200);
    bodies.push(response.payload);
  }
  return bodies;
}

describe("upstream-failure「注册表登记的密钥不进会话」through createApp's registry", () => {
  it(
    "a key registered after createApp, and the key that replaces it, are removed from detail, rows, views and events",
    REAL,
    async () => {
      const db = openDb(":memory:");
      const store = createModelStore(db);
      store.create({ id: MODEL });
      const registry = createRegistry(store);
      registry.refresh();
      const scripted = createControlledRuntime((child) => {
        closeOnEof(child);
        child.onCommand("prompt", (frame) => {
          const upstream = frame.message === "fail one" ? FIRST : SECOND;
          for (const line of failed401(echo(upstream))) child.emitLine(line);
        });
      });
      const world = await openRecordingSession(scripted.runtime, {
        db,
        assembly: { models: registry },
      });
      try {
        const cases = [
          ["fail one", FIRST, world.session],
          ["fail two", SECOND, await createSession(world.fixture.app, world.cookie)],
        ] as const;
        for (const [text, upstream, session] of cases) {
          store.update(MODEL, {
            name: MODEL,
            reasoning: false,
            vision: false,
            maxTokens: 32768,
            upstream,
          });
          registry.refresh();

          await prompt(world, session, text);
          await waitForTurn(world.fixture, session, "failed");

          const stored = storedDetail(db, assistantIdFor(world.fixture, session));
          expect(stored).toEqual({
            error_reason: "auth_failed",
            error_status: 401,
            error_detail: EXPECTED_DETAIL,
          });
          const [error] = ofType(sessionEvents(world, session), "error");
          expect(error?.data.detail).toBe(EXPECTED_DETAIL);
          const published = JSON.stringify(sessionEvents(world, session));
          const seen = [JSON.stringify(stored), published, ...(await readBack(world, session))];
          for (const leak of [FIRST, SECOND].flatMap((up) => [up.apiKey, up.baseUrl, tenant(up)])) {
            for (const text of seen) {
              expect(text).not.toContain(leak);
            }
          }
        }
      } finally {
        await world.fixture.close();
      }
    },
  );
});
