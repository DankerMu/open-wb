/**
 * s1d-experts-skills 任务 9.2：`web/src/lib/api-session-capabilities.ts` 的 `getSessionCapabilities` /
 * `putSessionCapabilities`（design D7：`GET` / `PUT /api/sessions/:id/capabilities`，应答恰为
 * `{expertId: string | null, disabledSkills: string[], disabledConnectors: string[]}`——s1d-connectors 起三键，旧的两键
 * 应答被拒），以及 `createSession` input 的两个新键（session-sidebar
 * 「会话 DTO 严格解析」场景「客户端方法」）。接缝：真实的 `createApiClient` 加替身 `fetch`。期望值取自规格与
 * 服务端 `server/src/sessions/rest-capabilities.ts` 的应答形状。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import {
  captureApiError,
  createFetchMock,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

const ODD_ID = "sess/%#?+ 中";
const ODD_PATH = "/api/sessions/sess%2F%25%23%3F%2B%20%E4%B8%AD/capabilities";
const ANSWER = {
  expertId: "builtin:test-engineer",
  disabledSkills: ["deploy"],
  disabledConnectors: ["gitlab"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub(routes: Parameters<typeof createFetchMock>[0]) {
  const fetchMock = createFetchMock(routes);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getSessionCapabilities", () => {
  it("GETs the encoded capabilities path without a body and returns the answer as given", async () => {
    const fetchMock = stub({ [ODD_PATH]: () => jsonResponse(ANSWER) });

    await expect(createApiClient().getSessionCapabilities(ODD_ID)).resolves.toEqual(ANSWER);
    expect(fetchMock.mock.calls).toEqual([
      [ODD_PATH, { method: "GET", credentials: "same-origin", cache: "no-store" }],
    ]);
  });

  it("accepts no expert and empty disabled lists", async () => {
    const none = { expertId: null, disabledSkills: [], disabledConnectors: [] };
    stub({ [ODD_PATH]: () => jsonResponse(none) });

    await expect(createApiClient().getSessionCapabilities(ODD_ID)).resolves.toEqual(none);
  });
});

describe("putSessionCapabilities", () => {
  it.each([
    ["an expert", { expertId: "builtin:test-engineer" }, '{"expertId":"builtin:test-engineer"}'],
    ["no expert", { expertId: null }, '{"expertId":null}'],
  ])("PUTs %s as exact JSON to the encoded path and returns the answer", async (_l, body, json) => {
    const fetchMock = stub({ [ODD_PATH]: () => jsonResponse(ANSWER) });

    await expect(createApiClient().putSessionCapabilities(ODD_ID, body)).resolves.toEqual(ANSWER);
    expect(fetchMock.mock.calls).toEqual([
      [
        ODD_PATH,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: json,
        },
      ],
    ]);
  });

  it("an envelope keeps status, code and message", async () => {
    const archived = { code: "session_archived", message: "会话已归档" };
    stub({ [ODD_PATH]: () => jsonResponse({ error: archived }, 409) });

    expect(
      await captureApiError(createApiClient().putSessionCapabilities(ODD_ID, { expertId: null })),
    ).toMatchObject({ status: 409, ...archived });
  });

  it.each(unauthorizedResponseCases())("notifies unauthorized for %s 401", async (_k, response) => {
    const onUnauthorized = vi.fn();
    stub({ [ODD_PATH]: () => response });

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).putSessionCapabilities(ODD_ID, { expertId: null }),
    );

    expect(error.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("会话能力应答严格解析", () => {
  it.each([
    ["no expertId", { disabledSkills: [], disabledConnectors: [] }],
    ["no disabledSkills", { expertId: null, disabledConnectors: [] }],
    ["the old two-key shape (no disabledConnectors)", { expertId: null, disabledSkills: [] }],
    ["a non-array disabledConnectors", { ...ANSWER, disabledConnectors: "gitlab" }],
    ["a null disabledConnectors", { ...ANSWER, disabledConnectors: null }],
    ["a numeric connector name", { ...ANSWER, disabledConnectors: ["gitlab", 1] }],
    ["an extra key", { ...ANSWER, sessionId: "a" }],
    ["a numeric expertId", { ...ANSWER, expertId: 1 }],
    ["an undefined-like expertId", { ...ANSWER, expertId: false }],
    ["a non-array disabledSkills", { ...ANSWER, disabledSkills: "deploy" }],
    ["a numeric disabled name", { ...ANSWER, disabledSkills: ["deploy", 1] }],
    ["an array answer", [ANSWER]],
  ])("an answer with %s is request_failed on both methods", async (_label, body) => {
    stub({ [ODD_PATH]: () => jsonResponse(body) });
    const client = createApiClient();

    expectRequestFailure(await captureApiError(client.getSessionCapabilities(ODD_ID)), 200);
    expectRequestFailure(
      await captureApiError(client.putSessionCapabilities(ODD_ID, { expertId: null })),
      200,
    );
  });
});

describe("createSession 的专家与停用技能两键", () => {
  it("sends exactly scene, expertId and disabledSkills and still parses the fourteen-key session", async () => {
    const created = {
      id: "0123456789abcdef0123456789abcdef",
      title: null,
      status: "idle",
      createdAt: 1_740_000_000_000,
      updatedAt: 1_740_000_000_000,
      ...NULL_SESSION_META,
      scene: "office",
    };
    const fetchMock = stub({ "/api/sessions": () => jsonResponse(created, 201) });

    await expect(
      createApiClient().createSession({
        scene: "office",
        expertId: "builtin:test-engineer",
        disabledSkills: ["deploy"],
      }),
    ).resolves.toEqual(created);
    expect(fetchMock.mock.calls).toEqual([
      [
        "/api/sessions",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: '{"scene":"office","expertId":"builtin:test-engineer","disabledSkills":["deploy"]}',
        },
      ],
    ]);
  });
});
