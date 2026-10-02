/**
 * Issue 556 (parent tasks 10.5) `listCommands()` over an injected fetch: A1–A4 of
 * openspec/changes/slash-command-menu/design.md. Seam: the real `createApiClient` over a stubbed
 * `fetch`. Oracles: the path, the request options and the five-key element of the spec delta, and
 * the body the server sends (server/src/sessions/rest-commands.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { CATALOGUE, COMMANDS, skill, untilAborted, WEEKLY } from "./chat-page-slash-support.js";
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

/** The failure of `listCommands()` against a 200 response carrying `body`. */
function rejection(body: unknown) {
  stubCommands(jsonResponse(body));
  return captureApiError(createApiClient().listCommands());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listCommands (A1–A4)", () => {
  it("A1 GETs /api/commands without a query, a body or a cache and returns the commands in order", async () => {
    const fetchMock = stubCommands(jsonResponse({ commands: FOUR }));

    const commands = await createApiClient().listCommands();

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
    });
    expect(commands[3]?.hint).toBeNull();
    expect(fetchMock.mock.calls).toEqual([
      ["/api/commands", { method: "GET", credentials: "same-origin", cache: "no-store" }],
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("A1 returns an empty catalogue as an empty array", async () => {
    stubCommands(jsonResponse({ commands: [] }));

    await expect(createApiClient().listCommands()).resolves.toEqual([]);
  });

  it.each([
    ["an element without hint", [{ ...WEEKLY, hint: undefined }]],
    ["a numeric hint", [{ ...WEEKLY, hint: 1 }]],
    ["the source extension", [{ ...WEEKLY, source: "extension" }]],
    ["an element with a sixth key", [{ ...WEEKLY, enabled: true }]],
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
        createApiClient({ onUnauthorized }).listCommands({ signal }),
      );

      expect(error.status).toBe(401);
      expect(error.code).toBe(kind === "a legal" ? "unauthorized" : "request_failed");
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(onUnauthorized).toHaveBeenCalledWith(signal);
    },
  );

  it("A3 keeps the envelope of a 400 and fails a non-JSON 500 and a 201 as request_failed", async () => {
    const onUnauthorized = vi.fn();
    const list = () => captureApiError(createApiClient({ onUnauthorized }).listCommands());

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

    const pending = captureApiError(createApiClient().listCommands({ signal: controller.signal }));
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
});
