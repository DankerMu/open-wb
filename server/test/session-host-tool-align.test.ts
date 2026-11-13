/**
 * Change s2c-kb-session 4.3 (#1966): omp-runtime「`kb_search` 的注册」 and chat-sessions「派发前按会话设置对齐进程」
 * step 3 (宿主工具) — every scenario of the former plus the latter's two frame-order scenarios — and 4.5's
 * assembly: with the knowledge base on, `createApp` hands sessions the kb module's session search.
 *
 * Every world is the production createApp → registerSessions assembly over real fake-omp children
 * (`host-tool` unless a case says otherwise: it answers `set_host_tools` and, since 4.2, the branch
 * commands), a real in-memory SQLite and the injected clock, driven over REST. The definition source
 * is a stub handed in through the assembly seam, except「只以所有者执行」and the assembly case, which run
 * the real kb module against the fake RAGFlow. Oracles: each child's stdin frames (the fake's inbound
 * record is out of reach: `host-tool` takes over every prompt), the spawn argv, SQLite rows and the
 * fake RAGFlow's request log; never supervisor internals. Expected values are the specs' literals.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resourceName } from "../src/kb/pipeline.js";
import { createKbStore } from "../src/kb/store.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { AgentUnavailableError } from "../src/sessions/omp/process.js";
import type { Slot } from "../src/sessions/pool.js";
import { REAL, spawnedAt } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { PRINCIPAL_ZHAOLIU } from "./session-db-helpers.js";
import { forkAt, forkWorlds, messagesOf } from "./session-fork-helpers.js";
import { THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import {
  answered,
  openRegenWorld,
  type RegenWorld,
  reclaimed,
  sendPrompt,
  sessionFile,
  snapshot,
  types,
  waitDead,
} from "./session-regenerate-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE, cookieFor, postPrompt } from "./session-rest-helpers.js";
import { createSession, resumePath, waitFor, waitForTurn } from "./session-supervisor-helpers.js";
import { postUndo, seededSession, undone } from "./session-undo-helpers.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";

const worlds = forkWorlds();
const fakes: FakeRagflowServer[] = [];

afterEach(async () => {
  for (const fake of fakes.splice(0)) {
    await fake.close();
  }
});

/** The session's effective model does not reason: no `set_thinking_level` (omp-runtime's note). */
const PLAIN = {
  models: THREE_MODEL_CATALOG.models.filter((model) => model.id === "m2"),
  defaultModelId: "m2",
};
const FIRST_DISPATCH = ["negotiate_protocol", "get_state", "set_model", "set_host_tools", "prompt"];
const STUB_TEXT = "stub-search-result";
const RAGFLOW_KEY = "wb-issue1966-ragflow-key";
const RETRIEVAL = "POST /api/v1/retrieval";
const SENTINEL = "Snt1nelChunk1966";

interface Base {
  id: string;
  name: string;
}

/** A stub definition source: one mutable list of bases for every owner, each `execute` recorded. */
function stubSearch(initial: Base[]) {
  const bases = [...initial];
  const executed: Array<{ ownerId: string; args: unknown }> = [];
  const source = {
    definitionFor: (_ownerId: string) =>
      bases.length === 0
        ? null
        : {
            tool: {
              name: "kb_search",
              label: "知识库检索",
              description: [
                "检索知识库。",
                ...bases.map(({ id, name }) => `- ${name}（${id}）`),
              ].join("\n"),
              parameters: { type: "object" },
              loadMode: "essential",
            },
            bases: bases.map((base) => ({ ...base })),
          },
    execute: (ownerId: string, args: unknown) => {
      executed.push({ ownerId, args });
      return Promise.resolve({ text: STUB_TEXT, isError: false });
    },
  };
  return { source, bases, executed };
}

type Stub = ReturnType<typeof stubSearch>;

function openStubWorld(stub: Stub | undefined, scenario = "host-tool", plain = true) {
  return openRegenWorld({
    scenario,
    assembly: {
      ...(plain ? { modelCatalog: PLAIN } : {}),
      ...(stub === undefined ? {} : { sessionSearch: stub.source }),
    },
  });
}

/** The frames up to and including the first `prompt`: `host-tool` keeps answering after it. */
function untilPrompt(frames: readonly OmpFrame[]): OmpFrame[] {
  const at = frames.findIndex((frame) => frame.type === "prompt");
  return at === -1 ? [...frames] : frames.slice(0, at + 1);
}

