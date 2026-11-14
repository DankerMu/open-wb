/**
 * Issue #1975 (s2c-kb-session task 9.3): omp-runtime「host tool 的真实 omp 回归」 against the official
 * omp v18.12.3 binary — the white-box critical path (registration, call, approval pass-through) of
 * `kb_search` on the real child, and invariant 2 (`details` never reaches the model).
 *
 * The world is `openProxiedApp` (support/omp-official-proxied.ts) with the shared model registry, the
 * kb dependencies on a fake RAGFlow this file starts, and the upstream request bodies recorded. The
 * base and its document are written straight into the app's database (as kb-session-search.test.ts),
 * the retrieval hit is scripted on the fake RAGFlow. The prompt carries the fake upstream's
 * `WORKBUDDY_KB_SEARCH:<kbId>` marker (omp-test-harness「受控上游知识库检索标记」) and no knowledge base
 * reference, so the user text has no server suffix: round 1 asks the question, round 2 the question
 * plus ` 详细说明`, then the fixed answer. Expected values are the spec's and the group 9 second-cut
 * block's literals, not taken from `src/`.
 *
 * Issue #2004 (s2c-harness-followups group 2) adds the cases after the first turn: regenerate (the
 * session's own process branches), fork (a new generation registers once), the last base deleted
 * (`set_host_tools {tools:[]}`), a Deny under `always-ask`, and a project-level `.omp/tools/kb_search`
 * in the session's workspace. Their literals are the ones measured on v18.12.3 and recorded in
 * docs/reviews/2026-11-10-omp-host-tools.md §2.1, §2.4, §2.9 and §2.10.
 *
 * Run locally (`OMP_BIN` absolute):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-host-tools.test.ts --coverage=false
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KbDependencies } from "../src/kb/index.js";
import { resourceName } from "../src/kb/pipeline.js";
import { createKbStore } from "../src/kb/store.js";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";
import { OMP_TEST_OFF, OMP_VERSION, onTeardown } from "./support/omp-official.js";
import { toolMessages } from "./support/omp-official-bodies.js";
import {
  openAppSession,
  openProxiedApp,
  PROXIED_MODELS,
  type ProxiedApp,
  promptAppTurn,
  publishedOf,
  regenerateAppTurn,
} from "./support/omp-official-proxied.js";

const CASE = { timeout: 400_000 };
const RAGFLOW_KEY = "wb-issue1975-ragflow-key";
const UPSTREAM_KEY = "wb-issue1975-upstream-key";
const RETRIEVAL = "POST /api/v1/retrieval";
const HIT = "工单超过 48 小时未响应自动升级。";
const ANSWER = "已根据知识库检索结果作答。";
/** `details` keys and hit fields that must not reach the model. */
const LEAKS = ["details", "bases", "documentId", "similarity", "hits"];
/** omp v18.12.3's tool result text after the owner answers `Deny` (record §2.4). */
const DENIED = "Tool call denied by user: kb_search";
/** What the project-level `kb_search` returns: shows where a call landed. */
const PROJECT_TEXT = "PROJECT-KB-SEARCH-SENTINEL";

interface KbWorld {
  world: ProxiedApp;
  fake: FakeRagflowServer;
  kbId: string;
  session: string;
}

