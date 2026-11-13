/**
 * Change s2c-kb-session 5.2 (#1967) chat-stream「检索结果事件发布」: the supervisor validates the
 * reducer's kb.hits before anything else, maps its `stepId` to the persisted step id, publishes it with
 * one ring sequence and writes nothing; an invalid one is dropped with one `kb_hits_invalid` record
 * that carries no chunk text.
 *
 * Publication worlds are the production createApp → registerSessions assembly over real fake-omp
 * `host-tool` children (two `kb_search` calls per turn, intents `第 1 轮` / `第 2 轮`), a stub definition
 * source handed in through the assembly seam, in-memory SQLite and the injected clock; the session is
 * pinned to `yolo` (under `always-ask` an approval.request sits between step.start and kb.hits).
 * Oracles: the SSE bytes, the ring replay, the REST snapshot, SQLite rows, the injected `log` and
 * `process.stderr`. The validator and the unmatched-step drop are pinned at their pure seams.
 * Expected values are the spec's literals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PumpSteps } from "../src/sessions/approval-pairing.js";
import type { ChatEvent } from "../src/sessions/events.js";
import { admitKbHits, checkKbHits } from "../src/sessions/kb-hits.js";
import type { HostToolResult } from "../src/sessions/omp/host-tools.js";
import type { SpawnLog } from "../src/sessions/omp/spawn-gate.js";
import type { SessionStore } from "../src/sessions/store.js";
import { persistEvent } from "../src/sessions/turn-control.js";
import { parseSse, REAL, type SseFrame, seqOf } from "./session-approval-helpers.js";
import { patch } from "./session-archive-helpers.js";
import { forkWorlds } from "./session-fork-helpers.js";
import {
  epochOf,
  openRegenWorld,
  type RegenWorld,
  sendPrompt,
  stubSearch,
} from "./session-regenerate-helpers.js";
import { getSessionMessages } from "./session-rest-helpers.js";
import { openEventStream, readUntil } from "./session-sse-helpers.js";
import { assistantIdFor, waitForTurn } from "./session-supervisor-helpers.js";

const worlds = forkWorlds();

afterEach(() => {
  vi.restoreAllMocks();
});

const CHUNK = "Snt1nelChunk1967";
const INVALID_CHUNK = "Inv4lidChunk1967Only";
const QUESTION = "工单超时规则是什么";
const SIMILARITIES = [0.91, 0.82, 0.73, 0.64, 0.55, 0.46];
const HITS = SIMILARITIES.map((similarity, index) => ({
  documentId: `d${String(index + 1)}`,
  name: `规则${String(index + 1)}.md`,
  similarity,
  content: `第 ${String(index + 1)} 段 ${CHUNK}`,
}));
const BASES = [
  { kbId: "k1", name: "产品文档", status: "ok", hits: HITS },
  { kbId: "kGone", name: null, status: "not_found", hits: [] },
  { kbId: "k3", name: "运维手册", status: "failed", hits: [] },
];
const TEXT = "检索到 6 条切片";
const WITH_BASES: HostToolResult = { text: TEXT, details: { bases: BASES }, isError: false };
const PLAIN_TEXT: HostToolResult = { text: TEXT, isError: false };
const INVALID: HostToolResult = {
  text: TEXT,
  details: {
    bases: [
      {
        kbId: "k1",
        name: "x",
        status: "ok",
        hits: [{ documentId: "d", name: "n", similarity: "0.8", content: INVALID_CHUNK }],
      },
    ],
  },
  isError: false,
};

interface Turn {
  world: RegenWorld;
  assistant: number;
  frames: SseFrame[];
  records: unknown[];
}

/** One yolo `host-tool` turn whose two executions answer `answers`, read back over SSE from seq 0. */
async function runTurn(answers: readonly HostToolResult[]): Promise<Turn> {
  const records: unknown[] = [];
  const log: SpawnLog = (record) => {
    records.push(record);
  };
  const stub = stubSearch([{ id: "k1", name: "产品文档" }], answers);
  const world = worlds.track(
    await openRegenWorld({ scenario: "host-tool", assembly: { sessionSearch: stub.source, log } }),
  );
  expect((await patch(world, { approvalMode: "yolo" })).statusCode).toBe(200);
  expect((await sendPrompt(world, QUESTION)).statusCode).toBe(202);
  await waitForTurn(world.fixture, world.session, "done");
  expect(stub.executed).toHaveLength(2);
  const epoch = epochOf(world.fixture.db, world.session);
  const stream = await openEventStream(world.fixture, world.session, world.cookie, `${epoch}:0`);
  const text = await readUntil(stream, (bytes) => bytes.includes("event: turn.end"));
  stream.abort();
  return {
    world,
    assistant: assistantIdFor(world.fixture, world.session),
    frames: parseSse(text),
    records,
  };
}

