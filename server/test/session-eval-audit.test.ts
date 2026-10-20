/**
 * Issue #1568 (omp-pin-18-12 design D7) browser-runtime「浏览器调用审计」 for `eval` steps: the
 * `session.browser` rows written in the step-end transaction from the reducer's `browser` field.
 * - 「每次浏览器调用一条审计」 and the write-failure half of「审计失败时步骤不落库」 run through the
 *   production assembly (createApp → registerSessions → SessionSupervisor, in-memory SQLite) with a
 *   scripted controlled child (session-approval-script.ts);
 * - the store-without-emit half runs at the persistEvent/store seam: the production assembly always
 *   injects audit-core's emit (same split as session-browser-audit.test.ts, #1526).
 * Oracles are the test's own SQL over chat_steps / chat_messages / audit_events, the recorded onEvent
 * stream and SSE bytes; expected values are literals from those scenarios.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PumpSteps } from "../src/sessions/approval-pairing.js";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { persistEvent } from "../src/sessions/turn-control.js";
import {
  ofType,
  parseSse,
  prompted,
  REAL,
  sessionEvents,
  settle,
} from "./session-approval-helpers.js";
import {
  AGENT_END,
  chunk,
  closeScripted,
  end,
  openScripted,
  start,
  stepRows,
} from "./session-approval-script.js";
import { openEventStream, readUntil } from "./session-sse-helpers.js";
import { withSessionStore } from "./session-store-helpers.js";
import {
  assistantIdFor,
  containsMessage,
  OWNER_ID,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";

afterEach(closeScripted);

const TITLE = "浏览器操作";
const FAULT = "eval browser audit sentinel";
const TIMEOUT = "Browser open timed out after 30000ms";
const CODE = "await browser.open({ name: 'main', url: 'https://a' }); // marker-code-text";
const STEP_END_KEYS = ["messageId", "output", "status", "stepId"];

function evalStart(call: string): OmpFrame {
  return {
    type: "tool_execution_start",
    toolCallId: call,
    toolName: "eval",
    args: { language: "js", code: CODE },
  };
}

function evalEnd(call: string, details: object, isError = false): OmpFrame {
  return {
    type: "tool_execution_end",
    toolCallId: call,
    toolName: "eval",
    isError,
    result: { content: [{ type: "text", text: `${call} out` }], details },
  };
}

function browserAudits(db: DatabaseSync) {
  return db
    .prepare("SELECT actor_id, title, detail FROM audit_events WHERE kind = ? ORDER BY id")
    .all("session.browser")
    .map((row) => ({
      actor: row.actor_id,
      title: row.title,
      detail: JSON.parse(String(row.detail)) as unknown,
      raw: String(row.detail),
    }));
}

function stepEnds(db: DatabaseSync, messageId: number) {
  return db
    .prepare("SELECT name, status, output FROM chat_steps WHERE message_id = ? ORDER BY ordinal")
    .all(messageId) as Array<{ name: string; status: string; output: string | null }>;
}

describe("browser-runtime「每次浏览器调用一条审计」 (eval statusEvents)", () => {
  it.each(["yolo", "write", "always-ask"])(
    "%s: one session.browser per browser status event plus the elided row; none for bash",
    async (tier) => {
      const { world } = await openScripted({
        prompt: (child) =>
          child.emitRaw(
            chunk(
              evalStart("e1"),
              evalEnd("e1", {
                language: "js",
                statusEvents: [
                  { op: "browser", detail: "open main https://a" },
                  { op: "eval", detail: "x" },
                  { op: "browser", detail: "main.screenshot()" },
                ],
              }),
              evalStart("e2"),
              evalEnd(
                "e2",
                { statusEvents: [{ op: "browser", error: TIMEOUT }], statusEventsElided: 2 },
                true,
              ),
              start("c3"),
              end("c3"),
              evalStart("e4"),
              evalEnd("e4", { statusEvents: [{ op: "eval", detail: "y" }] }),
              AGENT_END,
            ),
          ),
      });
      world.fixture.db
        .prepare("UPDATE chat_sessions SET approval_mode = ? WHERE id = ?")
        .run(tier, world.session);
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");

      const messageId = assistantIdFor(world.fixture, world.session);
      const [first, second, bash, fourth] = stepRows(world.fixture.db, messageId);
      expect(stepEnds(world.fixture.db, messageId)).toEqual([
        { name: "eval", status: "done", output: "e1 out" },
        { name: "eval", status: "failed", output: "e2 out" },
        { name: "bash", status: "done", output: "c3 ok" },
        { name: "eval", status: "done", output: "e4 out" },
      ]);
      const base = { sessionId: world.session, messageId };
      const audits = browserAudits(world.fixture.db);
      expect(audits.map(({ raw: _raw, ...row }) => row)).toEqual(
        [
          { ...base, stepId: first?.id, detail: "open main https://a", error: null },
          { ...base, stepId: first?.id, detail: "main.screenshot()", error: null },
          { ...base, stepId: second?.id, detail: null, error: TIMEOUT },
          { ...base, stepId: second?.id, elided: 2 },
        ].map((detail) => ({ actor: OWNER_ID, title: TITLE, detail })),
      );
      for (const audit of audits) {
        expect(audit.raw).not.toContain("marker-code-text");
        expect(audit.raw).not.toContain('"code"');
      }
      expect([bash?.id, fourth?.id]).not.toContain(undefined);
      const published = ofType(sessionEvents(world), "step.end").map((event) => event.data);
      expect(published.map((data) => data.stepId)).toEqual([
        first?.id,
        second?.id,
        bash?.id,
        fourth?.id,
      ]);
      for (const data of published) expect(Object.keys(data).sort()).toEqual(STEP_END_KEYS);
      expect(world.errors).toEqual([]);
    },
    REAL.timeout,
  );
});

describe("browser-runtime「审计失败时步骤不落库」 (eval step.end)", () => {
  it(
    "a failing audit write: the eval step.end is neither stored nor published, the turn stays open",
    REAL,
    async () => {
      const { world } = await openScripted({
        prompt: (child) =>
          child.emitRaw(
            chunk(
              start("c1"),
              end("c1"),
              evalStart("e2"),
              evalEnd("e2", { statusEvents: [{ op: "browser", detail: "open main https://a" }] }),
              AGENT_END,
            ),
          ),
        faulted: true,
      });
      world.fixture.db.exec(`CREATE TEMP TRIGGER reject_eval_audit BEFORE INSERT ON audit_events
        WHEN NEW.kind = 'session.browser' BEGIN SELECT RAISE(ABORT, '${FAULT}'); END`);
      const stream = await openEventStream(world.fixture, world.session, world.cookie);
      stream.resume();
      await prompted(world);
      await waitFor(
        () => (world.errors.some((error) => containsMessage(error, FAULT)) ? true : undefined),
        "the retained eval audit fault",
      );
      const epoch = String(sessionEvents(world)[0]?.epoch);
      await readUntil(stream, (text) => text.includes(`id: ${epoch}:4\n`));
      await settle();
      const sse = parseSse(await readUntil(stream, () => true));
      stream.abort();

      const messageId = assistantIdFor(world.fixture, world.session);
      expect(stepEnds(world.fixture.db, messageId)).toEqual([
        { name: "bash", status: "done", output: "c1 ok" },
        { name: "eval", status: "running", output: null },
      ]);
      expect(sse.map((frame) => [frame.id, frame.event])).toEqual([
        [`${epoch}:1`, "turn.start"],
        [`${epoch}:2`, "step.start"],
        [`${epoch}:3`, "step.end"],
        [`${epoch}:4`, "step.start"],
      ]);
      expect(sessionEvents(world).map((entry) => entry.event.type)).toEqual([
        "turn.start",
        "step.start",
        "step.end",
        "step.start",
      ]);
      const message = world.fixture.db
        .prepare("SELECT status FROM chat_messages WHERE id = ?")
        .get(messageId) as { status: string };
      expect(message.status).toBe("running");
      expect(browserAudits(world.fixture.db)).toEqual([]);
      expect(world.errors.filter((error) => containsMessage(error, FAULT))).toHaveLength(1);
    },
  );
});

describe("browser-runtime「审计失败时步骤不落库」: a store without emit (eval step.end)", () => {
  function event(type: "step.start" | "step.end", call: string, extra: object = {}) {
    const data =
      type === "step.start"
        ? { messageId: 0, stepId: call, name: call.startsWith("e") ? "eval" : "bash", detail: "{}" }
        : { messageId: 0, stepId: call, status: "done", output: `${call} out` };
    return { type, data: { ...data, ...extra } } as ChatEvent<string>;
  }

  type Persist = (persisted: ChatEvent<string>) => unknown;

  function seam(run: (db: DatabaseSync, persist: Persist, messageId: number) => void) {
    withSessionStore(({ db, store }) => {
      const session = store.create(OWNER_ID).id;
      const turn = store.acceptPrompt(session, OWNER_ID, "go").assistantMessageId;
      const steps = new PumpSteps(turn);
      const persist: Persist = (e) => persistEvent(store, turn, e, steps, [], null, (t) => t);
      run(db, persist, turn);
    });
  }

  it("an eval step.end carrying browser throws and stores nothing", () => {
    seam((db, persist, messageId) => {
      persist(event("step.start", "e1"));
      const browser = { calls: [{ detail: "open main https://a", error: null }], elided: 1 };
      let published: unknown = "not returned";
      expect(() => {
        published = persist(event("step.end", "e1", { browser }));
      }).toThrow(/audit emit/u);
      expect(published).toBe("not returned");
      expect(stepEnds(db, messageId)).toEqual([{ name: "eval", status: "running", output: null }]);
      expect(browserAudits(db)).toEqual([]);
    });
  });

  it("characterization: eval and bash step.end without browser land as before", () => {
    seam((db, persist, messageId) => {
      persist(event("step.start", "e1"));
      persist(event("step.start", "c2"));
      const ends = [persist(event("step.end", "e1")), persist(event("step.end", "c2"))];
      const ids = stepRows(db, messageId).map((row) => row.id);
      expect(ends).toEqual(
        ["e1", "c2"].map((call, index) => ({
          type: "step.end",
          data: { messageId: 0, stepId: ids[index], status: "done", output: `${call} out` },
        })),
      );
      expect(stepEnds(db, messageId)).toEqual([
        { name: "eval", status: "done", output: "e1 out" },
        { name: "bash", status: "done", output: "c2 out" },
      ]);
      expect(browserAudits(db)).toEqual([]);
    });
  });
});
