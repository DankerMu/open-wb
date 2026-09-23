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
const ENCODED_SESSION_PATH = "sess%2F%25%23%3F%2B%20%E4%B8%AD";
const PROMPT_TEXT = "  keep spaces \u0000\uFEFF中文 😀 ";
const SNAPSHOT_CONTENT = "\u0000\uFEFFKeep BOM 中文 😀";
const SAFE_INTEGER_MAX = 9_007_199_254_740_991;
const UNSAFE_INTEGER = 9_007_199_254_740_992;

const idleSession = {
  id: SESSION_ID,
  title: null,
  status: "idle" as const,
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_000,
};

const runningSession = {
  ...idleSession,
  title: "saved title",
  status: "running" as const,
  updatedAt: 1_740_000_000_023,
};

const snapshotStep = {
  id: -7,
  ordinal: 0,
  name: "first work",
  detail: SNAPSHOT_CONTENT,
  status: "running" as const,
};

const snapshot = {
  session: runningSession,
  messages: [
    {
      id: -3,
      role: "user" as const,
      content: SNAPSHOT_CONTENT,
      status: "done" as const,
      createdAt: -1,
      steps: [],
    },
    {
      id: 0,
      role: "assistant" as const,
      content: "",
      status: "running" as const,
      createdAt: 0,
      steps: [snapshotStep],
    },
  ],
  streamCursor: { epoch: 1, seq: null as number | null },
};

const promptAccepted = {
  userMessageId: -3,
  assistantMessageId: 0,
};

const sessionMethods = [
  [
    "listSessions",
    (client: ApiClient, options?: { signal?: AbortSignal }) => client.listSessions(options),
    200,
    { sessions: [idleSession] },
  ],
  [
    "createSession",
    (client: ApiClient, options?: { signal?: AbortSignal }) => client.createSession(options),
    201,
    idleSession,
  ],
  [
    "getMessages",
    (client: ApiClient, options?: { signal?: AbortSignal }) =>
      client.getMessages(SESSION_ID, options),
    200,
    snapshot,
  ],
  [
    "prompt",
    (client: ApiClient, options?: { signal?: AbortSignal }) =>
      client.prompt(SESSION_ID, PROMPT_TEXT, options),
    202,
    promptAccepted,
  ],
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sessions API client list contract", () => {
  it("lists typed sessions with the no-store same-origin request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sessions: [idleSession] }));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApiClient().listSessions({ signal: controller.signal })).resolves.toEqual({
      sessions: [idleSession],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
  });
});

describe("Sessions API client create contract", () => {
  it("creates a session with no body or content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(idleSession, 201));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApiClient().createSession({ signal: controller.signal })).resolves.toEqual(
      idleSession,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });
});

describe("Sessions API client history contract", () => {
  it("encodes the session id and preserves the complete typed snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(snapshot));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createApiClient().getMessages(ENCODED_SESSION_ID, { signal: controller.signal }),
    ).resolves.toEqual(snapshot);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/${ENCODED_SESSION_PATH}/messages`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
  });

  it("preserves a numeric zero stream cursor without converting it to null", async () => {
    const zeroCursorSnapshot = {
      ...snapshot,
      streamCursor: { epoch: 1, seq: 0 },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(zeroCursorSnapshot)));

    await expect(createApiClient().getMessages(SESSION_ID)).resolves.toEqual(zeroCursorSnapshot);
  });
});

describe("Sessions API client prompt contract", () => {
  it("posts the exact prompt JSON with the encoded session id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(promptAccepted, 202));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createApiClient().prompt(ENCODED_SESSION_ID, PROMPT_TEXT, { signal: controller.signal }),
    ).resolves.toEqual(promptAccepted);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/${ENCODED_SESSION_PATH}/prompt`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"message":"  keep spaces \\u0000\uFEFF中文 😀 "}',
      signal: controller.signal,
    });
  });
});