/** Every row of the session's messages and steps, without ids, foreign keys and timestamps. */
function storedRows(world: RegenWorld): unknown[] {
  const strip = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !/(^id|_id|_at)$/u.test(key)));
  const { db } = world.fixture;
  const messages = db
    .prepare("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id")
    .all(world.session) as Array<Record<string, unknown>>;
  const steps = db
    .prepare(
      "SELECT s.* FROM chat_steps s JOIN chat_messages m ON m.id = s.message_id " +
        "WHERE m.session_id = ? ORDER BY s.message_id, s.ordinal",
    )
    .all(world.session) as Array<Record<string, unknown>>;
  return [...messages.map(strip), ...steps.map(strip)];
}

async function snapshotText(world: RegenWorld): Promise<string> {
  const response = await getSessionMessages(world.fixture.app, world.session, world.cookie);
  expect(response.statusCode).toBe(200);
  return response.body;
}

function framesOf(frames: readonly SseFrame[], event: string): SseFrame[] {
  return frames.filter((frame) => frame.event === event);
}

describe("检索结果事件发布：发布但不落库", () => {
  it(
    "each call publishes step.start, kb.hits, step.end on consecutive ids; the rows equal a turn without kb.hits",
    REAL,
    async () => {
      const turn = await runTurn([WITH_BASES]);
      const starts = framesOf(turn.frames, "step.start");
      expect(starts).toHaveLength(2);
      for (const [index, start] of starts.entries()) {
        const n = seqOf(start);
        const [hits, end] = [n + 1, n + 2].map((seq) =>
          turn.frames.find((frame) => seqOf(frame) === seq),
        );
        expect([hits?.event, end?.event]).toEqual(["kb.hits", "step.end"]);
        const stepId = start.data.stepId;
        expect(Number.isSafeInteger(stepId)).toBe(true);
        expect(hits?.data).toEqual({
          messageId: turn.assistant,
          stepId,
          intent: `第 ${String(index + 1)} 轮`,
          bases: BASES,
        });
        expect(end?.data.stepId).toBe(stepId);
      }
      expect(seqOf(starts[1])).toBe(seqOf(starts[0]) + 3);
      expect(framesOf(turn.frames, "kb.hits")).toHaveLength(2);
      expect(turn.records).toEqual([]);

      const control = await runTurn([PLAIN_TEXT]);
      expect(framesOf(control.frames, "kb.hits")).toEqual([]);
      expect(framesOf(control.frames, "step.start")).toHaveLength(2);
      expect(storedRows(turn.world)).toEqual(storedRows(control.world));
      expect(storedRows(turn.world)).toHaveLength(4);
    },
  );
});

describe("检索结果事件发布：回放与快照", () => {
  it(
    "a reconnect after the first step.start replays both kb.hits; the full snapshot holds no hit data",
    REAL,
    async () => {
      const turn = await runTurn([WITH_BASES]);
      const [first] = framesOf(turn.frames, "step.start");
      const replayed = turn.world.fixture.supervisor.subscribe(
        turn.world.session,
        String(first?.id),
        () => {},
      );
      expect(replayed.mode).toBe("replay");
      expect(replayed.replay.filter((event) => event.type === "kb.hits")).toHaveLength(2);
      replayed.unsubscribe();

      const snapshot = await snapshotText(turn.world);
      expect(snapshot).not.toContain(CHUNK);
      expect(snapshot).not.toContain('"bases"');
      const steps = JSON.parse(snapshot).messages[1].steps as Array<{ name: string }>;
      expect(steps.map((step) => step.name)).toEqual(["kb_search", "kb_search"]);
    },
  );
});

