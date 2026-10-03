/**
 * Issue 556 (parent tasks 10.5) `listCommands()` over an injected fetch: A1–A4 of
 * openspec/changes/slash-command-menu/design.md, and issue 814 `listCommands(workspaceId)`: A5 and
 * the six-key element of openspec/changes/project-config-surface (chat-web 命令目录方法). Seam: the
 * real `createApiClient` over a stubbed `fetch`. Oracles: the path, the request options and the
 * element of the spec delta, and the body the server sends (server/src/sessions/rest-commands.ts).
 * Issue 816 `listProjectConfig(workspaceId)`: F1–F3 of the same scenario, against the body of
 * server/src/sessions/rest-project-config.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import {
  CATALOGUE,
  COMMANDS,
  commandsOf,
  project,
  skill,
  untilAborted,
  WEEKLY,
} from "./chat-page-slash-support.js";
import {
  captureApiError,
  createFetchMock,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

/** Two builtins, `skill:weekly-report` and a command without a hint. */
const FOUR = [...CATALOGUE, skill("plain", "", null)];

/** Answers every `/api/commands` request with `response`; any other path fails the case. */
function stubCommands(response: Response) {
  const fetchMock = createFetchMock({ [COMMANDS]: () => response });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The failure of `listCommands(null)` against a 200 response carrying `body`. */
function rejection(body: unknown) {
  stubCommands(jsonResponse(body));
  return captureApiError(createApiClient().listCommands(null));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listCommands (A1–A5)", () => {
  it("A1 null GETs /api/commands without a query, a body or a cache and returns the commands in order", async () => {
    const fetchMock = stubCommands(jsonResponse({ commands: FOUR }));

    const commands = await createApiClient().listCommands(null);

    expect(commands).toEqual(FOUR);
    expect(commands.map((command) => command.name)).toEqual([
      "compact",
      "todo",
      "skill:weekly-report",
      "skill:plain",
    ]);
    expect(commands[2]).toEqual({
      name: "skill:weekly-report",
      label: "weekly-report",
      description: "写周报",
      hint: "可选参数",
      source: "skill",
      overrides: false,
    });
    expect(commands[3]?.hint).toBeNull();
    expect(fetchMock.mock.calls).toEqual([
      ["/api/commands", { method: "GET", credentials: "same-origin", cache: "no-store" }],
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("A1 returns an empty catalogue as an empty array", async () => {
    stubCommands(jsonResponse({ commands: [] }));

    await expect(createApiClient().listCommands(null)).resolves.toEqual([]);
  });

  it.each([
    ["an element without hint", [{ ...WEEKLY, hint: undefined }]],
    ["a numeric hint", [{ ...WEEKLY, hint: 1 }]],
    ["an element without overrides", [{ ...WEEKLY, overrides: undefined }]],
    ["overrides as a string", [{ ...WEEKLY, overrides: "false" }]],
    ["a null overrides", [{ ...WEEKLY, overrides: null }]],
    ["the source extension", [{ ...WEEKLY, source: "extension" }]],
    ["an element with a seventh key", [{ ...WEEKLY, enabled: true }]],
    ["a name that is not a string", [{ ...WEEKLY, name: 7 }]],
    ["a label that is not a string", [{ ...WEEKLY, label: null }]],
    ["a description that is not a string", [{ ...WEEKLY, description: ["写周报"] }]],
    ["an element that is not an object", ["skill:weekly-report"]],
    ["a null element", [null]],
  ])("A2 rejects the whole catalogue for %s after valid elements", async (_label, invalid) => {
    expectRequestFailure(await rejection({ commands: [...CATALOGUE, ...invalid] }), 200);
  });

  it.each([
    ["a second body key", { commands: CATALOGUE, total: 3 }],
    ["commands that are not an array", { commands: { 0: WEEKLY } }],
    ["a body without commands", {}],
    ["an array body", CATALOGUE],
    ["a null body", null],
    ["a string body", "commands"],
  ])("A2 rejects %s", async (_label, body) => {
    expectRequestFailure(await rejection(body), 200);
  });

  it.each(unauthorizedResponseCases())(
    "A3 notifies unauthorized once for %s 401",
    async (kind, response) => {
      const onUnauthorized = vi.fn();
      const { signal } = new AbortController();
      stubCommands(response);

      const error = await captureApiError(
        createApiClient({ onUnauthorized }).listCommands(null, { signal }),
      );

      expect(error.status).toBe(401);
      expect(error.code).toBe(kind === "a legal" ? "unauthorized" : "request_failed");
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(onUnauthorized).toHaveBeenCalledWith(signal);
    },
  );

  it("A3 keeps the envelope of a 400 and fails a non-JSON 500 and a 201 as request_failed", async () => {
    const onUnauthorized = vi.fn();
    const list = () => captureApiError(createApiClient({ onUnauthorized }).listCommands(null));

    stubCommands(jsonResponse({ error: { code: "bad_request", message: "请求格式不正确" } }, 400));
    expect(await list()).toMatchObject({
      status: 400,
      code: "bad_request",
      message: "请求格式不正确",
    });

    stubCommands(new Response("private response body", { status: 500 }));
    expectRequestFailure(await list(), 500);

    stubCommands(jsonResponse({ commands: CATALOGUE }, 201));
    expectRequestFailure(await list(), 201);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("A4 passes the signal and rejects with the existing cancellation failure after abort", async () => {
    const controller = new AbortController();
    const fetchMock = createFetchMock({ [COMMANDS]: untilAborted });
    vi.stubGlobal("fetch", fetchMock);

    const pending = captureApiError(
      createApiClient().listCommands(null, { signal: controller.signal }),
    );
    controller.abort();

    expectRequestFailure(await pending, 0);
    expect(fetchMock.mock.calls).toEqual([
      [
        COMMANDS,
        {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        },
      ],
    ]);
  });

  it("A5 a workspace id GETs /api/commands?workspaceId=<id> and keeps the project entries as sent", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const body = [...CATALOGUE, project("deploy", "部署到测试环境", true)];
    const { signal } = new AbortController();
    const fetchMock = createFetchMock({ [commandsOf(id)]: () => jsonResponse({ commands: body }) });
    vi.stubGlobal("fetch", fetchMock);

    const commands = await createApiClient().listCommands(id, { signal });

    expect(commands).toEqual(body);
    expect(commands[3]).toEqual({
      name: "skill:deploy",
      label: "deploy",
      description: "部署到测试环境",
      hint: "可选参数",
      source: "project",
      overrides: true,
    });
    expect(fetchMock.mock.calls).toEqual([
      [
        `/api/commands?workspaceId=${id}`,
        { method: "GET", credentials: "same-origin", cache: "no-store", signal },
      ],
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("A5 the workspace id is encoded into the query string", async () => {
    const path = "/api/commands?workspaceId=a%20b%26c%3Dd%2F%E4%B8%AD";
    const fetchMock = createFetchMock({ [path]: () => jsonResponse({ commands: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApiClient().listCommands("a b&c=d/中")).resolves.toEqual([]);

    expect(fetchMock.mock.calls.map(([called]) => called)).toEqual([path]);
  });

  it("A5 a 404 for a workspace id keeps its envelope and a 401 notifies unauthorized", async () => {
    const id = "f".repeat(32);
    const onUnauthorized = vi.fn();
    const answers = [
      jsonResponse({ error: { code: "not_found", message: "资源不存在" } }, 404),
      jsonResponse({ error: { code: "unauthorized", message: "未登录" } }, 401),
    ];
    vi.stubGlobal("fetch", createFetchMock({ [commandsOf(id)]: answers }));
    const list = () => captureApiError(createApiClient({ onUnauthorized }).listCommands(id));

    expect(await list()).toMatchObject({ status: 404, code: "not_found", message: "资源不存在" });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(await list()).toMatchObject({ status: 401, code: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

const CONFIG = "/api/project-config";
/** The files of the spec scenario 项目配置入口, as the server orders them. */
const FILES = [
  { path: ".omp/RULES.md", kind: "instructions", depth: 0 },
  { path: ".omp/SYSTEM.md", kind: "system", depth: 0 },
  { path: "AGENTS.md", kind: "instructions", depth: 1 },
  { path: ".omp/agents/reviewer.md", kind: "agent", depth: 2 },
];
const [RULES] = FILES;

/** The failure of `listProjectConfig(null)` against a 200 response carrying `body`. */
function configRejection(body: unknown) {
  vi.stubGlobal("fetch", createFetchMock({ [CONFIG]: () => jsonResponse(body) }));
  return captureApiError(createApiClient().listProjectConfig(null));
}

describe("listProjectConfig (F1–F3)", () => {
  it("F1 null GETs /api/project-config without a query, a body or a cache; a workspace id adds only workspaceId=<id>, encoded", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const encoded = `${CONFIG}?workspaceId=a%20b%26c%3Dd%2F%E4%B8%AD`;
    const { signal } = new AbortController();
    const fetchMock = createFetchMock({
      [CONFIG]: () => jsonResponse({ files: [] }),
      [`${CONFIG}?workspaceId=${id}`]: () => jsonResponse({ files: FILES }),
      [encoded]: () => jsonResponse({ files: [RULES] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient();

    await expect(client.listProjectConfig(null)).resolves.toEqual([]);
    const files = await client.listProjectConfig(id, { signal });
    await expect(client.listProjectConfig("a b&c=d/中")).resolves.toEqual([RULES]);

    expect(files).toEqual(FILES);
    expect(files.map((file) => `${file.depth}:${file.path}:${file.kind}`)).toEqual([
      "0:.omp/RULES.md:instructions",
      "0:.omp/SYSTEM.md:system",
      "1:AGENTS.md:instructions",
      "2:.omp/agents/reviewer.md:agent",
    ]);
    expect(fetchMock.mock.calls).toEqual([
      ["/api/project-config", { method: "GET", credentials: "same-origin", cache: "no-store" }],
      [
        `/api/project-config?workspaceId=${id}`,
        { method: "GET", credentials: "same-origin", cache: "no-store", signal },
      ],
      [encoded, { method: "GET", credentials: "same-origin", cache: "no-store" }],
    ]);
    for (const [, options] of fetchMock.mock.calls) expect(options).not.toHaveProperty("body");
  });

  it.each([
    ["an unknown kind", [{ ...RULES, kind: "rules" }]],
    ["a negative depth", [{ ...RULES, depth: -1 }]],
    ["a fractional depth", [{ ...RULES, depth: 0.5 }]],
    ["an unsafe depth", [{ ...RULES, depth: 2 ** 53 }]],
    ["a depth that is a string", [{ ...RULES, depth: "0" }]],
    ["an element with a fourth key", [{ ...RULES, size: 12 }]],
    ["an element without depth", [{ path: "AGENTS.md", kind: "instructions" }]],
    ["an empty path", [{ ...RULES, path: "" }]],
    ["a path that is not a string", [{ ...RULES, path: 7 }]],
    ["a null element", [null]],
  ])("F2 rejects the whole list for %s after valid elements", async (_label, invalid) => {
    expectRequestFailure(await configRejection({ files: [...FILES, ...invalid] }), 200);
  });

  it.each([
    ["a second body key", { files: FILES, total: 4 }],
    ["files that are not an array", { files: { 0: RULES } }],
    ["a body without files", {}],
    ["the body of the command catalogue", { commands: [] }],
    ["an array body", FILES],
    ["a null body", null],
  ])("F2 rejects %s", async (_label, body) => {
    expectRequestFailure(await configRejection(body), 200);
  });

  it("F3 a 401 notifies unauthorized once, a 404 keeps its envelope and an aborted call fails as cancelled", async () => {
    const missing = `${CONFIG}?workspaceId=${"e".repeat(32)}`;
    const onUnauthorized = vi.fn();
    const fetchMock = createFetchMock({
      [missing]: () => jsonResponse({ error: { code: "not_found", message: "资源不存在" } }, 404),
      [`${CONFIG}?workspaceId=expired`]: () =>
        jsonResponse({ error: { code: "unauthorized", message: "未登录" } }, 401),
      [CONFIG]: untilAborted,
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient({ onUnauthorized });
    const controller = new AbortController();

    const notFound = await captureApiError(client.listProjectConfig("e".repeat(32)));
    expect([notFound.status, notFound.code, notFound.message]).toEqual([
      404,
      "not_found",
      "资源不存在",
    ]);
    expect(onUnauthorized).not.toHaveBeenCalled();

    const unauthorized = await captureApiError(client.listProjectConfig("expired"));
    expect([unauthorized.status, unauthorized.code]).toEqual([401, "unauthorized"]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    const pending = captureApiError(client.listProjectConfig(null, { signal: controller.signal }));
    controller.abort();
    expectRequestFailure(await pending, 0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
