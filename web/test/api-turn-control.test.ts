import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, createApiClient } from "../src/lib/api.js";
import {
  captureApiError,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const ENCODED_SESSION_ID = "sess/%#?+ 中";
const ENCODED_SESSION_PATH = "/api/sessions/sess%2F%25%23%3F%2B%20%E4%B8%AD";
const SAFE_INTEGER_MIN = -9_007_199_254_740_991;
const UNSAFE_INTEGER = 2 ** 53;

const stoppedSession = {
  id: SESSION_ID,
  title: "saved title",
  status: "stopped" as const,
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_023,
};

const settledApproval = {
  id: 7,
  tool: "bash",
  title: "rm -rf build",
  requestedAt: 1_740_000_000_000,
  expiresAt: 1_740_000_060_000,
  decision: "allow" as const,
};

function stubFetch(response: Response | Error) {
  const fetchMock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function envelope(status: number, code: string, message: string) {
  return jsonResponse({ error: { code, message } }, status);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Turn control API requests", () => {
  it("POSTs stop to the encoded session path without body or headers", async () => {
    const fetchMock = stubFetch(jsonResponse({}, 202));
    const controller = new AbortController();

    await expect(
      createApiClient().stopSession(ENCODED_SESSION_ID, { signal: controller.signal }),
    ).resolves.toBe("stopping");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${ENCODED_SESSION_PATH}/stop`, {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });

  it("POSTs regenerate to the encoded session path without body or headers", async () => {
    const fetchMock = stubFetch(jsonResponse({ assistantMessageId: 4 }, 202));
    const controller = new AbortController();

    await expect(
      createApiClient().regenerateSession(ENCODED_SESSION_ID, { signal: controller.signal }),
    ).resolves.toEqual({ assistantMessageId: 4 });

    expect(fetchMock).toHaveBeenCalledWith(`${ENCODED_SESSION_PATH}/regenerate`, {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });

  it("POSTs fork with exactly the JSON messageId body", async () => {
    const fetchMock = stubFetch(jsonResponse({ session: stoppedSession, draft: "" }, 201));
    const controller = new AbortController();

    await createApiClient().forkSession(ENCODED_SESSION_ID, -3, { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(`${ENCODED_SESSION_PATH}/fork`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"messageId":-3}',
      signal: controller.signal,
    });
  });

  it.each(["allow", "deny"] as const)(
    "POSTs the %s decision to the encoded approval path",
    async (decision) => {
      const fetchMock = stubFetch(jsonResponse({ ...settledApproval, decision }));
      const controller = new AbortController();

      await expect(
        createApiClient().decideApproval(ENCODED_SESSION_ID, 7, decision, {
          signal: controller.signal,
        }),
      ).resolves.toEqual({ ...settledApproval, decision });

      expect(fetchMock).toHaveBeenCalledWith(`${ENCODED_SESSION_PATH}/approvals/7`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: `{"decision":"${decision}"}`,
        signal: controller.signal,
      });
    },
  );
});

describe("Turn control stop responses", () => {
  it("resolves 204 as idle without reading the response body", async () => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, "json");
    const text = vi.spyOn(response, "text");
    stubFetch(response);

    await expect(createApiClient().stopSession(SESSION_ID)).resolves.toBe("idle");

    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-empty object", jsonResponse({ x: 1 }, 202), 202],
    ["an array", jsonResponse([], 202), 202],
    ["a non-JSON body", new Response("accepted", { status: 202 }), 202],
    ["an unexpected 200", jsonResponse({}, 200), 200],
  ] as const)("rejects %s as request_failed", async (_label, response, status) => {
    stubFetch(response);

    expectRequestFailure(await captureApiError(createApiClient().stopSession(SESSION_ID)), status);
  });

  it("keeps a 503 stop envelope", async () => {
    stubFetch(envelope(503, "agent_unavailable", "智能体暂不可用"));

    await expect(createApiClient().stopSession(SESSION_ID)).rejects.toMatchObject({
      status: 503,
      code: "agent_unavailable",
      message: "智能体暂不可用",
    });
  });

  it("maps a network failure to request_failed(0)", async () => {
    stubFetch(new TypeError("offline"));

    expectRequestFailure(await captureApiError(createApiClient().stopSession(SESSION_ID)), 0);
  });
});

describe("Turn control regenerate/fork/approval parsing", () => {
  it("returns a signed safe-integer assistantMessageId unchanged", async () => {
    stubFetch(jsonResponse({ assistantMessageId: SAFE_INTEGER_MIN }, 202));

    await expect(createApiClient().regenerateSession(SESSION_ID)).resolves.toEqual({
      assistantMessageId: SAFE_INTEGER_MIN,
    });
  });

  it.each([
    ["a missing key", {}],
    ["an extra key", { assistantMessageId: 1, userMessageId: 0 }],
    ["a fraction", { assistantMessageId: 1.5 }],
    ["an unsafe integer", { assistantMessageId: UNSAFE_INTEGER }],
  ] as const)("rejects regenerate with %s", async (_label, body) => {
    stubFetch(jsonResponse(body, 202));

    expectRequestFailure(
      await captureApiError(createApiClient().regenerateSession(SESSION_ID)),
      202,
    );
  });

  it("rejects a regenerate status other than 202", async () => {
    stubFetch(jsonResponse({ assistantMessageId: 1 }, 200));

    expectRequestFailure(
      await captureApiError(createApiClient().regenerateSession(SESSION_ID)),
      200,
    );
  });

  it.each(["", "  原文\n"])(
    "returns fork draft %j and a stopped session unchanged",
    async (draft) => {
      stubFetch(jsonResponse({ session: stoppedSession, draft }, 201));

      await expect(createApiClient().forkSession(SESSION_ID, 1)).resolves.toEqual({
        session: stoppedSession,
        draft,
      });
    },
  );

  it.each([
    ["a non-string draft", { session: stoppedSession, draft: 1 }],
    ["an extra key", { session: stoppedSession, draft: "", parentSessionId: SESSION_ID }],
    ["a missing draft", { session: stoppedSession }],
    ["a missing session", { draft: "" }],
    ["an extra session key", { session: { ...stoppedSession, parent_session_id: "p" }, draft: "" }],
    ["an unknown session status", { session: { ...stoppedSession, status: "pending" }, draft: "" }],
  ] as const)("rejects fork with %s", async (_label, body) => {
    stubFetch(jsonResponse(body, 201));

    expectRequestFailure(await captureApiError(createApiClient().forkSession(SESSION_ID, 1)), 201);
  });

  it.each(["allow", "deny", "timeout"] as const)(
    "returns a settled %s approval unchanged",
    async (decision) => {
      stubFetch(jsonResponse({ ...settledApproval, decision }));

      await expect(createApiClient().decideApproval(SESSION_ID, 7, "allow")).resolves.toEqual({
        ...settledApproval,
        decision,
      });
    },
  );

  it.each([
    ["a null decision", { ...settledApproval, decision: null }],
    ["an unknown decision", { ...settledApproval, decision: "maybe" }],
    ["a missing key", { ...settledApproval, expiresAt: undefined }],
    ["an extra key", { ...settledApproval, sessionId: SESSION_ID }],
    ["an unsafe id", { ...settledApproval, id: UNSAFE_INTEGER }],
    ["a fractional requestedAt", { ...settledApproval, requestedAt: 1.5 }],
    ["an unsafe expiresAt", { ...settledApproval, expiresAt: UNSAFE_INTEGER }],
    ["a non-string tool", { ...settledApproval, tool: 1 }],
    ["a non-string title", { ...settledApproval, title: null }],
  ] as const)("rejects an approval with %s", async (_label, body) => {
    stubFetch(jsonResponse(body));

    expectRequestFailure(
      await captureApiError(createApiClient().decideApproval(SESSION_ID, 7, "allow")),
      200,
    );
  });

  it("accepts signed safe-integer approval ids and timestamps", async () => {
    const signed = { ...settledApproval, id: -1, requestedAt: -5, expiresAt: SAFE_INTEGER_MIN };
    stubFetch(jsonResponse(signed));

    await expect(createApiClient().decideApproval(SESSION_ID, -1, "deny")).resolves.toEqual(signed);
  });
});

describe("Stopped status in sessions and snapshots", () => {
  const stoppedSnapshot = {
    session: stoppedSession,
    messages: [
      {
        id: -3,
        role: "user" as const,
        content: "hi",
        status: "done" as const,
        createdAt: -1,
        steps: [],
      },
      {
        id: 0,
        role: "assistant" as const,
        content: "partial",
        status: "stopped" as const,
        createdAt: 0,
        steps: [
          {
            id: 2,
            ordinal: 0,
            name: "bash",
            detail: "ls",
            output: "o",
            status: "stopped" as const,
          },
        ],
      },
    ],
    streamCursor: { epoch: 1, seq: 7 },
  };

  it("lists a stopped session unchanged", async () => {
    stubFetch(jsonResponse({ sessions: [stoppedSession] }));

    await expect(createApiClient().listSessions()).resolves.toEqual({
      sessions: [stoppedSession],
    });
  });

  it("keeps stopped session, message and step statuses in a snapshot", async () => {
    stubFetch(jsonResponse(stoppedSnapshot));

    await expect(createApiClient().getMessages(SESSION_ID)).resolves.toEqual(stoppedSnapshot);
  });

  it("rejects the whole snapshot when a step status is unknown", async () => {
    const [user, assistant] = stoppedSnapshot.messages;
    const cancelled = {
      ...stoppedSnapshot,
      messages: [
        user,
        { ...assistant, steps: assistant?.steps.map((step) => ({ ...step, status: "cancelled" })) },
      ],
    };
    stubFetch(jsonResponse(cancelled));

    expectRequestFailure(await captureApiError(createApiClient().getMessages(SESSION_ID)), 200);
  });
});

describe("Turn control error envelopes", () => {
  const cases: ReadonlyArray<
    readonly [string, number, string, (client: ApiClient) => Promise<unknown>]
  > = [
    ["prompt", 503, "agent_capacity", (client) => client.prompt(SESSION_ID, "hi")],
    ["regenerate", 503, "agent_capacity", (client) => client.regenerateSession(SESSION_ID)],
    ["regenerate", 409, "session_busy", (client) => client.regenerateSession(SESSION_ID)],
    ["regenerate", 400, "bad_request", (client) => client.regenerateSession(SESSION_ID)],
    ["fork", 409, "session_busy", (client) => client.forkSession(SESSION_ID, 1)],
    ["fork", 400, "bad_request", (client) => client.forkSession(SESSION_ID, 1)],
    [
      "approvals",
      409,
      "approval_settled",
      (client) => client.decideApproval(SESSION_ID, 7, "deny"),
    ],
  ];

  it.each(cases)("keeps the %s %i %s envelope", async (_name, status, code, call) => {
    const message = `${code} 文案`;
    stubFetch(envelope(status, code, message));
    const onUnauthorized = vi.fn();

    await expect(call(createApiClient({ onUnauthorized }))).rejects.toMatchObject({
      status,
      code,
      message,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  const unauthorizedCalls: ReadonlyArray<
    readonly [string, (client: ApiClient, signal: AbortSignal) => Promise<unknown>]
  > = [
    ["stop", (client, signal) => client.stopSession(SESSION_ID, { signal })],
    ["approvals", (client, signal) => client.decideApproval(SESSION_ID, 7, "allow", { signal })],
  ];

  for (const [name, call] of unauthorizedCalls) {
    it.each(unauthorizedResponseCases())(
      `notifies once on %s 401 for ${name}`,
      async (_label, response) => {
        stubFetch(response.clone());
        const onUnauthorized = vi.fn();
        const controller = new AbortController();

        const error = await captureApiError(
          call(createApiClient({ onUnauthorized }), controller.signal),
        );

        expect(error.status).toBe(401);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        expect(onUnauthorized).toHaveBeenCalledWith(controller.signal);
      },
    );
  }
});
