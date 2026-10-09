/**
 * Issue #517 (parent s1c tasks 5.1) session metadata client methods over an injected fetch:
 * `createSession(input?, options?)` body/header shape and cancellation, `patchSession` PATCH
 * shape, empty-patch TypeError and envelopes, `deleteSession` 204/200 branches, envelopes and the
 * unauthorized notification. Oracles: the spec delta's literal paths, bodies and statuses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import {
  captureApiError,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const WORKSPACE_ID = "fedcba9876543210fedcba9876543210";
const ENCODED_SESSION_ID = "sess/%#?+ 中";
const ENCODED_SESSION_PATH = "/api/sessions/sess%2F%25%23%3F%2B%20%E4%B8%AD";

const legacySession = {
  id: SESSION_ID,
  title: null,
  status: "idle",
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_000,
};

const createdSession = {
  ...legacySession,
  ...NULL_SESSION_META,
  scene: "code",
  workspaceId: WORKSPACE_ID,
};

const patchedSession = {
  ...legacySession,
  title: "周报",
  updatedAt: 1_740_000_000_050,
  ...NULL_SESSION_META,
  pinnedAt: 1_740_000_000_050,
};

/** Every request resolves to `response`; the returned mock records the calls. */
function stubFetch(response: Response) {
  const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function unreadableResponse(status: number) {
  const unreadable = () => {
    throw new Error("response body must not be read");
  };
  return {
    status,
    json: vi.fn(unreadable),
    text: vi.fn(unreadable),
  } as unknown as Response & { json: ReturnType<typeof vi.fn>; text: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Session metadata client: createSession", () => {
  it.each([
    ["no input", undefined],
    ["an empty input", {}],
  ])("creates with %s without a body or content type", async (_label, input) => {
    const fetchMock = stubFetch(jsonResponse({ ...legacySession, ...NULL_SESSION_META }, 201));

    await expect(createApiClient().createSession(input)).resolves.toEqual({
      ...legacySession,
      ...NULL_SESSION_META,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      credentials: "same-origin",
    });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });

  it.each([
    [
      "workspace and scene",
      { workspaceId: WORKSPACE_ID, scene: "code" } as const,
      `{"workspaceId":"${WORKSPACE_ID}","scene":"code"}`,
    ],
    ["scene only", { scene: "code" } as const, '{"scene":"code"}'],
  ])("sends %s as exact JSON and returns the eleven-key session", async (_label, input, body) => {
    const fetchMock = stubFetch(jsonResponse(createdSession, 201));

    await expect(createApiClient().createSession(input)).resolves.toEqual(createdSession);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body,
    });
  });

  it("sends the three composer keys as exact JSON and returns them unchanged", async () => {
    const composerSession = {
      ...createdSession,
      scene: null,
      approvalMode: "always-ask",
      modelId: "m3",
      reasoningEffort: "low",
    };
    const fetchMock = stubFetch(jsonResponse(composerSession, 201));

    await expect(
      createApiClient().createSession({
        workspaceId: WORKSPACE_ID,
        approvalMode: "always-ask",
        modelId: "m3",
        reasoningEffort: "low",
      }),
    ).resolves.toEqual(composerSession);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: `{"workspaceId":"${WORKSPACE_ID}","approvalMode":"always-ask","modelId":"m3","reasoningEffort":"low"}`,
    });
  });

  it("passes the signal and rejects with the existing cancellation failure after abort", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = captureApiError(
      createApiClient().createSession(undefined, { signal: controller.signal }),
    );
    controller.abort();

    expectRequestFailure(await pending, 0);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("rejects a legacy five-key 201 as an invalid response", async () => {
    stubFetch(jsonResponse(legacySession, 201));

    expectRequestFailure(await captureApiError(createApiClient().createSession()), 201);
  });
});