function ofType(frames: readonly OmpFrame[], type: string): OmpFrame[] {
  return frames.filter((frame) => frame.type === type);
}

function toolsOf(frame: OmpFrame | undefined): Array<Record<string, unknown>> {
  return (frame?.tools ?? []) as Array<Record<string, unknown>>;
}

/** Each `host_tool_result` a child received: its text and whether it carried `isError:true`. */
function results(frames: readonly OmpFrame[]): Array<[string, boolean]> {
  return ofType(frames, "host_tool_result").map((frame) => {
    const result = frame.result as { content: Array<{ text: string }> };
    return [String(result.content[0]?.text), frame.isError === true];
  });
}

function regenerate(world: RegenWorld) {
  return postSessionAction(world.fixture.app, "regenerate", world.session, world.cookie);
}

describe("kb_search 的注册 (omp-runtime)", () => {
  it(
    "首次派发前注册：set_model 之后、prompt 之前恰一帧 set_host_tools，定义恰一项 essential 的 kb_search",
    REAL,
    async () => {
      const stub = stubSearch([{ id: "k1", name: "产品文档" }]);
      const world = worlds.track(await openStubWorld(stub));

      await answered(world);

      const { stdin } = spawnedAt(world, 0);
      expect(types(untilPrompt(stdin))).toEqual(FIRST_DISPATCH);
      const [registration] = ofType(stdin, "set_host_tools");
      expect(toolsOf(registration)).toHaveLength(1);
      expect(toolsOf(registration)[0]).toMatchObject({ name: "kb_search", loadMode: "essential" });
      // The slot's handler runs the source as the session's owner (zhangsan, u1) for both calls.
      expect(stub.executed.map(({ ownerId }) => ownerId)).toEqual(["u1", "u1"]);
      expect(results(stdin)).toEqual([
        [STUB_TEXT, false],
        [STUB_TEXT, false],
      ]);
      expect(world.errors).toEqual([]);
    },
  );

  it("不注册：知识库关闭时入站帧没有 set_host_tools", REAL, async () => {
    const world = worlds.track(await openStubWorld(undefined));

    await answered(world);
    await answered(world);

    const { stdin } = spawnedAt(world, 0);
    expect(types(untilPrompt(stdin))).toEqual([
      "negotiate_protocol",
      "get_state",
      "set_model",
      "prompt",
    ]);
    expect(ofType(stdin, "set_host_tools")).toEqual([]);
    expect(results(stdin).map(([text]) => text)).toEqual([
      "未知工具",
      "未知工具",
      "未知工具",
      "未知工具",
    ]);
  });

  it("不注册：所有者没有库时不发 set_host_tools；建库之后的下一次派发才发", REAL, async () => {
    const stub = stubSearch([]);
    const world = worlds.track(await openStubWorld(stub));

    await answered(world);
    const { stdin } = spawnedAt(world, 0);
    expect(types(untilPrompt(stdin))).toEqual([
      "negotiate_protocol",
      "get_state",
      "set_model",
      "prompt",
    ]);
    expect(ofType(stdin, "set_host_tools")).toEqual([]);

    stub.bases.push({ id: "k1", name: "产品文档" });
    const sent = stdin.length;
    await answered(world);
    expect(types(untilPrompt(stdin.slice(sent)))).toEqual(["set_host_tools", "prompt"]);
    expect(world.rt.calls).toHaveLength(1);
  });

  it(
    "库清单变化后重发：新建一个库重发两库定义，删光重发 tools:[]，再派发不发；全程同一进程",
    REAL,
    async () => {
      const stub = stubSearch([{ id: "k1", name: "产品文档" }]);
      const world = worlds.track(await openStubWorld(stub));
      await answered(world);
      const { stdin } = spawnedAt(world, 0);
      const dispatch = async () => {
        const sent = stdin.length;
        await answered(world);
        return untilPrompt(stdin.slice(sent));
      };

      stub.bases.push({ id: "k2", name: "客服问答" });
      const second = await dispatch();
      expect(types(second)).toEqual(["set_host_tools", "prompt"]);
      const description = String(toolsOf(second[0])[0]?.description);
      expect(description.split("\n").slice(-2)).toEqual(["- 产品文档（k1）", "- 客服问答（k2）"]);

      stub.bases.splice(0);
      const third = await dispatch();
      expect(types(third)).toEqual(["set_host_tools", "prompt"]);
      expect(third[0]?.tools).toEqual([]);

      expect(types(await dispatch())).toEqual(["prompt"]);
      expect(world.rt.calls).toHaveLength(1);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "空闲回收后重新注册：新进程以 --resume 第一回合的会话文件启动，prompt 之前又有一帧 set_host_tools",
    REAL,
    async () => {
      const stub = stubSearch([{ id: "k1", name: "产品文档" }]);
      const world = worlds.track(await openStubWorld(stub));
      await answered(world);
      const file = sessionFile(world.fixture.db, world.session);
      expect(file).not.toBeNull();
      await reclaimed(world, 0);

      await answered(world);

      expect(world.rt.calls).toHaveLength(2);
      expect(resumePath(world.rt.calls[1]?.args ?? [])).toBe(file);
      expect(types(untilPrompt(spawnedAt(world, 1).stdin))).toEqual(FIRST_DISPATCH);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "注册失败：502 agent_unavailable，受理对被补偿，入站帧里没有 prompt，slot 被退役",
    REAL,
    async () => {
      const stub = stubSearch([{ id: "k1", name: "产品文档" }]);
      const world = worlds.track(await openStubWorld(stub, "host-tool-register-fail"));
      const { db, supervisor } = world.fixture;

      const response = await sendPrompt(world);

      expect([response.statusCode, response.json()]).toEqual([502, AGENT_UNAVAILABLE_ENVELOPE]);
      expect(messagesOf(db, world.session)).toEqual([]);
      expect(snapshot(db, world.session).session).toMatchObject({ status: "idle" });
      expect(types(spawnedAt(world, 0).stdin)).toEqual([
        "negotiate_protocol",
        "get_state",
        "set_model",
        "set_host_tools",
      ]);
      await waitDead(world, 0);
      expect(supervisor.liveProcessCount()).toBe(0);
    },
  );

  it(
    "临时进程不注册：会话 slot 注册了，fork 与撤回的临时进程入站帧里都没有 set_host_tools",
    REAL,
    async () => {
      const stub = stubSearch([{ id: "k1", name: "产品文档" }]);
      const world = worlds.track(await openStubWorld(stub));
      await answered(world);
      expect(ofType(spawnedAt(world, 0).stdin, "set_host_tools")).toHaveLength(1);
      const seeded = await seededSession(world);

      await forkAt(world, seeded.u2, seeded.session);
      undone(await postUndo(world, seeded.u2, seeded.session));

      expect(world.rt.calls).toHaveLength(3);
      for (const index of [1, 2]) {
        const sent = types(spawnedAt(world, index).stdin);
        expect(sent).toEqual(expect.arrayContaining(["get_branch_messages", "branch"]));
        expect(sent).not.toContain("set_host_tools");
      }
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "未知工具：注入了定义源的 slot 上 host-tool-parallel 的第三个调用 other 回未知工具，execute 只收到两个 kb_search",
    REAL,
    async () => {
      const stub = stubSearch([{ id: "k1", name: "产品文档" }]);
      const world = worlds.track(await openStubWorld(stub, "host-tool-parallel"));

      await answered(world);

      const byId = new Map(
        ofType(spawnedAt(world, 0).stdin, "host_tool_result").map((frame) => [frame.id, frame]),
      );
      expect(byId.get("h3")).toEqual({
        type: "host_tool_result",
        id: "h3",
        result: { content: [{ type: "text", text: "未知工具" }] },
        isError: true,
      });
      expect([byId.get("h1")?.isError, byId.get("h2")?.isError]).toEqual([undefined, undefined]);
      expect(stub.executed).toHaveLength(2);
    },
  );
});

describe("宿主工具对齐 (chat-sessions「派发前按会话设置对齐进程」)", () => {
  it(
    "在模型命令之后、在 regenerate 事务之前：同一进程上 set_host_tools 先于 get_branch_messages",
    REAL,
    async () => {
      const stub = stubSearch([{ id: "k1", name: "产品文档" }]);
      const world = worlds.track(await openStubWorld(stub, "host-tool", false));
      await answered(world);
      const first = spawnedAt(world, 0);
      expect(types(untilPrompt(first.stdin))).toEqual([
        "negotiate_protocol",
        "get_state",
        "set_model",
        "set_thinking_level",
        "set_host_tools",
        "prompt",
      ]);
      stub.bases.push({ id: "k2", name: "客服问答" });
      const sent = first.stdin.length;

      expect((await regenerate(world)).statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");

      const tail = untilPrompt(first.stdin.slice(sent));
      expect(types(tail)).toEqual([
        "set_host_tools",
        "get_branch_messages",
        "branch",
        "get_state",
        "prompt",
      ]);
      expect(String(toolsOf(tail[0])[0]?.description).split("\n").slice(-2)).toEqual([
        "- 产品文档（k1）",
        "- 客服问答（k2）",
      ]);
      expect(world.rt.calls).toHaveLength(1);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "对齐失败时 regenerate 不动分支：502，没有 get_branch_messages 与 branch，行不变，slot 被退役",
    REAL,
    async () => {
      const stub = stubSearch([]);
      const world = worlds.track(await openStubWorld(stub, "host-tool-register-fail", false));
      const { db, supervisor } = world.fixture;
      await answered(world);
      const first = spawnedAt(world, 0);
      expect(ofType(first.stdin, "set_host_tools")).toEqual([]);
      stub.bases.push({ id: "k1", name: "产品文档" });
      const before = snapshot(db, world.session);
      const sent = first.stdin.length;

      const response = await regenerate(world);

      expect([response.statusCode, response.json()]).toEqual([502, AGENT_UNAVAILABLE_ENVELOPE]);
      expect(types(first.stdin.slice(sent))).toEqual(["set_host_tools"]);
      expect(snapshot(db, world.session)).toEqual(before);
      await waitDead(world, 0);
      expect(supervisor.liveProcessCount()).toBe(0);
      expect(supervisor.controlHeld(world.session)).toBe(false);
    },
  );
});

/** A real-kb world: the kb module on, against a fake RAGFlow; bases are inserted through the store. */
async function openKbWorld() {
  const fake = await start({ apiKey: RAGFLOW_KEY });
  fakes.push(fake);
  const world = worlds.track(
    await openRegenWorld({
      scenario: "host-tool",
      assembly: {
        kb: {
          key: { read: () => RAGFLOW_KEY },
          baseUrl: fake.baseUrl,
          uploadMaxBytes: 1024,
          uploadMaxFiles: 10,
          log: () => {},
        },
      },
    }),
  );
  const store = createKbStore(world.fixture.db);
  const addBase = (ownerId: string, name: string, hit?: string): string => {
    const id = store.newId();
    const datasetId = fake.addDataset(resourceName(id, 0));
    store.createBase({
      id,
      ownerId,
      name,
      template: "naive",
      raptor: false,
      graph: false,
      datasetId,
      canvasId: null,
      templateGroupId: null,
    });
    world.fixture.db.prepare("UPDATE knowledge_bases SET state = 'ready' WHERE id = ?").run(id);
    if (hit !== undefined) {
      store.addDocument({
        kbId: id,
        ragflowDocumentId: `rf-${id}`,
        name: "规格.md",
        size: 3,
        source: "upload",
      });
      fake.setRetrievalHits(datasetId, [{ documentId: `rf-${id}`, content: hit, similarity: 0.9 }]);
    }
    return id;
  };
  const retrievals = () =>
    fake.requests().filter((entry) => `${entry.method} ${entry.path}` === RETRIEVAL).length;
  return { world, addBase, retrievals };
}

describe("只以所有者执行 (omp-runtime「kb_search 的注册」, real kb)", () => {
  it(
    "两个账号的 slot 同时存活：互指对方的库得 not_found 且零检索；A 指自己的库得假 RAGFlow 的切片",
    REAL,
    async () => {
      const { world, addBase, retrievals } = await openKbWorld();
      const { app } = world.fixture;
      const kA = addBase("u1", "A 的库", `超时 30 分钟 ${SENTINEL}`);
      const kB = addBase(PRINCIPAL_ZHAOLIU.id, "B 的库", "B 的切片");
      const peer = await cookieFor(app, "zhaoliu");
      const sessionB = await createSession(app, peer);

      // A's slot first, then B's: a handler bound to the last owner would turn A's own base red below.
      expect((await sendPrompt(world, `查一下 KB:${kB}`)).statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");
      const promptB = await postPrompt(
        app,
        sessionB,
        peer,
        JSON.stringify({ message: `查一下 KB:${kA}` }),
      );
      expect(promptB.statusCode).toBe(202);
      await waitFor(
        () =>
          world.fixture.store.getMessages(sessionB, PRINCIPAL_ZHAOLIU.id)?.session.status === "done"
            ? true
            : undefined,
        "B's turn done",
      );
      expect(results(spawnedAt(world, 0).stdin)).toEqual([
        [`知识库 ${kB}：未找到该知识库`, true],
        [`知识库 ${kB}：未找到该知识库`, true],
      ]);
      expect(results(spawnedAt(world, 1).stdin)).toEqual([
        [`知识库 ${kA}：未找到该知识库`, true],
        [`知识库 ${kA}：未找到该知识库`, true],
      ]);
      expect(retrievals()).toBe(0);

      const a = spawnedAt(world, 0).stdin;
      const sent = a.length;
      expect((await sendPrompt(world, `查一下 KB:${kA}`)).statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");

      expect(world.fixture.supervisor.liveProcessCount()).toBe(2);
      const own = results(a.slice(sent));
      expect(own).toHaveLength(2);
      for (const [text, isError] of own) {
        expect([text.includes(SENTINEL), isError]).toEqual([true, false]);
      }
      expect(retrievals()).toBe(2);
      expect(world.rt.calls).toHaveLength(2);
    },
  );
});

describe("装配：知识库开启时 createApp 把会话检索注入 sessions (4.5)", () => {
  it(
    "一个回合里 set_host_tools 列出所有者的库，host_tool_result 的文本来自假 RAGFlow 的切片",
    REAL,
    async () => {
      const { world, addBase, retrievals } = await openKbWorld();
      const kA = addBase("u1", "产品文档", `超时 30 分钟 ${SENTINEL}`);

      expect((await sendPrompt(world, `查一下 KB:${kA}`)).statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");

      const { stdin } = spawnedAt(world, 0);
      const [registration] = ofType(stdin, "set_host_tools");
      expect(toolsOf(registration)).toHaveLength(1);
      expect(toolsOf(registration)[0]).toMatchObject({ name: "kb_search", loadMode: "essential" });
      expect(String(toolsOf(registration)[0]?.description)).toContain(`- 产品文档（${kA}）`);
      const texts = results(stdin);
      expect(texts).toHaveLength(2);
      expect(texts.every(([text, isError]) => text.includes(SENTINEL) && !isError)).toBe(true);
      expect(retrievals()).toBe(2);
    },
  );
});

describe("第 3 步的应答校验 (host-tool-align.ts, runtime stubbed)", () => {
  /** A slot whose live generation already holds a process: `command` is the stubbed runtime's. */
  function slotWith(command: (frame: OmpFrame) => Promise<unknown>) {
    const generation = { hostTools: undefined as unknown };
    const sent: OmpFrame[] = [];
    const slot = {
      runtime: {
        command: (frame: OmpFrame) => {
          sent.push(frame);
          return command(frame);
        },
      },
      generation,
      acquisitionFault: undefined,
    } as unknown as Slot;
    return { slot, generation, sent };
  }

  it("toolNames 与 [kb_search] 不符时抛 AgentUnavailableError，所记清单不变", async () => {
    const { alignHostTools } = await import("../src/sessions/host-tool-align.js");
    const stub = stubSearch([{ id: "k1", name: "产品文档" }]);
    const { slot, generation, sent } = slotWith(() => Promise.resolve({ toolNames: ["other"] }));

    await expect(alignHostTools(slot, () => stub.source, "u1")).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
    expect(types(sent)).toEqual(["set_host_tools"]);
    expect(generation.hostTools).toBeUndefined();
  });

  it("定义源同步抛错包成 AgentUnavailableError 并带 cause，不发命令", async () => {
    const { alignHostTools } = await import("../src/sessions/host-tool-align.js");
    const failure = new Error("database is locked");
    const source = {
      ...stubSearch([]).source,
      definitionFor: () => {
        throw failure;
      },
    };
    const { slot, sent } = slotWith(() => Promise.resolve({ toolNames: ["kb_search"] }));

    const error = await alignHostTools(slot, () => source, "u1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect((error as Error).cause).toBe(failure);
    expect(sent).toEqual([]);
  });
});