describe("检索结果事件发布：不合规即丢弃", () => {
  it(
    "a string similarity drops kb.hits, step.end goes on, and one kb_hits_invalid record carries no chunk",
    REAL,
    async () => {
      const written: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      vi.spyOn(process.stderr, "write").mockImplementation((chunk, ...rest) => {
        written.push(String(chunk));
        return write(chunk, ...(rest as []));
      });
      const turn = await runTurn([INVALID, PLAIN_TEXT]);
      expect(framesOf(turn.frames, "kb.hits")).toEqual([]);
      expect(framesOf(turn.frames, "step.end").map((frame) => frame.data.status)).toEqual([
        "done",
        "done",
      ]);
      expect(turn.records).toEqual([{ event: "kb_hits_invalid", messageId: turn.assistant }]);
      expect(JSON.stringify(turn.records)).not.toContain(INVALID_CHUNK);
      expect(written.join("")).not.toContain(INVALID_CHUNK);
    },
  );
});

/** A valid base literal with one hit; cases below break exactly one rule of it. */
function base(patchBase: Record<string, unknown> = {}): Record<string, unknown> {
  const hit = { documentId: "d", name: "n", similarity: 0.5, content: "c" };
  return { kbId: "k1", name: "库", status: "ok", hits: [hit], ...patchBase };
}

function hit(patchHit: Record<string, unknown>): Record<string, unknown> {
  return base({
    hits: [{ documentId: "d", name: "n", similarity: 0.5, content: "c", ...patchHit }],
  });
}

function sparse(value: unknown): unknown[] {
  const holes: unknown[] = [];
  holes[1] = value;
  return holes;
}

describe("检索结果事件发布：校验器正反例", () => {
  it("accepts the spec shapes and returns new objects in the fixed key order", () => {
    expect(checkKbHits("第 1 轮", BASES)).toEqual({ intent: "第 1 轮", bases: BASES });
    const five = ["a", "b", "c", "d", "e"].map((kbId) => base({ kbId }));
    expect(checkKbHits(null, five)?.bases).toHaveLength(5);
    const notReady = { kbId: "k2", name: "新库", status: "not_ready", hits: [] };
    expect(checkKbHits(null, [notReady])).toEqual({ intent: null, bases: [notReady] });
    expect(checkKbHits(null, [base({ hits: [] })])?.bases).toEqual([base({ hits: [] })]);
    const shuffled = [
      { hits: [{ content: "c", similarity: 0, name: "n", documentId: "d" }], status: "ok" },
    ];
    Object.assign(shuffled[0] as object, { name: "库", kbId: "k1" });
    const checked = checkKbHits(null, shuffled);
    expect(JSON.stringify(checked?.bases)).toBe(
      '[{"kbId":"k1","name":"库","status":"ok","hits":[{"documentId":"d","name":"n","similarity":0,"content":"c"}]}]',
    );
    expect(checked?.bases[0]).not.toBe(shuffled[0]);
  });

  const six = ["a", "b", "c", "d", "e", "f"].map((kbId) => base({ kbId }));
  const sevenHits = base({ hits: Array.from({ length: 7 }, () => (hit({}).hits as unknown[])[0]) });
  const missingHits = base();
  delete missingHits.hits;
  const inherited = Object.create(base()) as Record<string, unknown>;
  const cases: Array<[string, unknown, unknown]> = [
    ["0 库", null, []],
    ["6 库", null, six],
    ["bases 不是数组", null, { 0: base() }],
    ["空 kbId", null, [base({ kbId: "" })]],
    ["kbId 不是字符串", null, [base({ kbId: 7 })]],
    ["未知 status", null, [base({ status: "pending" })]],
    ["ok 配 null 名", null, [base({ name: null })]],
    ["not_found 配非 null 名", null, [base({ status: "not_found", name: "x", hits: [] })]],
    ["空名", null, [base({ name: "" })]],
    ["名不是字符串", null, [base({ name: 7 })]],
    ["7 条命中", null, [sevenHits]],
    ["非 ok 带命中", null, [base({ status: "failed" })]],
    ["hits 不是数组", null, [base({ hits: null })]],
    ["库多键", null, [base({ extra: 1 })]],
    ["库少键", null, [missingHits]],
    ["库的键只在原型上", null, [inherited]],
    ["库不是普通对象", null, [["k1"]]],
    ["命中多键", null, [hit({ extra: 1 })]],
    ["命中少键", null, [base({ hits: [{ documentId: "d", name: "n", similarity: 0.5 }] })]],
    ["similarity 为 NaN", null, [hit({ similarity: Number.NaN })]],
    ["similarity 为 Infinity", null, [hit({ similarity: Number.POSITIVE_INFINITY })]],
    ["similarity 为字符串", null, [hit({ similarity: "0.8" })]],
    ["content 不是字符串", null, [hit({ content: 7 })]],
    ["documentId 不是字符串", null, [hit({ documentId: 7 })]],
    ["命中名不是字符串", null, [hit({ name: null })]],
    ["bases 稀疏数组", null, sparse(base())],
    ["hits 稀疏数组", null, [base({ hits: sparse((hit({}).hits as unknown[])[0]) })]],
    ["intent 为空串", "", [base()]],
    ["intent 不是字符串", 7, [base()]],
    ["intent 缺失", undefined, [base()]],
  ];
  it.each(cases)("rejects %s", (_label, intent, bases) => {
    expect(checkKbHits(intent, bases)).toBeUndefined();
  });
});