describe("Sessions API client snapshot domain contract", () => {
  it.each([
    ["idle", "idle"],
    ["running", "running"],
    ["done", "done"],
    ["failed", "failed"],
  ] as const)("accepts session status %s", async (_label, status) => {
    const session = { ...idleSession, status };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ sessions: [session] })));

    await expect(createApiClient().listSessions()).resolves.toEqual({ sessions: [session] });
  });

  it("accepts a nonempty session title", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(runningSession, 201)));

    await expect(createApiClient().createSession()).resolves.toEqual(runningSession);
  });

  it("accepts the safe-integer bounds for signed IDs, timestamps, and nonnegative fields", async () => {
    const boundedSnapshot = {
      session: {
        ...runningSession,
        createdAt: 0,
        updatedAt: SAFE_INTEGER_MAX,
      },
      messages: [
        {
          id: -SAFE_INTEGER_MAX,
          role: "user" as const,
          content: "",
          status: "failed" as const,
          createdAt: -SAFE_INTEGER_MAX,
          steps: [],
        },
        {
          id: SAFE_INTEGER_MAX,
          role: "assistant" as const,
          content: SNAPSHOT_CONTENT,
          status: "done" as const,
          createdAt: SAFE_INTEGER_MAX,
          steps: [
            {
              id: -SAFE_INTEGER_MAX,
              ordinal: SAFE_INTEGER_MAX,
              name: "",
              detail: "",
              status: "failed" as const,
            },
          ],
        },
      ],
      streamCursor: { epoch: SAFE_INTEGER_MAX, seq: SAFE_INTEGER_MAX },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(boundedSnapshot)));

    await expect(createApiClient().getMessages(SESSION_ID)).resolves.toEqual(boundedSnapshot);
  });

  it("accepts signed prompt message IDs including zero", async () => {
    const accepted = {
      userMessageId: 0,
      assistantMessageId: -SAFE_INTEGER_MAX,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(accepted, 202)));

    await expect(createApiClient().prompt(SESSION_ID, PROMPT_TEXT)).resolves.toEqual(accepted);
  });
});

