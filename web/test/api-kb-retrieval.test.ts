/**
 * s2b-kb-retrieval 组 2（#1915）：`BaseView.retrieval` 的严格解析。接缝：真实的 `createApiClient` 加替身 `fetch`。
 *
 * 期望值抄自规格，不从实现推：knowledge-bases「知识库端点」的视图 `retrieval:{threshold, vectorWeight}`，两值是数字；
 * 0–1 的取值域由服务端 CHECK 保证，web 侧只认有限数字（tasks.md「组 2 约定」）。
 *
 * 组 8 首刀（#1921）：`retrieveFromKnowledgeBase` 的请求与严格解析。期望值抄自 knowledge-bases「检索测试端点」的 200
 * `{hits, retrieval}`（命中恰为 `{documentId, name, similarity, content}`）与「中心「知识库」tab」的 API 客户端条款，
 * 以及 tasks.md「组 8 首刀约定」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApiClient,
  type BaseView,
  createApiClient,
  type KbRetrievalInput,
  type KbRetrievalResult,
  type RetrievalHit,
} from "../src/lib/api.js";
import {
  captureApiError,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

type Case = [name: string, retrieval: unknown];

const BASE: BaseView = {
  id: "0123456789abcdef0123456789abcdef",
  name: "规范库",
  template: "manual",
  raptor: false,
  graph: false,
  state: "ready",
  stateMessage: null,
  documents: 0,
  compile: { raptor: "off", graph: "off" },
  retrieval: { threshold: 0.2, vectorWeight: 0.7 },
  createdAt: 1_760_000_000_000,
};

/** 建库 201 原样返回 `BaseView`；列表 200 的 `{bases}` 外层由客户端拆掉。 */
const METHODS = [
  {
    method: "createKnowledgeBase",
    status: 201,
    call: (client: ApiClient) => client.createKnowledgeBase({ name: "规范库", template: "manual" }),
    wrap: (base: unknown) => base,
    result: (base: unknown) => base,
  },
  {
    method: "listKnowledgeBases",
    status: 200,
    call: (client: ApiClient) => client.listKnowledgeBases(),
    wrap: (base: unknown) => ({ bases: [base] }),
    result: (base: unknown) => [base],
  },
];

const ACCEPTED: Case[] = [
  ["缺省 {0.2, 0.7}", { threshold: 0.2, vectorWeight: 0.7 }],
  ["两端 0 与 1", { threshold: 0, vectorWeight: 1 }],
  // 0–1 由服务端 CHECK 保证，web 不重复校验。
  ["区间外的有限数字", { threshold: 1.5, vectorWeight: -0.1 }],
];

const REJECTED: Case[] = [
  ["null", null],
  ["字符串", "0.2"],
  ["数组", [0.2, 0.7]],
  ["空对象", {}],
  ["缺 threshold", { vectorWeight: 0.7 }],
  ["缺 vectorWeight", { threshold: 0.2 }],
  ["多一键", { threshold: 0.2, vectorWeight: 0.7, rerankId: null }],
  ["threshold 为字符串", { threshold: "0.2", vectorWeight: 0.7 }],
  ["vectorWeight 为字符串", { threshold: 0.2, vectorWeight: "0.7" }],
  ["threshold 为 null", { threshold: null, vectorWeight: 0.7 }],
  ["vectorWeight 为布尔", { threshold: 0.2, vectorWeight: true }],
];

/** `JSON.stringify` 会把 `NaN` 写成 `null`：直接替换 `json()`，让解析器真正收到 `NaN`。 */
function rawJsonResponse(body: unknown, status: number) {
  const response = new Response("{}", {
    status,
    headers: { "Content-Type": "application/json" },
  });
  vi.spyOn(response, "json").mockResolvedValue(body);
  return response;
}

