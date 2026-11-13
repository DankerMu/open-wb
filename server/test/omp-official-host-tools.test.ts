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
 * Run locally (`OMP_BIN` absolute):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-host-tools.test.ts --coverage=false
 */
import { describe, expect, it } from "vitest";
import type { KbDependencies } from "../src/kb/index.js";
import { resourceName } from "../src/kb/pipeline.js";
import { createKbStore } from "../src/kb/store.js";
import type { ChatEvent } from "../src/sessions/events.js";
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
} from "./support/omp-official-proxied.js";

const CASE = { timeout: 400_000 };
const RAGFLOW_KEY = "wb-issue1975-ragflow-key";
const UPSTREAM_KEY = "wb-issue1975-upstream-key";
const RETRIEVAL = "POST /api/v1/retrieval";
const HIT = "工单超过 48 小时未响应自动升级。";
const ANSWER = "已根据知识库检索结果作答。";
/** `details` keys and hit fields that must not reach the model. */
const LEAKS = ["details", "bases", "documentId", "similarity", "hits"];

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

/** zhangsan's ready 「规范库」 with 规格.md and one scripted hit; a fresh session on `write`. */
async function openKbWorld(): Promise<KbWorld> {
  const fake = await start({ apiKey: RAGFLOW_KEY });
  onTeardown(() => fake.close());
  const kb: KbDependencies = {
    key: { read: () => RAGFLOW_KEY },
    baseUrl: fake.baseUrl,
    uploadMaxBytes: 1024 * 1024,
    uploadMaxFiles: 10,
    log: () => undefined,
  };
  const world = await openProxiedApp({
    registry: { apiKey: UPSTREAM_KEY },
    kb,
    recordBodies: true,
  });
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
  await patch(world, session, { approvalMode: "write" });
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
      expect(steps.map((event) => event.type)).toEqual([
        "step.start",
        "kb.hits",
        "step.end",
        "step.start",
        "kb.hits",
        "step.end",
      ]);
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
      expect(events.at(-1)).toMatchObject({ type: "turn.end", data: { status: "done" } });
      expect(answerText(events)).toBe(ANSWER);

      const retrievals = fake
        .requests()
        .filter((entry) => `${entry.method} ${entry.path}` === RETRIEVAL);
      expect(retrievals.map(({ json }) => (json as { question?: unknown }).question)).toEqual([
        "工单超时",
        "工单超时 详细说明",
      ]);

      const text = [
        `知识库「规范库」（${kbId}）：命中 1 条`,
        "[1] 规格.md（相似度 0.9000）",
        HIT,
      ].join("\n");
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
      expect(later.at(-1)).toMatchObject({ type: "turn.end", data: { status: "done" } });
      const isReady = (frame: { type?: unknown }) => frame.type === "ready";
      const isRegistered = (frame: { type?: unknown; command?: unknown }) =>
        frame.type === "response" && frame.command === "set_host_tools";
      expect(world.frames.slice(framesFrom).filter(isReady)).toEqual([]);
      expect(world.frames.slice(framesFrom).filter(isRegistered)).toEqual([]);
      expect(world.frames.filter(isReady)).toHaveLength(1);
      expect(world.frames.filter(isRegistered)).toHaveLength(1);
      expect(world.faults).toEqual([]);
    },
  );
});