describe("Sessions API client snapshot rejection contract", () => {
  it.each([
    ["a missing sessions member", { session: idleSession }],
    ["an extra list field", { sessions: [idleSession], next: null }],
    ["a non-array sessions member", { sessions: idleSession }],
    ["a missing session id", { sessions: [{ ...idleSession, id: undefined }] }],
    ["an extra session field", { sessions: [{ ...idleSession, ownerId: "u1" }] }],
    ["a non-hex session id", { sessions: [{ ...idleSession, id: "not-a-session-id" }] }],
    ["an uppercase session id", { sessions: [{ ...idleSession, id: SESSION_ID.toUpperCase() }] }],
    ["a 31-character session id", { sessions: [{ ...idleSession, id: SESSION_ID.slice(0, 31) }] }],
    ["a 33-character session id", { sessions: [{ ...idleSession, id: `${SESSION_ID}0` }] }],
    ["a non-null non-string title", { sessions: [{ ...idleSession, title: 7 }] }],
    ["an unknown session status", { sessions: [{ ...idleSession, status: "pending" }] }],
    ["a negative session createdAt", { sessions: [{ ...idleSession, createdAt: -1 }] }],
    ["a negative session updatedAt", { sessions: [{ ...idleSession, updatedAt: -1 }] }],
    ["an unsafe session timestamp", { sessions: [{ ...idleSession, createdAt: UNSAFE_INTEGER }] }],
    ["a fractional session timestamp", { sessions: [{ ...idleSession, createdAt: 1.5 }] }],
  ])("rejects %s from listSessions atomically", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    const error = await captureApiError(createApiClient().listSessions());

    expectRequestFailure(error, 200);
  });

  it.each([
    ["a missing title", { id: SESSION_ID, status: "idle", createdAt: 1, updatedAt: 1 }],
    ["an extra field", { ...idleSession, ownerId: "u1" }],
    ["a non-hex id", { ...idleSession, id: "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG" }],
    ["an unknown status", { ...idleSession, status: "queued" }],
    ["a negative createdAt", { ...idleSession, createdAt: -1 }],
    ["an unsafe updatedAt", { ...idleSession, updatedAt: UNSAFE_INTEGER }],
  ])("rejects %s from createSession atomically", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, 201)));

    const error = await captureApiError(createApiClient().createSession());

    expectRequestFailure(error, 201);
  });

  it.each([
    ["a missing streamCursor", { session: runningSession, messages: snapshot.messages }],
    ["an extra snapshot field", { ...snapshot, ownerId: "u1" }],
    [
      "a missing nested session field",
      { ...snapshot, session: { ...runningSession, updatedAt: undefined } },
    ],
    [
      "an extra nested session field",
      { ...snapshot, session: { ...runningSession, ownerId: "u1" } },
    ],
    ["a non-array messages member", { ...snapshot, messages: snapshot.messages[0] }],
    [
      "an extra nested message field",
      {
        ...snapshot,
        messages: [{ ...snapshot.messages[0], ownerId: "u1" }, snapshot.messages[1]],
      },
    ],
    [
      "a missing nested message field",
      {
        ...snapshot,
        messages: [
          {
            id: -3,
            role: "user",
            content: SNAPSHOT_CONTENT,
            status: "done",
            createdAt: -1,
          },
          snapshot.messages[1],
        ],
      },
    ],
    [
      "an unknown message role",
      {
        ...snapshot,
        messages: [{ ...snapshot.messages[0], role: "system" }, snapshot.messages[1]],
      },
    ],
    [
      "an unknown message status",
      {
        ...snapshot,
        messages: [{ ...snapshot.messages[0], status: "idle" }, snapshot.messages[1]],
      },
    ],
    [
      "an unsafe message id",
      {
        ...snapshot,
        messages: [{ ...snapshot.messages[0], id: UNSAFE_INTEGER }, snapshot.messages[1]],
      },
    ],
    [
      "a fractional message timestamp",
      {
        ...snapshot,
        messages: [{ ...snapshot.messages[0], createdAt: -1.5 }, snapshot.messages[1]],
      },
    ],
    [
      "an extra nested step field",
      {
        ...snapshot,
        messages: [
          snapshot.messages[0],
          {
            ...snapshot.messages[1],
            steps: [{ ...snapshotStep, startedAt: 1 }],
          },
        ],
      },
    ],
    [
      "a missing nested step field",
      {
        ...snapshot,
        messages: [
          snapshot.messages[0],
          {
            ...snapshot.messages[1],
            steps: [
              {
                id: -7,
                ordinal: 0,
                name: "first work",
                status: "running",
              },
            ],
          },
        ],
      },
    ],
    [
      "an unknown step status",
      {
        ...snapshot,
        messages: [
          snapshot.messages[0],
          {
            ...snapshot.messages[1],
            steps: [{ ...snapshotStep, status: "idle" }],
          },
        ],
      },
    ],
    [
      "a negative step ordinal",
      {
        ...snapshot,
        messages: [
          snapshot.messages[0],
          {
            ...snapshot.messages[1],
            steps: [{ ...snapshotStep, ordinal: -1 }],
          },
        ],
      },
    ],
    [
      "an unsafe step id",
      {
        ...snapshot,
        messages: [
          snapshot.messages[0],
          {
            ...snapshot.messages[1],
            steps: [{ ...snapshotStep, id: -UNSAFE_INTEGER }],
          },
        ],
      },
    ],
    [
      "an extra streamCursor field",
      { ...snapshot, streamCursor: { epoch: 1, seq: null, live: true } },
    ],
    ["a missing streamCursor seq", { ...snapshot, streamCursor: { epoch: 1 } }],
    ["a negative cursor epoch", { ...snapshot, streamCursor: { epoch: -1, seq: 0 } }],
    ["a negative numeric cursor seq", { ...snapshot, streamCursor: { epoch: 1, seq: -1 } }],
    ["an unsafe cursor seq", { ...snapshot, streamCursor: { epoch: 1, seq: UNSAFE_INTEGER } }],
    ["a non-integer cursor epoch", { ...snapshot, streamCursor: { epoch: 1.5, seq: 0 } }],
    ["a string cursor seq", { ...snapshot, streamCursor: { epoch: 1, seq: "0" } }],
  ])("rejects %s from getMessages atomically", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    const error = await captureApiError(createApiClient().getMessages(SESSION_ID));

    expectRequestFailure(error, 200);
  });

  it.each([
    ["a missing assistantMessageId", { userMessageId: -3 }],
    ["an extra field", { ...promptAccepted, requestId: "private" }],
    ["an unsafe userMessageId", { ...promptAccepted, userMessageId: UNSAFE_INTEGER }],
    ["a fractional assistantMessageId", { ...promptAccepted, assistantMessageId: 1.5 }],
    ["a null userMessageId", { ...promptAccepted, userMessageId: null }],
  ])("rejects %s from prompt atomically", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, 202)));

    const error = await captureApiError(createApiClient().prompt(SESSION_ID, PROMPT_TEXT));

    expectRequestFailure(error, 202);
  });
});