async function patch(world: ProxiedApp, session: string, body: unknown): Promise<void> {
  const response = await world.app.inject({
    method: "PATCH",
    url: `/api/sessions/${session}`,
    headers: { cookie: world.cookie, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  expect(response.statusCode).toBe(200);
}

/** zhangsan's ready 「规范库」 with 规格.md and one scripted hit; a fresh session on `mode`. */
async function openKbWorld(mode: "write" | "always-ask" = "write"): Promise<KbWorld> {
  const fake = await start({ apiKey: RAGFLOW_KEY });
  onTeardown(() => fake.close());
  // The kb records join the sessions port's `world.log`; any written before it exists go first.
  const early: Array<Record<string, unknown>> = [];
  let sink = early;
  const kb: KbDependencies = {
    key: { read: () => RAGFLOW_KEY },
    baseUrl: fake.baseUrl,
    uploadMaxBytes: 1024 * 1024,
    uploadMaxFiles: 10,
    log: (record) => {
      sink.push({ ...record });
    },
  };
  const world = await openProxiedApp({
    registry: { apiKey: UPSTREAM_KEY },
    kb,
    recordBodies: true,
  });
  world.log.unshift(...early);
  sink = world.log;
  const store = createKbStore(world.db);
  const kbId = store.newId();
  const datasetId = fake.addDataset(resourceName(kbId, 0));
  store.createBase({
    id: kbId,
    ownerId: "u1",
    name: "规范库",
    template: "naive",
    raptor: false,
    graph: false,
    datasetId,
    canvasId: null,
    templateGroupId: null,
  });
  store.addDocument({
    kbId,
    ragflowDocumentId: "rf-doc-1",
    name: "规格.md",
    size: 3,
    source: "upload",
  });
  fake.setRetrievalHits(datasetId, [{ documentId: "rf-doc-1", content: HIT, similarity: 0.9 }]);
  const session = await openAppSession(world);
  await patch(world, session, { approvalMode: mode });
  return { world, fake, kbId, session };
}

function toolNames(body: unknown): unknown[] {
  const tools = (body as { tools?: Array<{ function?: { name?: unknown } }> }).tools ?? [];
  return tools.map((tool) => tool.function?.name);
}

function isKbStart(event: ChatEvent<number>): boolean {
  return event.type === "step.start" && event.data.name === "kb_search";
}

type StepEvent = Extract<ChatEvent<number>, { type: "step.start" | "kb.hits" | "step.end" }>;

function isStepEvent(event: ChatEvent<number>): event is StepEvent {
  return event.type === "step.start" || event.type === "kb.hits" || event.type === "step.end";
}

/** The `step.start` / `kb.hits` / `step.end` events of the `kb_search` steps, in order. */
function kbStepEvents(events: ChatEvent<number>[]): StepEvent[] {
  const steps = events.filter(isStepEvent);
  const ids = new Set(steps.filter(isKbStart).map((event) => event.data.stepId));
  return steps.filter((event) => ids.has(event.data.stepId));
}

const isReady = (frame: OmpFrame) => frame.type === "ready";
const isRegistered = (frame: OmpFrame) =>
  frame.type === "response" && frame.command === "set_host_tools";
const isHostCall = (frame: OmpFrame) => frame.type === "host_tool_call";
const isSelect = (frame: OmpFrame) =>
  frame.type === "extension_ui_request" && frame.method === "select";
/** Two `kb_search` rounds as the published events show them. */
const TWO_KB_STEPS = ["step.start", "kb.hits", "step.end", "step.start", "kb.hits", "step.end"];

/** The last published event is a `turn.end` with status `done`. */
function expectDone(events: ChatEvent<number>[]): void {
  expect(events.at(-1)).toMatchObject({ type: "turn.end", data: { status: "done" } });
}

/** One process for the whole case, registered once, no retained fault. */
function expectOneGeneration(world: ProxiedApp): void {
  expect(world.frames.filter(isReady)).toHaveLength(1);
  expect(world.frames.filter(isRegistered)).toHaveLength(1);
  expect(world.faults).toEqual([]);
}

/** No call reached the host, the fake RAGFlow saw no retrieval, no retained fault. */
function expectNoRetrieval(world: ProxiedApp, fake: FakeRagflowServer): void {
  expect(world.frames.filter(isHostCall)).toEqual([]);
  expect(retrievals(fake)).toEqual([]);
  expect(world.faults).toEqual([]);
}

/** The prompt route itself, for a prompt that may be refused (`promptAppTurn` throws on non-202). */
function postPrompt(world: ProxiedApp, session: string, message: string) {
  return world.app.inject({
    method: "POST",
    url: `/api/sessions/${session}/prompt`,
    headers: { "content-type": "application/json", cookie: world.cookie },
    payload: JSON.stringify({ message }),
  });
}

/** The fake RAGFlow's retrieval questions, in order. */
function retrievals(fake: FakeRagflowServer): unknown[] {
  return fake
    .requests()
    .filter((entry) => `${entry.method} ${entry.path}` === RETRIEVAL)
    .map(({ json }) => (json as { question?: unknown }).question);
}

/** The commands omp answered among `frames`, in order. */
function answered(frames: readonly OmpFrame[]): unknown[] {
  return frames.flatMap((frame) => (frame.type === "response" ? [frame.command] : []));
}

/** How many entries of the request's `tools` are named `kb_search`. */
function kbToolCount(body: unknown): number {
  return toolNames(body).filter((name) => name === "kb_search").length;
}

/** The text `kb_search` gives the model for the one scripted hit. */
function hitText(kbId: string): string {
  return [`知识库「规范库」（${kbId}）：命中 1 条`, "[1] 规格.md（相似度 0.9000）", HIT].join("\n");
}

/** The session's user message ids, in order. */
function userIds(world: ProxiedApp, session: string): number[] {
  const rows = world.db
    .prepare("SELECT id FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id")
    .all(session) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/**
 * Writes `.omp/tools/kb_search.js` into the session's workspace (its cwd) before the first prompt
 * spawns the child: the smallest module omp v18.12.3 loads (record §2.10). `essential` adds
 * `loadMode: "essential"`, without which omp keeps a custom tool out of the request's `tools`.
 */
function writeProjectTool(world: ProxiedApp, session: string, essential: boolean): void {
  const { dir } = world.db
    .prepare(
      "SELECT w.dir AS dir FROM chat_sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?",
    )
    .get(session) as { dir: string };
  const tools = join(world.sandboxRoot, "u1", dir, ".omp", "tools");
  mkdirSync(tools, { recursive: true });
  const loadMode = essential ? ' loadMode: "essential",' : "";
  writeFileSync(
    join(tools, "kb_search.js"),
    `export default () => ({ name: "kb_search", description: "project kb_search",${loadMode} ` +
      'parameters: { type: "object", properties: { question: { type: "string" } } }, ' +
      `async execute() { return { content: [{ type: "text", text: "${PROJECT_TEXT}" }] }; } });\n`,
  );
}

function answerText(events: ChatEvent<number>[]): string {
  return events
    .flatMap((event) => (event.type === "text.delta" ? [event.data.delta] : []))
    .join("");
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: the kb_search host tool`, () => {
  it(
    "两轮检索: two kb_search steps with kb.hits on their stepId, two retrievals, and tool messages without details",
    CASE,
    async () => {
      const { world, fake, kbId, session } = await openKbWorld();

      await promptAppTurn(world, session, `WORKBUDDY_KB_SEARCH:${kbId} 工单超时`);

      // The marker only answers when `tools` names kb_search: check the shape before anything else.
      expect(toolNames(world.bodies[0]), "the first request's tools").toContain("kb_search");
      expect(world.bodies).toHaveLength(3);

      const events = publishedOf(world, session);
      const steps = kbStepEvents(events);
      expect(steps.map((event) => event.type)).toEqual(TWO_KB_STEPS);
      expect(events.filter((event) => event.type === "step.start")).toHaveLength(2);
      for (const at of [0, 3]) {
        const [begun, hits, ended] = steps.slice(at, at + 3);
        expect(hits?.data.stepId).toBe(begun?.data.stepId);
        expect(ended).toMatchObject({ data: { status: "done" } });
      }
      const intents = steps.flatMap((event) =>
        event.type === "kb.hits" ? [event.data.intent] : [],
      );
      expect(intents).toEqual(["第 1 轮", "第 2 轮"]);
      expect(events.filter((event) => event.type === "approval.request")).toEqual([]);
      expect(world.denied).toEqual([]);
      expectDone(events);
      expect(answerText(events)).toBe(ANSWER);

      expect(retrievals(fake)).toEqual(["工单超时", "工单超时 详细说明"]);

      const text = hitText(kbId);
      const second = toolMessages(world.bodies[1]);
      const third = toolMessages(world.bodies[2]);
      expect([second.length, third.length]).toEqual([1, 2]);
      for (const tool of [...second, ...third]) {
        expect(tool.name).toBe("kb_search");
        expect(tool.text).toBe(text);
        const whole = JSON.stringify(tool.message);
        for (const leak of LEAKS) {
          expect(whole).not.toContain(leak);
        }
      }

      expect(world.log.filter((record) => record.event === "kb_hits_invalid")).toEqual([]);
      expect(world.faults).toEqual([]);
    },
  );

  it(
    "换模型后仍可检索: after PATCH modelId the next turn still offers kb_search on the new model, in the same process",
    CASE,
    async () => {
      const { world, kbId, session } = await openKbWorld();
      await promptAppTurn(world, session, `WORKBUDDY_KB_SEARCH:${kbId} 工单超时`);
      await patch(world, session, { modelId: PROXIED_MODELS[1] });
      const bodiesFrom = world.bodies.length;
      const eventsFrom = publishedOf(world, session).length;
      const framesFrom = world.frames.length;

      await promptAppTurn(world, session, `WORKBUDDY_KB_SEARCH:${kbId} 超时后升级给谁`);

      const first = world.bodies[bodiesFrom] as { model?: unknown } | undefined;
      expect(toolNames(first), "the second turn's first request's tools").toContain("kb_search");
      expect(first?.model).toBe(PROXIED_MODELS[1]);
      const later = publishedOf(world, session).slice(eventsFrom);
      expect(later.filter(isKbStart).length).toBeGreaterThan(0);
      expectDone(later);
      expect(world.frames.slice(framesFrom).filter(isReady)).toEqual([]);
      expect(world.frames.slice(framesFrom).filter(isRegistered)).toEqual([]);
      expectOneGeneration(world);
    },
  );

  it(
    "regenerate 之后仍可检索: the same process branches and the new turn still offers and calls kb_search",
    CASE,
    async () => {
      const { world, fake, kbId, session } = await openKbWorld();
      await promptAppTurn(world, session, `WORKBUDDY_KB_SEARCH:${kbId} 工单超时`);
      const bodiesFrom = world.bodies.length;
      const eventsFrom = publishedOf(world, session).length;
      const framesFrom = world.frames.length;

      await regenerateAppTurn(world, session);

      // No set_model / set_host_tools before the branch: the generation's record is unchanged.
      expect(answered(world.frames.slice(framesFrom))).toEqual([
        "get_branch_messages",
        "branch",
        "get_state",
        "prompt",
      ]);
      const later = world.bodies.slice(bodiesFrom);
      expect(later.map(kbToolCount)).toEqual([1, 1, 1]);
      const events = publishedOf(world, session).slice(eventsFrom);
      expect(kbStepEvents(events).map((event) => event.type)).toEqual(TWO_KB_STEPS);
      expectDone(events);
      expect(retrievals(fake).slice(2)).toEqual(["工单超时", "工单超时 详细说明"]);
      expectOneGeneration(world);
    },
  );

  it(
    "fork 之后仍可检索: the temporary process never registers, the forked session's generation registers once",
    CASE,
    async () => {
      const { world, fake, kbId, session } = await openKbWorld();
      await promptAppTurn(world, session, `WORKBUDDY_KB_SEARCH:${kbId} 工单超时`);
      await promptAppTurn(world, session, `WORKBUDDY_KB_SEARCH:${kbId} 超时后升级给谁`);
      const forkFrom = world.frames.length;
      const response = await world.app.inject({
        method: "POST",
        url: `/api/sessions/${session}/fork`,
        headers: { cookie: world.cookie, "content-type": "application/json" },
        payload: JSON.stringify({ messageId: userIds(world, session)[1] }),
      });
      expect(response.statusCode).toBe(201);
      const forked = (response.json() as { session: { id: string } }).session.id;
      const framesFrom = world.frames.length;
      const bodiesFrom = world.bodies.length;
      const forkWindow = world.frames.slice(forkFrom, framesFrom);
      expect(forkWindow.filter(isReady)).toHaveLength(1);
      expect(answered(forkWindow)).toEqual([
        "negotiate_protocol",
        "get_state",
        "get_branch_messages",
        "branch",
        "get_state",
      ]);

      await promptAppTurn(world, forked, `WORKBUDDY_KB_SEARCH:${kbId} 分叉后再问`);

      const after = world.frames.slice(framesFrom);
      expect(after.filter(isReady)).toHaveLength(1);
      expect(after.filter(isRegistered).map((frame) => [frame.success, frame.data])).toEqual([
        [true, { toolNames: ["kb_search"] }],
      ]);
      expect(world.bodies.slice(bodiesFrom).map(kbToolCount)).toEqual([1, 1, 1]);
      const events = publishedOf(world, forked);
      expect(events.filter((event) => event.type === "kb.hits")).toHaveLength(2);
      expectDone(events);
      expect(retrievals(fake).slice(4)).toEqual(["分叉后再问", "分叉后再问 详细说明"]);
      expect(world.denied).toEqual([]);
      expect(world.faults).toEqual([]);
    },
  );

  it(
    "撤下全部 host tool: after the only base is deleted the same process answers set_host_tools [] with toolNames []",
    CASE,
    async () => {
      const { world, kbId, session } = await openKbWorld();
      await promptAppTurn(world, session, `WORKBUDDY_KB_SEARCH:${kbId} 工单超时`);
      const removed = await world.app.inject({
        method: "DELETE",
        url: `/api/kb/bases/${kbId}`,
        headers: { cookie: world.cookie },
      });
      expect(removed.statusCode).toBe(204);
      const framesFrom = world.frames.length;
      const bodiesFrom = world.bodies.length;
      const eventsFrom = publishedOf(world, session).length;

      await promptAppTurn(world, session, "你好");

      const registered = world.frames.slice(framesFrom).filter(isRegistered);
      expect(registered.map((frame) => [frame.success, frame.data])).toEqual([
        [true, { toolNames: [] }],
      ]);
      expect(world.bodies.slice(bodiesFrom).map(kbToolCount)).toEqual([0]);
      const events = publishedOf(world, session).slice(eventsFrom);
      expect(events.filter(isKbStart)).toEqual([]);
      expectDone(events);
      expect(world.frames.filter(isReady)).toHaveLength(1);
      expect(world.faults).toEqual([]);
    },
  );

  it(
    "always-ask 下拒绝: each Deny ends its kb_search step without a host_tool_call, kb.hits or retrieval",
    CASE,
    async () => {
      const { world, fake, kbId, session } = await openKbWorld("always-ask");

      await promptAppTurn(world, session, `WORKBUDDY_KB_SEARCH:${kbId} 工单超时`);

      // Per call: tool_execution_start → the select → (Deny) → tool_execution_end; the fake
      // upstream counts the denied tool message as a round, so the second call is denied too.
      const calls = world.frames.filter(
        (frame) =>
          frame.type === "tool_execution_start" ||
          frame.type === "tool_execution_end" ||
          isHostCall(frame) ||
          isSelect(frame),
      );
      expect(calls.map((frame) => frame.type)).toEqual([
        "tool_execution_start",
        "extension_ui_request",
        "tool_execution_end",
        "tool_execution_start",
        "extension_ui_request",
        "tool_execution_end",
      ]);
      for (const ended of calls.filter((frame) => frame.type === "tool_execution_end")) {
        expect(ended).toMatchObject({
          toolName: "kb_search",
          result: { content: [{ type: "text", text: DENIED }], details: {} },
          isError: true,
        });
      }
      const events = publishedOf(world, session);
      const approvals = events.filter((event) => event.type === "approval.request");
      expect(approvals.map((event) => [event.data.tool, event.data.title])).toEqual([
        ["kb_search", "Allow tool: kb_search"],
        ["kb_search", "Allow tool: kb_search"],
      ]);
      expect(world.denied).toHaveLength(2);
      const steps = kbStepEvents(events);
      expect(
        steps.map((event) => [event.type, event.type === "step.end" ? event.data : null]),
      ).toEqual([
        ["step.start", null],
        ["step.end", expect.objectContaining({ status: "failed", output: DENIED })],
        ["step.start", null],
        ["step.end", expect.objectContaining({ status: "failed", output: DENIED })],
      ]);
      expectDone(events);
      expect(answerText(events)).toBe(ANSWER);
      expectNoRetrieval(world, fake);
      expect(world.bodies).toHaveLength(3);
      expect(toolMessages(world.bodies[1]).map(({ name, text }) => [name, text])).toEqual([
        ["kb_search", DENIED],
      ]);
      expect(toolMessages(world.bodies[2]).map(({ text }) => text)).toEqual([DENIED, DENIED]);
      expect(world.log.filter((record) => record.event === "kb_hits_invalid")).toEqual([]);
    },
  );

  it(
    "项目层同名工具: a workspace .omp/tools/kb_search makes omp refuse set_host_tools, so every prompt fails before any upstream request",
    CASE,
    async () => {
      const { world, fake, kbId, session } = await openKbWorld();
      writeProjectTool(world, session, false);
      const conflict = 'RPC host tool "kb_search" conflicts with an existing tool';

      for (const round of [1, 2]) {
        const response = await postPrompt(world, session, `WORKBUDDY_KB_SEARCH:${kbId} 工单超时`);
        expect(response.statusCode, `prompt ${String(round)}`).toBe(502);
        expect(response.json()).toMatchObject({ error: { code: "agent_unavailable" } });
        // The refused generation is retired: each prompt spawns, registers and is refused anew.
        expect(world.frames.filter(isReady)).toHaveLength(round);
        expect(
          world.frames.filter(isRegistered).map((frame) => [frame.success, frame.error]),
        ).toEqual(Array.from({ length: round }, () => [false, conflict]));
        expect(answered(world.frames).at(-1)).toBe("set_host_tools");
      }
      expect(world.bodies).toEqual([]);
      expectNoRetrieval(world, fake);
    },
  );

  it(
    "项目层同名工具, owner without a base: no registration, the project kb_search runs on write without reaching the owner",
    CASE,
    async () => {
      const { world, fake, kbId, session } = await openKbWorld();
      world.db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(kbId);
      writeProjectTool(world, session, true);

      await promptAppTurn(world, session, `WORKBUDDY_KB_SEARCH:${kbId} 工单超时`);

      expect(world.frames.filter(isRegistered)).toEqual([]);
      expect(world.bodies.map(kbToolCount)).toEqual([1, 1, 1]);
      expect(world.frames.filter(isSelect).map((frame) => frame.title)).toEqual([
        "Allow tool: kb_search",
        "Allow tool: kb_search",
      ]);
      const events = publishedOf(world, session);
      expect(events.filter((event) => event.type === "approval.request")).toEqual([]);
      expect(world.denied).toEqual([]);
      expect(toolMessages(world.bodies[1]).map(({ name, text }) => [name, text])).toEqual([
        ["kb_search", PROJECT_TEXT],
      ]);
      const ends = events.filter((event) => event.type === "step.end");
      expect(ends.map((event) => [event.data.status, event.data.output])).toEqual([
        ["done", PROJECT_TEXT],
        ["done", PROJECT_TEXT],
      ]);
      expect(events.filter((event) => event.type === "kb.hits")).toEqual([]);
      expectDone(events);
      expectNoRetrieval(world, fake);
    },
  );
});
