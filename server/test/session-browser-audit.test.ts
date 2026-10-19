/**
 * Issue #1526 (omp-browser-integration design D5/D6) through the production assembly (createApp →
 * registerSessions → SessionSupervisor, in-memory SQLite) with scripted controlled children
 * (session-approval-script.ts; fake-omp has no browser scenario and stays unchanged, design D9):
 * - tool-approval「浏览器调用的审批改写为浏览器操作」 (registration, event, audit) and
 *   「浏览器审批与浏览器步骤配对」 (pairing, the six-key published step.start, ring and SSE);
 * - browser-runtime「浏览器调用审计」: 「每次浏览器调用一条审计」 and 「审计失败时步骤不落库」.
 * The store-without-emit half of the last scenario runs at the persistEvent/store seam: the
 * production assembly always injects audit-core's emit, so a supervisor cannot be built without it.
 * Oracles are the test's own SQL over chat_steps / chat_approvals / audit_events, the recorded
 * onEvent stream, SSE bytes and the spawn argv; expected values are literals from those scenarios.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PumpSteps } from "../src/sessions/approval-pairing.js";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { persistEvent } from "../src/sessions/turn-control.js";
import {
  approvalRows,
  flagValue,
  ofType,
  parseSse,
  prompted,
  REAL,
  sessionEvents,
  settle,
  waitForEvent,
} from "./session-approval-helpers.js";
import {
  AGENT_END,
  chunk,
  closeScripted,
  decide,
  end,
  openScripted,
  pairingRows,
  start,
  stepRows,
} from "./session-approval-script.js";
import { openEventStream, readUntil } from "./session-sse-helpers.js";
import { withSessionStore } from "./session-store-helpers.js";
import {
  assistantIdFor,
  containsMessage,
  OWNER_ID,
  type RecordingWorld,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";

afterEach(closeScripted);

const AUDIT_TITLE = "浏览器操作";
const SENTINEL = "browser audit sentinel";
const MARK = "…（已截断）";
const STEP_START_KEYS = ["approvalId", "bodyOffset", "detail", "messageId", "name", "stepId"];

function browserTitle(content: string, path = "xd://browser"): string {
  return `Allow tool: write\nPath: ${path}\nContent:\n${content}`;
}

function select(id: string, title: string): OmpFrame {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title,
    options: ["Approve", "Deny"],
  };
}

function writeStart(call: string, path: string, content: string): OmpFrame {
  return {
    type: "tool_execution_start",
    toolCallId: call,
    toolName: "write",
    args: { path, content },
  };
}

function browserEnd(call: string): OmpFrame {
  const xdev = { tool: "browser", mode: "execute", inner: { action: "open", name: "main" } };
  return {
    type: "tool_execution_end",
    toolCallId: call,
    toolName: "write",
    result: { content: [{ type: "text", text: `${call} ok` }], details: { xdev } },
  };
}

function setTier(world: RecordingWorld, mode: "write" | "yolo"): void {
  world.fixture.db
    .prepare("UPDATE chat_sessions SET approval_mode = ? WHERE id = ?")
    .run(mode, world.session);
}

function auditRows(db: DatabaseSync, kind: string) {
  return db
    .prepare("SELECT actor_id, kind, title, detail FROM audit_events WHERE kind = ? ORDER BY id")
    .all(kind)
    .map((row) => ({
      ...row,
      detail: JSON.parse(String(row.detail)) as unknown,
      raw: String(row.detail),
    }));
}

describe("tool-approval「浏览器调用的审批改写为浏览器操作」 through the supervisor", () => {
  const OPEN = '{"action":"open","url":"https://example.com/a"}';
  const RUN =
    '{"action":"run","name":"main","code":"return await tab.screenshot()","app":{"cdp_url":"http://10.0.0.5:9222"}}';
  const CUT = '{"action":"run","code":"x[…5000ch elided…]"';
  const FULL_CUT = JSON.stringify({ action: "run", code: "x".repeat(5001) });
  const TITLES = [
    "浏览器：打开 https://example.com/a",
    "浏览器：在标签页 main 执行脚本\n⚠ 连接外部浏览器：http://10.0.0.5:9222\n代码：\nreturn await tab.screenshot()",
    `浏览器操作（参数过长，以下为原文）\n⚠ 参数被截断，无法确认是否启动外部程序或连接外部浏览器\n${CUT}`,
  ];

  it(
    "chat_approvals, approval.request and session.approval all carry tool browser and the rewritten title",
    REAL,
    async () => {
      let answered = 0;
      const { world, calls } = await openScripted({
        prompt: (child) =>
          child.emitRaw(
            chunk(
              select("r1", browserTitle(OPEN)),
              select("r2", browserTitle(RUN)),
              select("r3", browserTitle(CUT)),
              writeStart("b1", "xd://browser", OPEN),
              writeStart("b2", "xd://browser", RUN),
              writeStart("b3", "xd://browser", FULL_CUT),
            ),
          ),
        answer: (child) => {
          answered += 1;
          if (answered === 3)
            child.emitRaw(chunk(browserEnd("b1"), browserEnd("b2"), browserEnd("b3"), AGENT_END));
        },
      });
      setTier(world, "write");
      await prompted(world);
      await waitForEvent(world, "approval.request", 3);
      await waitForEvent(world, "step.start", 3);
      for (const id of ["r1", "r2", "r3"]) await decide(world, id, "allow");
      await waitForTurn(world.fixture, world.session, "done");

      expect(flagValue(calls[0]?.args ?? [], "--approval-mode")).toBe("write");
      const rows = approvalRows(world.fixture.db, world.session);
      expect(rows.map((row) => [row.tool, row.title])).toEqual(
        TITLES.map((title) => ["browser", title]),
      );
      expect(
        ofType(sessionEvents(world), "approval.request").map((event) => [
          event.data.tool,
          event.data.title,
        ]),
      ).toEqual(TITLES.map((title) => ["browser", title]));
      expect(
        auditRows(world.fixture.db, "session.approval").map((row) => row.detail),
      ).toMatchObject([1, 2, 3].map(() => ({ tool: "browser", decision: "allow" })));
      const messageId = assistantIdFor(world.fixture, world.session);
      const steps = stepRows(world.fixture.db, messageId);
      expect(steps.map((row) => row.name)).toEqual(["browser", "browser", "browser"]);
      expect(pairingRows(world.fixture.db, messageId).map((row) => row.step_id)).toEqual(
        steps.map((row) => row.id),
      );
      expect(world.errors).toEqual([]);
    },
  );
});

describe("tool-approval「浏览器审批与浏览器步骤配对」", () => {
  const OPEN = '{"action":"open","url":"https://a"}';
  const NOTES_TITLE = "Allow tool: write\nPath: notes.md\nContent:\nhi";

  it(
    "the browser step takes the browser approval, the write step its own; step.start stays six keys",
    REAL,
    async () => {
      let answered = 0;
      const { world } = await openScripted({
        prompt: (child) =>
          child.emitRaw(
            chunk(select("r1", browserTitle(OPEN)), writeStart("b1", "xd://browser", OPEN)),
          ),
        answer: (child) => {
          answered += 1;
          if (answered === 1) {
            child.emitRaw(
              chunk(
                browserEnd("b1"),
                select("r2", NOTES_TITLE),
                writeStart("w2", "notes.md", "hi"),
              ),
            );
          } else {
            child.emitRaw(chunk(end("w2", "write"), AGENT_END));
          }
        },
      });
      setTier(world, "write");
      const stream = await openEventStream(world.fixture, world.session, world.cookie);
      stream.resume();
      await prompted(world);
      await waitForEvent(world, "approval.request");
      await decide(world, "r1", "allow");
      await waitForEvent(world, "approval.request", 2);
      await decide(world, "r2", "allow");
      await waitForTurn(world.fixture, world.session, "done");
      const sse = parseSse(await readUntil(stream, (text) => text.includes("event: turn.end")));
      stream.abort();

      const messageId = assistantIdFor(world.fixture, world.session);
      const [browser, write] = stepRows(world.fixture.db, messageId);
      const [r1, r2] = approvalRows(world.fixture.db, world.session);
      expect([browser?.name, write?.name]).toEqual(["browser", "write"]);
      expect([r1?.tool, r2?.tool]).toEqual(["browser", "write"]);
      expect(pairingRows(world.fixture.db, messageId).map((row) => row.step_id)).toEqual([
        browser?.id,
        write?.id,
      ]);
      const published = ofType(sessionEvents(world), "step.start").map((event) => event.data);
      expect(published[0]).toEqual({
        messageId,
        stepId: browser?.id,
        name: "browser",
        detail: `浏览器：打开 https://a\n${OPEN}`,
        bodyOffset: 0,
        approvalId: r1?.id,
      });
      expect(published[1]).toMatchObject({ name: "write", approvalId: r2?.id });
      const fromSse = sse
        .filter((frame) => frame.event === "step.start")
        .map((frame) => frame.data);
      expect(fromSse).toEqual(published);
      for (const data of [...published, ...fromSse]) {
        expect(Object.keys(data).sort()).toEqual(STEP_START_KEYS);
      }
      expect(world.errors).toEqual([]);
    },
  );
});

describe("browser-runtime「浏览器调用审计」", () => {
  const OPEN_URL = "https://example.com/doc";
  const CDP = "http://10.0.0.5:9222";
  const LONG_CODE = `/*${"y".repeat(5000)}*/ return 1`;

  it(
    "yolo: one session.browser per browser step, from the full arguments; none for bash",
    REAL,
    async () => {
      const longRun = JSON.stringify({ action: "run", code: LONG_CODE, app: { cdp_url: CDP } });
      const { world, calls } = await openScripted({
        prompt: (child) =>
          child.emitRaw(
            chunk(
              writeStart("b1", "xd://browser", JSON.stringify({ action: "open", url: OPEN_URL })),
              browserEnd("b1"),
              writeStart("b2", "xd://browser", longRun),
              browserEnd("b2"),
              start("c3"),
              end("c3"),
              AGENT_END,
            ),
          ),
      });
      setTier(world, "yolo");
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");

      expect(flagValue(calls[0]?.args ?? [], "--approval-mode")).toBe("yolo");
      const messageId = assistantIdFor(world.fixture, world.session);
      const audits = auditRows(world.fixture.db, "session.browser");
      expect(audits.map(({ raw: _raw, ...row }) => row)).toEqual([
        {
          actor_id: OWNER_ID,
          kind: "session.browser",
          title: AUDIT_TITLE,
          detail: {
            sessionId: world.session,
            messageId,
            action: "open",
            url: OPEN_URL,
            external: null,
          },
        },
        {
          actor_id: OWNER_ID,
          kind: "session.browser",
          title: AUDIT_TITLE,
          detail: {
            sessionId: world.session,
            messageId,
            action: "run",
            url: null,
            external: { cdpUrl: CDP },
          },
        },
      ]);
      for (const audit of audits) expect(audit.raw).not.toContain("yyyy");
      const steps = world.fixture.db
        .prepare("SELECT name, detail FROM chat_steps WHERE message_id = ? ORDER BY ordinal")
        .all(messageId) as Array<{ name: string; detail: string }>;
      expect(steps.map((row) => row.name)).toEqual(["browser", "browser", "bash"]);
      // The stored detail lost the arguments' tail; the audit above still has the external browser.
      expect(steps[1]?.detail.endsWith(MARK)).toBe(true);
      expect(auditRows(world.fixture.db, "session.approval")).toEqual([]);
      expect(world.errors).toEqual([]);
    },
  );

  it("yolo: app written as a JSON string audits external as unverified", REAL, async () => {
    const content = '{"action":"open","url":"https://a","app":"{\\"path\\":\\"/bin/sh\\"}"}';
    const { world } = await openScripted({
      prompt: (child) =>
        child.emitRaw(
          chunk(writeStart("b1", "xd://browser", content), browserEnd("b1"), AGENT_END),
        ),
    });
    setTier(world, "yolo");
    await prompted(world);
    await waitForTurn(world.fixture, world.session, "done");

    const messageId = assistantIdFor(world.fixture, world.session);
    expect(auditRows(world.fixture.db, "session.browser").map((row) => row.detail)).toEqual([
      {
        sessionId: world.session,
        messageId,
        action: "open",
        url: "https://a",
        external: { unverified: true },
      },
    ]);
    expect(world.errors).toEqual([]);
  });

  it(
    "a failing audit write: the browser step is neither stored nor published, the ring stops",
    REAL,
    async () => {
      const { world } = await openScripted({
        prompt: (child) =>
          child.emitRaw(
            chunk(
              start("c1"),
              end("c1"),
              writeStart("b2", "xd://browser", '{"action":"open","url":"https://a"}'),
            ),
          ),
        faulted: true,
      });
      world.fixture.db.exec(`CREATE TEMP TRIGGER reject_browser_audit BEFORE INSERT ON audit_events
        WHEN NEW.kind = 'session.browser' BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`);
      // Opened before the turn and flowing: it receives live exactly what the ring takes.
      const stream = await openEventStream(world.fixture, world.session, world.cookie);
      stream.resume();
      await prompted(world);
      await waitFor(
        () => (world.errors.some((error) => containsMessage(error, SENTINEL)) ? true : undefined),
        "the retained browser audit fault",
      );
      const epoch = String(sessionEvents(world)[0]?.epoch);
      await readUntil(stream, (text) => text.includes(`id: ${epoch}:3\n`));
      await settle();
      const sse = parseSse(await readUntil(stream, () => true));
      stream.abort();

      const messageId = assistantIdFor(world.fixture, world.session);
      expect(stepRows(world.fixture.db, messageId).map((row) => row.name)).toEqual(["bash"]);
      const types = sessionEvents(world).map((entry) => entry.event.type);
      expect(types).toEqual(["turn.start", "step.start", "step.end"]);
      // The ring took ids 1–3 (the bash step) and no fourth: the browser step.start spent none.
      expect(sse.map((frame) => [frame.id, frame.event])).toEqual([
        [`${epoch}:1`, "turn.start"],
        [`${epoch}:2`, "step.start"],
        [`${epoch}:3`, "step.end"],
      ]);
      expect(auditRows(world.fixture.db, "session.browser")).toEqual([]);
      expect(world.errors.filter((error) => containsMessage(error, SENTINEL))).toHaveLength(1);
    },
  );
});

describe("browser-runtime「审计失败时步骤不落库」: a store without emit", () => {
  function stepStart(name: string, extra: object = {}): ChatEvent<string> {
    return {
      type: "step.start",
      data: { messageId: 0, stepId: `call-${name}`, name, detail: "{}", ...extra },
    } as ChatEvent<string>;
  }

  it("the browser step.start throws and stores nothing; a bash step lands as before", () => {
    withSessionStore(({ db, store }) => {
      const session = store.create(OWNER_ID).id;
      const turn = store.acceptPrompt(session, OWNER_ID, "go").assistantMessageId;
      const steps = new PumpSteps(turn);
      const persist = (event: ChatEvent<string>) =>
        persistEvent(store, turn, event, steps, [], null, (text) => text);
      const browser = stepStart("browser", {
        browser: { action: "open", url: "https://a", external: null },
      });

      expect(() => persist(browser)).toThrow(/audit emit/u);
      expect(stepRows(db, turn)).toEqual([]);
      expect(steps.toolIds.size).toBe(0);

      const published = persist(stepStart("bash"));
      const [row] = stepRows(db, turn);
      expect(row?.name).toBe("bash");
      expect(published).toEqual({
        type: "step.start",
        data: {
          messageId: 0,
          stepId: row?.id,
          name: "bash",
          detail: "{}",
          bodyOffset: 0,
          approvalId: null,
        },
      });
      expect(auditRows(db, "session.browser")).toEqual([]);
    });
  });
});