describe("Sessions API client error envelope contract", () => {
  it.each([
    [409, "session_busy", "会话正在生成，请稍候"],
    [502, "agent_unavailable", "Agent 运行时不可用"],
  ] as const)("preserves a %s %s envelope from prompt", async (status, code, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { code, message } }, status)),
    );

    const error = await captureApiError(createApiClient().prompt(SESSION_ID, PROMPT_TEXT));

    expect(error).toMatchObject({ name: "ApiError", status, code, message });
  });

  it.each(sessionMethods)(
    "rejects a wrong success status for %s",
    async (_name, request, expectedStatus, successBody) => {
      const wrongStatus = expectedStatus === 200 ? 201 : 200;
      const response = {
        json: vi.fn().mockResolvedValue(successBody),
        status: wrongStatus,
      } as unknown as Response;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

      const error = await captureApiError(request(createApiClient()));

      expectRequestFailure(error, wrongStatus);
      expect(response.json).not.toHaveBeenCalled();
    },
  );

  it.each(
    sessionMethods.flatMap(([name, request, expectedStatus]) => [
      ["malformed", name, request, expectedStatus, jsonResponse({ leaked: true }, expectedStatus)],
      [
        "non-JSON",
        name,
        request,
        expectedStatus,
        new Response("leaked response body", { status: expectedStatus }),
      ],
    ]),
  )(
    "maps a %s %s success body to the stable fallback",
    async (_kind, _name, request, expectedStatus, response) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

      const error = await captureApiError(request(createApiClient()));

      expectRequestFailure(error, expectedStatus);
      expect(error.message).not.toContain("leaked");
    },
  );

  it.each(sessionMethods)(
    "maps a %s fetch rejection without transport details",
    async (_name, request) => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("transport secret")));

      const error = await captureApiError(request(createApiClient()));

      expectRequestFailure(error, 0);
      expect(error.message).not.toContain("transport secret");
    },
  );
});

describe("Sessions API client unauthorized callback", () => {
  it.each(
    sessionMethods.flatMap(([name, request]) =>
      unauthorizedResponseCases().map(
        ([kind, response]) => [kind, name, request, response] as const,
      ),
    ),
  )(
    "notifies once for %s %s 401 with the request signal",
    async (kind, _name, request, response) => {
      const onUnauthorized = vi.fn();
      const controller = new AbortController();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const error = await captureApiError(
        request(createApiClient({ onUnauthorized }), { signal: controller.signal }),
      );

      if (kind === "a legal") {
        expect(error).toMatchObject({
          status: 401,
          code: "unauthorized",
          message: "登录已失效",
        });
      } else {
        expectRequestFailure(error, 401);
      }
      expect(onUnauthorized.mock.calls).toEqual([[controller.signal]]);
    },
  );

  it.each(
    sessionMethods.flatMap(([name, request]) => [
      [
        "synchronous",
        name,
        request,
        () => {
          throw new Error("callback failure");
        },
      ],
      [
        "rejected",
        name,
        request,
        async () => {
          throw new Error("async callback failure");
        },
      ],
    ]),
  )(
    "contains a %s %s unauthorized callback without replacing ApiError",
    async (_kind, _name, request, onUnauthorized) => {
      const callback = vi.fn(onUnauthorized);
      const unhandledRejection = vi.fn();
      window.addEventListener("unhandledrejection", unhandledRejection);
      const [[, legalUnauthorized]] = unauthorizedResponseCases();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(legalUnauthorized));

      try {
        const error = await captureApiError(request(createApiClient({ onUnauthorized: callback })));
        await Promise.resolve();

        expect(error).toMatchObject({
          status: 401,
          code: "unauthorized",
          message: "登录已失效",
        });
        expect(callback).toHaveBeenCalledTimes(1);
        expect(unhandledRejection).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("unhandledrejection", unhandledRejection);
      }
    },
  );
});
