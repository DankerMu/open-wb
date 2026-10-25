/**
 * s1d-connectors 任务 6.2 / 6.3：`web/src/lib/api-connectors.ts` 的七个方法（connectors「中心「连接器」tab」的
 * API 客户端句）。接缝：真实的 `createApiClient` 加替身 `fetch`。期望值来自规格与服务端 `server/src/connectors/
 * rest.ts`：路径与 `?name=` 的百分号编码（字面量）、各端点的状态码（list / update / probe / defaults 200、create
 * 201、delete 204）、两种视图（管理员恰十一键、其它角色恰 `{name, type, description}`）与账号缺省 `{disabledConnectors}`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConnectorView, createApiClient } from "../src/lib/api.js";
import { DOCS, GITLAB } from "./center-connectors-support.js";
import { captureApiError, createFetchMock, expectRequestFailure, jsonResponse } from "./support.js";

const GET = { method: "GET", credentials: "same-origin", cache: "no-store" };
const JSON_HEADERS = { "Content-Type": "application/json" };
const MEMBER_ROW = { name: "gitlab", type: "stdio", description: "代码库" };
/** 不合名称规则的名字只用来证明编码：服务端会 404，客户端照样编码。 */
const ODD = "a b/c?&#";
const ODD_QUERY = "name=a%20b%2Fc%3F%26%23";
const UPDATE = {
  description: "代码库",
  command: "/usr/local/bin/gitlab-mcp",
  args: ["--stdio"],
  env: { TOKEN: null },
  enabled: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub(routes: Parameters<typeof createFetchMock>[0]) {
  const fetchMock = createFetchMock(routes);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("七个方法的请求与成功应答", () => {
  it("listConnectors：管理员视图的表 → {admin: true, connectors}", async () => {
    const fetchMock = stub({
      "/api/connectors": () => jsonResponse({ connectors: [DOCS, GITLAB] }),
    });

    await expect(createApiClient().listConnectors()).resolves.toEqual({
      admin: true,
      connectors: [DOCS, GITLAB],
    });
    expect(fetchMock.mock.calls).toEqual([["/api/connectors", GET]]);
  });

  it("listConnectors：恰三键的表 → {admin: false, connectors}", async () => {
    stub({ "/api/connectors": () => jsonResponse({ connectors: [MEMBER_ROW] }) });

    await expect(createApiClient().listConnectors()).resolves.toEqual({
      admin: false,
      connectors: [MEMBER_ROW],
    });
  });

  it("createConnector POSTs exactly the given input as JSON and expects 201", async () => {
    const fetchMock = stub({ "/api/connectors": () => jsonResponse(DOCS, 201) });
    const input = { name: "docs", type: "http" as const, url: "https://docs.example/mcp" };

    await expect(createApiClient().createConnector(input)).resolves.toEqual(DOCS);
    expect(fetchMock.mock.calls).toEqual([
      [
        "/api/connectors",
        {
          method: "POST",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: JSON.stringify(input),
        },
      ],
    ]);
  });

  it("updateConnector PUTs to ?name=<encodeURIComponent(name)> with the JSON body and expects 200", async () => {
    const path = `/api/connectors?${ODD_QUERY}`;
    const fetchMock = stub({ [path]: () => jsonResponse(GITLAB) });

    await expect(createApiClient().updateConnector(ODD, UPDATE)).resolves.toEqual(GITLAB);
    expect(fetchMock.mock.calls).toEqual([
      [
        path,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: JSON.stringify(UPDATE),
        },
      ],
    ]);
  });

  it("deleteConnector sends DELETE without a body to ?name=<encoded> and resolves on 204", async () => {
    const path = `/api/connectors?${ODD_QUERY}`;
    const fetchMock = stub({ [path]: () => new Response(null, { status: 204 }) });

    await expect(createApiClient().deleteConnector(ODD)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls).toEqual([
      [path, { method: "DELETE", credentials: "same-origin" }],
    ]);
  });

  it("probeConnector POSTs to /api/connectors/probe?name=<encoded> without a body or Content-Type and expects 200", async () => {
    const path = `/api/connectors/probe?${ODD_QUERY}`;
    const fetchMock = stub({ [path]: () => jsonResponse(GITLAB) });

    await expect(createApiClient().probeConnector(ODD)).resolves.toEqual(GITLAB);
    expect(fetchMock.mock.calls).toEqual([[path, { method: "POST", credentials: "same-origin" }]]);
  });

  it("getConnectorDefaults GETs and putConnectorDefaults PUTs {disabledConnectors}; both return the list", async () => {
    const fetchMock = stub({
      "/api/connectors/defaults": [
        jsonResponse({ disabledConnectors: ["ghost"] }),
        jsonResponse({ disabledConnectors: ["ghost", "gitlab"] }),
      ],
    });
    const client = createApiClient();

    await expect(client.getConnectorDefaults()).resolves.toEqual(["ghost"]);
    await expect(client.putConnectorDefaults(["gitlab", "ghost"])).resolves.toEqual([
      "ghost",
      "gitlab",
    ]);
    expect(fetchMock.mock.calls).toEqual([
      ["/api/connectors/defaults", GET],
      [
        "/api/connectors/defaults",
        {
          method: "PUT",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: JSON.stringify({ disabledConnectors: ["gitlab", "ghost"] }),
        },
      ],
    ]);
  });
});

describe("期望状态码", () => {
  it.each([
    [
      "createConnector 200",
      () =>
        createApiClient().createConnector({ name: "docs", type: "http", url: "https://d.example" }),
      "/api/connectors",
      200,
    ],
    [
      "updateConnector 201",
      () => createApiClient().updateConnector("gitlab", UPDATE),
      "/api/connectors?name=gitlab",
      201,
    ],
    [
      "probeConnector 202",
      () => createApiClient().probeConnector("gitlab"),
      "/api/connectors/probe?name=gitlab",
      202,
    ],
  ] as const)("%s with a valid view is request_failed", async (_label, call, path, status) => {
    stub({ [path]: () => jsonResponse(GITLAB, status) });

    expectRequestFailure(await captureApiError(call()), status);
  });

  it("an envelope keeps status, code and message; a non-envelope 500 is request_failed 500", async () => {
    const envelope = { code: "bad_request", message: "请求格式不正确" };
    stub({
      "/api/connectors?name=gitlab": () => jsonResponse({ error: envelope }, 400),
      "/api/connectors": () => jsonResponse({ error: { message: "服务器内部错误" } }, 500),
    });

    expect(
      await captureApiError(createApiClient().updateConnector("gitlab", UPDATE)),
    ).toMatchObject({ status: 400, ...envelope });
    const failed = await captureApiError(
      createApiClient().createConnector({ name: "a", type: "stdio", command: "/a" }),
    );
    expectRequestFailure(failed, 500);
  });
});

describe("两种视图严格解析", () => {
  const { updatedAt: _dropped, ...tenKeys } = GITLAB;
  const invalidAdmin: [string, unknown][] = [
    ["a missing key", tenKeys],
    ["an extra key", { ...GITLAB, env: { TOKEN: "x" } }],
    ["a name outside the name rule", { ...GITLAB, name: "git2" }],
    ["an unknown type", { ...GITLAB, type: "sse" }],
    ["a string enabled", { ...GITLAB, enabled: "true" }],
    ["stdio with a url", { ...GITLAB, url: "https://x.example" }],
    ["stdio with headerKeys", { ...GITLAB, headerKeys: [] }],
    ["stdio without a command", { ...GITLAB, command: null }],
    ["stdio with non-string args", { ...GITLAB, args: [1] }],
    ["http with a command", { ...DOCS, command: "/bin/x" }],
    ["http with envKeys", { ...DOCS, envKeys: [] }],
    ["http without headerKeys", { ...DOCS, headerKeys: null }],
    ["an unknown probe status", { ...GITLAB, probe: { ...GITLAB.probe, status: "pending" } }],
    ["a probe with an extra key", { ...GITLAB, probe: { ...GITLAB.probe, detail: "x" } }],
    ["a fractional updatedAt", { ...GITLAB, updatedAt: 1.5 }],
  ];

  it.each(invalidAdmin)(
    "an admin view with %s is request_failed on every method that returns one",
    async (_label, view) => {
      stub({
        "/api/connectors": [jsonResponse({ connectors: [DOCS, view] }), jsonResponse(view, 201)],
        "/api/connectors?name=gitlab": () => jsonResponse(view),
        "/api/connectors/probe?name=gitlab": () => jsonResponse(view),
      });
      const client = createApiClient();

      expectRequestFailure(await captureApiError(client.listConnectors()), 200);
      const create = { name: "gitlab", type: "stdio" as const, command: "/a" };
      expectRequestFailure(await captureApiError(client.createConnector(create)), 201);
      expectRequestFailure(await captureApiError(client.updateConnector("gitlab", UPDATE)), 200);
      expectRequestFailure(await captureApiError(client.probeConnector("gitlab")), 200);
    },
  );

  it("create / update / probe accept only the admin view: a three-key body is request_failed", async () => {
    stub({
      "/api/connectors": () => jsonResponse(MEMBER_ROW, 201),
      "/api/connectors?name=gitlab": () => jsonResponse(MEMBER_ROW),
      "/api/connectors/probe?name=gitlab": () => jsonResponse(MEMBER_ROW),
    });
    const client = createApiClient();

    const create = { name: "gitlab", type: "stdio" as const, command: "/a" };
    expectRequestFailure(await captureApiError(client.createConnector(create)), 201);
    expectRequestFailure(await captureApiError(client.updateConnector("gitlab", UPDATE)), 200);
    expectRequestFailure(await captureApiError(client.probeConnector("gitlab")), 200);
  });

  it.each<[string, unknown]>([
    ["a member row with an extra key", { connectors: [{ ...MEMBER_ROW, enabled: true }] }],
    ["a member row missing description", { connectors: [{ name: "gitlab", type: "stdio" }] }],
    ["a member row with a bad name", { connectors: [{ ...MEMBER_ROW, name: "Git" }] }],
    ["admin and member rows mixed", { connectors: [GITLAB, { ...MEMBER_ROW, name: "lint" }] }],
    ["an extra list key", { connectors: [], total: 0 }],
    ["no connectors key", { items: [] }],
    ["a non-array connectors", { connectors: GITLAB }],
  ])("a list body with %s is request_failed", async (_label, body) => {
    stub({ "/api/connectors": () => jsonResponse(body) });

    expectRequestFailure(await captureApiError(createApiClient().listConnectors()), 200);
  });

  it.each<[string, unknown]>([
    ["an extra key", { disabledConnectors: [], extra: 1 }],
    ["a non-array", { disabledConnectors: "gitlab" }],
    ["a bad name", { disabledConnectors: ["Git"] }],
  ])("a defaults body with %s is request_failed on GET and PUT", async (_label, body) => {
    stub({ "/api/connectors/defaults": () => jsonResponse(body) });
    const client = createApiClient();

    expectRequestFailure(await captureApiError(client.getConnectorDefaults()), 200);
    expectRequestFailure(await captureApiError(client.putConnectorDefaults([])), 200);
  });

  it("accepts an empty list, a zero probe time and a failed probe message", async () => {
    const view: ConnectorView = {
      ...GITLAB,
      probe: { status: "failed", at: 0, message: "命令不存在或不可执行" },
    };
    stub({
      "/api/connectors": [jsonResponse({ connectors: [] }), jsonResponse({ connectors: [view] })],
    });
    const client = createApiClient();

    await expect(client.listConnectors()).resolves.toEqual({ admin: true, connectors: [] });
    await expect(client.listConnectors()).resolves.toEqual({ admin: true, connectors: [view] });
  });
});
