/**
 * s2b-kb-retrieval 组 2（#1915）：`BaseView.retrieval` 的严格解析。接缝：真实的 `createApiClient` 加替身 `fetch`。
 *
 * 期望值抄自规格，不从实现推：knowledge-bases「知识库端点」的视图 `retrieval:{threshold, vectorWeight}`，两值是数字；
 * 0–1 的取值域由服务端 CHECK 保证，web 侧只认有限数字（tasks.md「组 2 约定」）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, type BaseView, createApiClient } from "../src/lib/api.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

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