describe("Session metadata client: patchSession", () => {
  it("PATCHes the encoded path with the exact JSON and returns the eleven-key session", async () => {
    const fetchMock = stubFetch(jsonResponse(patchedSession));
    const controller = new AbortController();

    await expect(
      createApiClient().patchSession(
        ENCODED_SESSION_ID,
        { title: "周报", pinned: true },
        { signal: controller.signal },
      ),
    ).resolves.toEqual(patchedSession);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(ENCODED_SESSION_PATH, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"title":"周报","pinned":true}',
      signal: controller.signal,
    });
  });

  it("sends a pin-only patch as exactly that JSON", async () => {
    const fetchMock = stubFetch(jsonResponse(patchedSession));

    await createApiClient().patchSession(SESSION_ID, { pinned: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/sessions/${SESSION_ID}`);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"pinned":true}');
  });

  it("sends an archive-only patch as exactly that JSON", async () => {
    const fetchMock = stubFetch(jsonResponse(patchedSession));

    await createApiClient().patchSession(SESSION_ID, { archived: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/sessions/${SESSION_ID}`);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"archived":true}');
  });

  it("sends an approval-mode-only patch as exactly that JSON", async () => {
    const fetchMock = stubFetch(jsonResponse({ ...patchedSession, approvalMode: "yolo" }));

    await expect(
      createApiClient().patchSession(SESSION_ID, { approvalMode: "yolo" }),
    ).resolves.toEqual({ ...patchedSession, approvalMode: "yolo" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/sessions/${SESSION_ID}`);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"approvalMode":"yolo"}');
  });

  it("rejects an empty patch with TypeError without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(() => createApiClient().patchSession(SESSION_ID, {})).rejects.toBeInstanceOf(
      TypeError,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, "bad_request", "请求格式不正确"],
    [404, "not_found", "请求的资源不存在"],
  ] as const)("preserves a %s %s envelope", async (status, code, message) => {
    stubFetch(jsonResponse({ error: { code, message } }, status));

    const error = await captureApiError(
      createApiClient().patchSession(SESSION_ID, { title: "周报" }),
    );

    expect(error).toMatchObject({ name: "ApiError", status, code, message });
  });

  it("rejects a legacy five-key 200 as an invalid response", async () => {
    stubFetch(jsonResponse(legacySession));

    const error = await captureApiError(
      createApiClient().patchSession(SESSION_ID, { pinned: true }),
    );

    expectRequestFailure(error, 200);
  });
});

describe("Session metadata client: deleteSession", () => {
  it("DELETEs the encoded path without a body and resolves 204 without reading it", async () => {
    const response = unreadableResponse(204);
    const fetchMock = stubFetch(response);
    const controller = new AbortController();

    await expect(
      createApiClient().deleteSession(ENCODED_SESSION_ID, { signal: controller.signal }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(ENCODED_SESSION_PATH, {
      method: "DELETE",
      credentials: "same-origin",
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
    expect(response.json).not.toHaveBeenCalled();
    expect(response.text).not.toHaveBeenCalled();
  });

  it("rejects an unexpected 200 as an invalid response", async () => {
    stubFetch(jsonResponse({}, 200));

    expectRequestFailure(await captureApiError(createApiClient().deleteSession(SESSION_ID)), 200);
  });

  it.each([
    [404, "not_found", "请求的资源不存在"],
    [409, "session_busy", "会话正在生成，请稍候"],
  ] as const)("preserves a %s %s envelope", async (status, code, message) => {
    stubFetch(jsonResponse({ error: { code, message } }, status));

    const error = await captureApiError(createApiClient().deleteSession(SESSION_ID));

    expect(error).toMatchObject({ name: "ApiError", status, code, message });
  });

  it.each(unauthorizedResponseCases())(
    "notifies unauthorized once for %s 401",
    async (kind, response) => {
      const onUnauthorized = vi.fn();
      const controller = new AbortController();
      stubFetch(response);

      const error = await captureApiError(
        createApiClient({ onUnauthorized }).deleteSession(SESSION_ID, {
          signal: controller.signal,
        }),
      );

      if (kind === "a legal") {
        expect(error).toMatchObject({ status: 401, code: "unauthorized", message: "登录已失效" });
      } else {
        expectRequestFailure(error, 401);
      }
      expect(onUnauthorized.mock.calls).toEqual([[controller.signal]]);
    },
  );
});
