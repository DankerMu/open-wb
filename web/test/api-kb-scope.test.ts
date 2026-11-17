/**
 * #2038 s2c-kb-visibility 组 12：`getMyScope` 的严格解析（account-groups「账号范围端点」）、`setKnowledgeBaseScope`
 * 与 `createKnowledgeBase` 的 `scope` 参数（knowledge-bases「知识库范围端点」「知识库端点」建库）。接缝同
 * `api-kb-visibility.test.ts`：真实的 `createApiClient` 加替身 `fetch`。
 *
 * 期望值抄自规格与服务端契约（`server/src/accounts/scope.ts:8-24`、`server/src/kb/scope.ts:37-52,85-88`）：应答恰为
 * `{department, groups}`，组项恰为 `{id, name, memberCount}`，`memberCount` 为正安全整数；PUT 必带 `scope` 键，
 * 非 group 档不带 `groupId`；建库为仅自己可见时 body 不带 `scope`（由调用方不传而来，客户端原样序列化）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BaseView, createApiClient } from "../src/lib/api.js";
import { base } from "./center-kb-support.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

type Case = [name: string, value: unknown];

const GROUP = { id: "g1", name: "内网落地专项", memberCount: 2 };
const SCOPE = { department: "平台研发部", groups: [GROUP] };
const G1_VIEW: BaseView["scope"] = { scope: "group", group: { id: "g1", name: "内网落地专项" } };
const SCOPE_ADDRESS = "/api/kb/bases/kb%2F1%20%E4%B8%AD/scope";

const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const SCOPE_REJECTED: Case[] = [
  ["外层多一键", { ...SCOPE, extra: 1 }],
  ["缺 department", without(SCOPE, "department")],
  ["缺 groups", without(SCOPE, "groups")],
  ...[1, true, {}].map(
    (department): Case => [`department 为 ${JSON.stringify(department)}`, { ...SCOPE, department }],
  ),
  ...[null, {}, "g1"].map(
    (groups): Case => [`groups 为 ${JSON.stringify(groups)}`, { ...SCOPE, groups }],
  ),
  ["整个应答为 []", []],
  ["整个应答为 null", null],
  ["组项多一键", { ...SCOPE, groups: [{ ...GROUP, extra: 1 }] }],
  ...["id", "name", "memberCount"].map(
    (key): Case => [`组项缺 ${key}`, { ...SCOPE, groups: [without(GROUP, key)] }],
  ),
  ...(["id", "name"] as const).flatMap((key) =>
    [1, null].map(
      (value): Case => [
        `组项 ${key} 为 ${value}`,
        { ...SCOPE, groups: [{ ...GROUP, [key]: value }] },
      ],
    ),
  ),
  ...[0, -1, 1.5, "2", null, true, 2 ** 53].map(
    (memberCount): Case => [
      `memberCount 为 ${JSON.stringify(memberCount)}`,
      { ...SCOPE, groups: [{ ...GROUP, memberCount }] },
    ],
  ),
];

function stub(body: unknown, status: number) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const BAD_REQUEST = { error: { code: "bad_request", message: "请求格式不正确" } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getMyScope", () => {
  it("GET /api/accounts/me/scope，no-store，不带 signal", async () => {
    const fetchMock = stub(SCOPE, 200);

    await createApiClient().getMyScope();

    expect(fetchMock.mock.calls).toStrictEqual([
      ["/api/accounts/me/scope", { method: "GET", credentials: "same-origin", cache: "no-store" }],
    ]);
  });

  it("传了 signal 时 init 多一个 signal", async () => {
    const fetchMock = stub(SCOPE, 200);
    const { signal } = new AbortController();

    await createApiClient().getMyScope({ signal });

    expect(fetchMock.mock.calls).toStrictEqual([
      [
        "/api/accounts/me/scope",
        { method: "GET", credentials: "same-origin", cache: "no-store", signal },
      ],
    ]);
  });

  it.each<Case>([
    ["一个部门一个组", SCOPE],
    ["没有部门也没有组", { department: null, groups: [] }],
    [
      "两个组保持应答次序",
      {
        department: "平台研发部",
        groups: [{ id: "g2", name: "数据治理", memberCount: 3 }, GROUP],
      },
    ],
  ])("合规即原样通过：%s", async (_name, body) => {
    stub(body, 200);

    await expect(createApiClient().getMyScope()).resolves.toStrictEqual(body);
  });

  it.each(SCOPE_REJECTED)("不合规为 request_failed(200)：%s", async (_name, body) => {
    stub(body, 200);

    expectRequestFailure(await captureApiError(createApiClient().getMyScope()), 200);
  });

  it("201 为 request_failed(201)", async () => {
    stub(SCOPE, 201);

    expectRequestFailure(await captureApiError(createApiClient().getMyScope()), 201);
  });

  it("503 信封原样透传", async () => {
    stub({ error: { code: "kb_unavailable", message: "知识库服务暂不可用" } }, 503);

    expect(await captureApiError(createApiClient().getMyScope())).toMatchObject({
      status: 503,
      code: "kb_unavailable",
      message: "知识库服务暂不可用",
    });
  });
});

describe("setKnowledgeBaseScope", () => {
  const put = (body: string) => ({
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body,
  });

  it("PUT …/scope：id 编码进路径，body 恰为所给的键（group 带 groupId，其余档只带 scope）", async () => {
    const view = base("kb/1 中", { scope: G1_VIEW });
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(view, 200));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient();

    await expect(
      client.setKnowledgeBaseScope("kb/1 中", { scope: "group", groupId: "g1" }),
    ).resolves.toStrictEqual(view);
    await client.setKnowledgeBaseScope("kb/1 中", { scope: "me" });
    await client.setKnowledgeBaseScope("kb/1 中", { scope: "all" });

    expect(fetchMock.mock.calls).toStrictEqual([
      [SCOPE_ADDRESS, put('{"scope":"group","groupId":"g1"}')],
      [SCOPE_ADDRESS, put('{"scope":"me"}')],
      [SCOPE_ADDRESS, put('{"scope":"all"}')],
    ]);
  });

  it("201 为 request_failed(201)", async () => {
    stub(base("k1"), 201);

    expectRequestFailure(
      await captureApiError(createApiClient().setKnowledgeBaseScope("k1", { scope: "all" })),
      201,
    );
  });

  it("应答的 BaseView 缺 scope 键为 request_failed(200)", async () => {
    stub(without(base("k1"), "scope"), 200);

    expectRequestFailure(
      await captureApiError(createApiClient().setKnowledgeBaseScope("k1", { scope: "all" })),
      200,
    );
  });

  it("400 信封原样透传", async () => {
    stub(BAD_REQUEST, 400);

    expect(
      await captureApiError(createApiClient().setKnowledgeBaseScope("k1", { scope: "dept" })),
    ).toMatchObject({ status: 400, code: "bad_request", message: "请求格式不正确" });
  });
});

describe("createKnowledgeBase 的 scope", () => {
  it("body 原样带 scope 与 groupId；201 的项目组视图原样通过", async () => {
    const view = base("k1", { name: "组库", scope: G1_VIEW });
    const fetchMock = stub(view, 201);

    await expect(
      createApiClient().createKnowledgeBase({
        name: "组库",
        template: "naive",
        scope: "group",
        groupId: "g1",
      }),
    ).resolves.toStrictEqual(view);

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      '{"name":"组库","template":"naive","scope":"group","groupId":"g1"}',
    );
  });

  it("全员可见只带 scope", async () => {
    const fetchMock = stub(
      base("k2", { name: "全员库", scope: { scope: "all", group: null } }),
      201,
    );

    await createApiClient().createKnowledgeBase({
      name: "全员库",
      template: "naive",
      scope: "all",
    });

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      '{"name":"全员库","template":"naive","scope":"all"}',
    );
  });
});
