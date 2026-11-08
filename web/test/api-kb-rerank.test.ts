/**
 * s2b-kb-retrieval tasks 6.1（#1917）：设置读视图的 `rerank` 严格解析与 `updateKbSettings` 的 `rerank` input。接缝：真实的
 * `createApiClient` 加替身 `fetch`。
 *
 * 期望值抄自规格，不从实现推：ragflow-backend「知识库模型设置」的读视图恰为八键，`rerank` 为
 * `{name, baseUrl, probe:{status, message, at}}` 或 `null`，各字段同 `embedding`；PUT body 的 `rerank` 为
 * `{name, baseUrl, apiKey?}` 或 `null`（tasks.md「组 6 首刀约定」的 web 一条）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApiClient,
  createApiClient,
  type KbSettingsView,
  type UpdateKbSettingsInput,
} from "../src/lib/api.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

type Case = [name: string, rerank: unknown];

const AT = 1_760_000_000_000;
const GW = "https://gw.example/v1";
const PROBE = { status: "ok", message: null, at: AT } as const;
const RERANK = { name: "qwen3-rerank", baseUrl: GW, probe: PROBE };
const VIEW: KbSettingsView = {
  embedding: { name: "bge-m3", baseUrl: GW, probe: PROBE },
  chatModelId: "m2",
  rerank: RERANK,
  bases: 1,
  compileBases: 0,
  documents: 2,
  rebuilding: 0,
  rebuildFailed: 0,
};

/** 设置读视图的两个代表方法：读与写。四个方法共用一个解析器，全量矩阵在 `api-kb.test.ts`。 */
const METHODS = [
  { method: "getKbSettings", call: (client: ApiClient) => client.getKbSettings() },
  {
    method: "updateKbSettings",
    call: (client: ApiClient) => client.updateKbSettings({ rerank: null }),
  },
];

const ACCEPTED: Case[] = [
  ["未配置 null", null],
  ["已配置、探活 ok", RERANK],
  ["探活从未", { ...RERANK, probe: { status: "never", message: null, at: null } }],
  ["探活失败带摘要", { ...RERANK, probe: { status: "failed", message: "HTTP 401", at: AT } }],
];

const REJECTED: Case[] = [
  ["字符串", "qwen3-rerank"],
  ["数字", 1],
  ["数组", [RERANK]],
  ["空对象", {}],
  ["多一键 apiKey", { ...RERANK, apiKey: "k" }],
  ["缺 name", { baseUrl: GW, probe: PROBE }],
  ["缺 baseUrl", { name: "qwen3-rerank", probe: PROBE }],
  ["缺 probe", { name: "qwen3-rerank", baseUrl: GW }],
  ["name 为数字", { ...RERANK, name: 1 }],
  ["baseUrl 为 null", { ...RERANK, baseUrl: null }],
  ["probe 为 null", { ...RERANK, probe: null }],
  ["probe 为字符串", { ...RERANK, probe: "ok" }],
  ["probe 多一键", { ...RERANK, probe: { ...PROBE, extra: 1 } }],
  ["probe 缺 at", { ...RERANK, probe: { status: "ok", message: null } }],
  ["probe.status 不在取值内", { ...RERANK, probe: { ...PROBE, status: "running" } }],
  ["probe.message 为数字", { ...RERANK, probe: { ...PROBE, message: 1 } }],
  ["probe.at 为负数", { ...RERANK, probe: { ...PROBE, at: -1 } }],
];

function stub(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(METHODS)("$method 的 rerank", ({ call }) => {
  it.each(ACCEPTED)("形状相符即通过：%s", async (_name, rerank) => {
    const view = { ...VIEW, rerank };
    stub(jsonResponse(view));

    await expect(call(createApiClient())).resolves.toStrictEqual(view);
  });

  it("缺 rerank 键为 request_failed", async () => {
    const { rerank: _omitted, ...without } = VIEW;
    stub(jsonResponse(without));

    expectRequestFailure(await captureApiError(call(createApiClient())), 200);
  });

  it.each(REJECTED)("形状不符为 request_failed：%s", async (_name, rerank) => {
    stub(jsonResponse({ ...VIEW, rerank }));

    expectRequestFailure(await captureApiError(call(createApiClient())), 200);
  });
});

describe("updateKbSettings 的 rerank input 只发所给的键", () => {
  it.each<[string, UpdateKbSettingsInput, string]>([
    ["清除", { rerank: null }, '{"rerank":null}'],
    [
      "省略密钥即保留",
      { rerank: { name: "qwen3-rerank", baseUrl: GW } },
      '{"rerank":{"name":"qwen3-rerank","baseUrl":"https://gw.example/v1"}}',
    ],
    [
      "首次配置带密钥",
      { rerank: { name: "qwen3-rerank", baseUrl: GW, apiKey: "k" } },
      '{"rerank":{"name":"qwen3-rerank","baseUrl":"https://gw.example/v1","apiKey":"k"}}',
    ],
  ])("%s", async (_name, input, body) => {
    const fetchMock = stub(jsonResponse(VIEW));

    await createApiClient().updateKbSettings(input);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/kb/settings");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT", body });
  });
});