function rawHits(bases: unknown, intent: string | null = "第 1 轮"): ChatEvent<string> {
  return { type: "kb.hits", data: { messageId: 1967, stepId: "c1", intent, bases } };
}

function recordingLog(): { log: SpawnLog; records: unknown[] } {
  const records: unknown[] = [];
  return { log: (record) => void records.push(record), records };
}

describe("admitKbHits is the supervisor's gate before routing", () => {
  it("passes every other event through untouched and records nothing", () => {
    const { log, records } = recordingLog();
    const start: ChatEvent<string> = { type: "turn.retry", data: { messageId: 1967 } };
    expect(admitKbHits(log, start)).toBe(start);
    expect(records).toEqual([]);
  });

  it("an invalid one is dropped with exactly the two-key record, a failing log changes nothing", () => {
    const { log, records } = recordingLog();
    const bad = rawHits([hit({ similarity: "0.8", content: INVALID_CHUNK })]);
    expect(admitKbHits(log, bad)).toBeUndefined();
    expect(records).toEqual([{ event: "kb_hits_invalid", messageId: 1967 }]);
    expect(Object.keys(records[0] as object)).toEqual(["event", "messageId"]);
    const throwing: SpawnLog = () => {
      throw new Error("log sink down");
    };
    const rejecting = (() => Promise.reject(new Error("async sink"))) as unknown as SpawnLog;
    for (const failing of [throwing, rejecting]) {
      expect(admitKbHits(failing, bad)).toBeUndefined();
    }
  });
});

describe("persistEvent maps kb.hits to the stored step and writes nothing", () => {
  it("an unregistered call drops it, a registered one returns the numeric stepId; no store call, no record", () => {
    const calls: string[] = [];
    const store = new Proxy(
      {},
      {
        get: (_target, key) => () => {
          calls.push(String(key));
        },
      },
    ) as unknown as SessionStore;
    const { log, records } = recordingLog();
    const admitted = admitKbHits(log, rawHits(BASES));
    if (admitted === undefined) {
      throw new Error("valid kb.hits was not admitted");
    }
    const steps = new PumpSteps(1967);
    const persist = () => persistEvent(store, 1967, admitted, steps, [], null, (text) => text);
    expect(persist()).toBeUndefined();
    steps.started("c1", 42, "kb_search", null);
    expect(persist()).toEqual({
      type: "kb.hits",
      data: { messageId: 1967, stepId: 42, intent: "第 1 轮", bases: BASES },
    });
    expect(calls).toEqual([]);
    expect(records).toEqual([]);
  });
});