/** JSON 文本里的 `1e999` 经 `JSON.parse` 成为 `Infinity`：线上可达的非有限数字。 */
function textResponse(text: string, status: number) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stub(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return vi.mocked(fetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(METHODS)("$method 的 retrieval", ({ status, call, wrap, result }) => {
  it.each(ACCEPTED)("有限数字通过：%s", async (_name, retrieval) => {
    const view = { ...BASE, retrieval };
    stub(jsonResponse(wrap(view), status));

    await expect(call(createApiClient())).resolves.toStrictEqual(result(view));
  });

  it("缺 retrieval 为 request_failed", async () => {
    const { retrieval: _omitted, ...without } = BASE;
    stub(jsonResponse(wrap(without), status));

    expectRequestFailure(await captureApiError(call(createApiClient())), status);
  });

  it.each(REJECTED)("类型不符为 request_failed：%s", async (_name, retrieval) => {
    stub(jsonResponse(wrap({ ...BASE, retrieval }), status));

    expectRequestFailure(await captureApiError(call(createApiClient())), status);
  });

  it.each([
    ["threshold 为 NaN", { threshold: Number.NaN, vectorWeight: 0.7 }],
    ["vectorWeight 为 NaN", { threshold: 0.2, vectorWeight: Number.NaN }],
  ])("非有限数字为 request_failed：%s", async (_name, retrieval) => {
    stub(rawJsonResponse(wrap({ ...BASE, retrieval }), status));

    expectRequestFailure(await captureApiError(call(createApiClient())), status);
  });

  it("JSON 里溢出成 Infinity 的值为 request_failed", async () => {
    const text = JSON.stringify(wrap(BASE)).replace('"threshold":0.2', '"threshold":1e999');
    expect(text).toContain("1e999");
    stub(textResponse(text, status));

    expectRequestFailure(await captureApiError(call(createApiClient())), status);
  });
});

const KB_ID = "kb/1 中";
const RETRIEVAL_URL = "/api/kb/bases/kb%2F1%20%E4%B8%AD/retrieval";
// 问句首尾的空白与换行原样发出，不 trim。
const INPUT: KbRetrievalInput = { question: "  口径\n", threshold: 0.2, vectorWeight: 0.7 };
const HIT: RetrievalHit = {
  documentId: "doc-1",
  name: "规范.pdf",
  similarity: 0.82,
  content: "第一条 口径",
};
const EMPTY: KbRetrievalResult = { hits: [], retrieval: { threshold: 0.2, vectorWeight: 0.7 } };

const retrieve = (client = createApiClient(), options?: { signal: AbortSignal }) =>
  client.retrieveFromKnowledgeBase(KB_ID, INPUT, options);

/** 用一组命中替换 `EMPTY.hits`。 */
const withHits = (...hits: unknown[]) => ({ ...EMPTY, hits });

/** 命中四键各缺一次。 */
const MISSING_HIT_KEYS: Case[] = Object.keys(HIT).map((key) => [
  `命中缺 ${key}`,
  withHits(Object.fromEntries(Object.entries(HIT).filter(([name]) => name !== key))),
]);

describe("retrieveFromKnowledgeBase 的请求", () => {
  it("POST 到该库的 retrieval，body 是 input 原样序列化，返回解析后的应答", async () => {
    const fetchMock = stub(jsonResponse(EMPTY, 200));

    await expect(retrieve()).resolves.toStrictEqual(EMPTY);

    expect(fetchMock.mock.calls).toStrictEqual([
      [
        RETRIEVAL_URL,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: '{"question":"  口径\\n","threshold":0.2,"vectorWeight":0.7}',
        },
      ],
    ]);
  });

  it("传入的 signal 进请求", async () => {
    const fetchMock = stub(jsonResponse(EMPTY, 200));
    const { signal } = new AbortController();

    await retrieve(undefined, { signal });

    expect(fetchMock.mock.calls[0]?.[1]).toStrictEqual({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INPUT),
      signal,
    });
  });

  it("成功码只认 200：201 为 request_failed", async () => {
    stub(jsonResponse(EMPTY, 201));

    expectRequestFailure(await captureApiError(retrieve()), 201);
  });

  it.each([
    [400, "bad_request", "请求参数无效"],
    [404, "not_found", "知识库不存在"],
    [409, "kb_rebuilding", "知识库正在重建"],
    [503, "kb_unavailable", "知识库服务暂不可用"],
    [400, "kb_rejected", "知识库服务拒绝了这次请求"],
  ])("错误信封原样透传：%i %s", async (status, code, message) => {
    const onUnauthorized = vi.fn();
    const fetchMock = stub(jsonResponse({ error: { code, message } }, status));

    const error = await captureApiError(retrieve(createApiClient({ onUnauthorized })));

    expect(error).toMatchObject({ status, code, message });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("非 JSON 的 500 为 request_failed", async () => {
    stub(new Response("Internal Server Error", { status: 500 }));

    expectRequestFailure(await captureApiError(retrieve()), 500);
  });

  it.each(unauthorizedResponseCases())("401（%s 应答）恰好通知一次", async (kind, response) => {
    const onUnauthorized = vi.fn();
    stub(response);
    const { signal } = new AbortController();

    const error = await captureApiError(retrieve(createApiClient({ onUnauthorized }), { signal }));

    expect(onUnauthorized.mock.calls).toStrictEqual([[signal]]);
    // 合法信封原样保留；残缺或非 JSON 的 401 为 request_failed。
    if (kind !== "a legal") {
      expectRequestFailure(error, 401);
      return;
    }
    expect(error).toMatchObject({ status: 401, code: "unauthorized", message: "登录已失效" });
  });
});

describe("retrieveFromKnowledgeBase 的应答解析", () => {
  it.each<[string, KbRetrievalResult]>([
    ["hits 为空数组", EMPTY],
    ["一条命中", { ...EMPTY, hits: [HIT] }],
    [
      "同一文档两条命中：次序同应答，不去重",
      { ...EMPTY, hits: [HIT, { ...HIT, similarity: 0.4, content: "第二条" }] },
    ],
    // 0–1 不在 web 侧校验，与 `parseRetrieval` 一致。
    [
      "similarity 取 0、1 与区间外的有限数",
      {
        ...EMPTY,
        hits: [
          { ...HIT, similarity: 0 },
          { ...HIT, similarity: 1 },
          { ...HIT, similarity: 1.5 },
        ],
      },
    ],
    ["content 含换行", { ...EMPTY, hits: [{ ...HIT, content: "第一行\n第二行" }] }],
  ])("通过并原样返回：%s", async (_name, body) => {
    stub(jsonResponse(body, 200));

    await expect(retrieve()).resolves.toStrictEqual(body);
  });

  it.each<Case>([
    ["顶层为 null", null],
    ["顶层为数组", [EMPTY]],
    ["顶层为字符串", "hits"],
    ["顶层为空对象", {}],
    ["缺 hits", { retrieval: EMPTY.retrieval }],
    ["缺 retrieval", { hits: [] }],
    ["顶层多一键", { ...EMPTY, total: 1 }],
    ["hits 为 null", { ...EMPTY, hits: null }],
    ["hits 为对象", { ...EMPTY, hits: {} }],
    ["hits 为字符串", { ...EMPTY, hits: "[]" }],
    ["命中为 null", withHits(null)],
    ["命中多一键", withHits({ ...HIT, ragflowDocumentId: "rf-1" })],
    ...MISSING_HIT_KEYS,
    ["documentId 为数字", withHits({ ...HIT, documentId: 1 })],
    ["documentId 为 null", withHits({ ...HIT, documentId: null })],
    ["name 为数字", withHits({ ...HIT, name: 1 })],
    ["content 为 null", withHits({ ...HIT, content: null })],
    ["similarity 为字符串", withHits({ ...HIT, similarity: "0.9" })],
    ["similarity 为 null", withHits({ ...HIT, similarity: null })],
    ["similarity 为布尔", withHits({ ...HIT, similarity: true })],
    ["一条好命中加一条坏命中", withHits(HIT, { ...HIT, name: null })],
  ])("形状不符为 request_failed：%s", async (_name, body) => {
    stub(jsonResponse(body, 200));

    expectRequestFailure(await captureApiError(retrieve()), 200);
  });

  it.each(REJECTED)("retrieval 不符为 request_failed：%s", async (_name, retrieval) => {
    stub(jsonResponse({ hits: [], retrieval }, 200));

    expectRequestFailure(await captureApiError(retrieve()), 200);
  });

  it("similarity 为 NaN 为 request_failed", async () => {
    stub(rawJsonResponse(withHits({ ...HIT, similarity: Number.NaN }), 200));

    expectRequestFailure(await captureApiError(retrieve()), 200);
  });

  it("JSON 里溢出成 Infinity 的 similarity 为 request_failed", async () => {
    const text = JSON.stringify(withHits(HIT)).replace('"similarity":0.82', '"similarity":1e999');
    expect(text).toContain("1e999");
    stub(textResponse(text, 200));

    expectRequestFailure(await captureApiError(retrieve()), 200);
  });
});
