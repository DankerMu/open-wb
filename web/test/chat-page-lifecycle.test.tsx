import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "./dialog-platform.js";
import type { ChatMessageSnapshot, ChatSession } from "../src/lib/session-contract.js";
import {
  cleanupChatLifecycle,
  clickSend,
  renderChatPageWithAuthProbe,
  renderObservedChatPage,
  renewAccount,
  sessionMessagesPath,
  sessionPromptPath,
  settleDeferredResponse,
  typeDraft,
} from "./chat-page-lifecycle-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { historyUser, latestSource, runningSession, SESSION_ID } from "./chat-stream-support.js";
import { currentLocation, deferredResponse, jsonResponse, replaceFetchRoutes } from "./support.js";

const SESSION_A = SESSION_ID;
const SESSION_B = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_A_TEXT = "session-A exclusive history";
const SESSION_B_TEXT = "session-B exclusive history";
const AGENT_UNAVAILABLE = "Agent 运行时不可用";
const A_PROMPT_ERROR = "会话 A 正在生成，请稍候";
const MULTILINE_DRAFT = "keep this\nexact draft  ";
const FIRST_CREATED_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SECOND_CREATED_ID = "cccccccccccccccccccccccccccccccc";
const exactText = { exact: true, collapseWhitespace: false, trim: false } as const;
const SESSION_A_MESSAGES = sessionMessagesPath(SESSION_A);
const SESSION_B_MESSAGES = sessionMessagesPath(SESSION_B);
const SESSION_A_PROMPT = sessionPromptPath(SESSION_A);

afterEach(() => {
  cleanupChatLifecycle();
});

function sessionA(): ChatSession {
  return {
    ...runningSession("idle"),
    id: SESSION_A,
    title: "alpha",
    updatedAt: 1_740_000_000_020,
  };
}

function sessionB(): ChatSession {
  return {
    ...runningSession("idle"),
    id: SESSION_B,
    title: "beta",
    updatedAt: 1_740_000_000_010,
  };
}

function snapshotFor(session: ChatSession, content: string): ChatMessageSnapshot {
  return {
    session,
    messages: [
      {
        id: -11,
        role: "user",
        content,
        status: "done",
        createdAt: -2,
        steps: [],
      },
    ],
    streamCursor: { epoch: 1, seq: 0 },
  };
}

function emptyCreatedSnapshot(sessionId: string): ChatMessageSnapshot {
  return {
    session: {
      id: sessionId,
      title: null,
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    },
    messages: [],
    streamCursor: { epoch: 1, seq: 0 },
  };
}

function emptyCreatedMessages() {
  return () => jsonResponse(emptyCreatedSnapshot(FIRST_CREATED_ID));
}

function twoSessionRoutes(sessionBMessages: FetchRoutes[string]): FetchRoutes {
  return {
    "/api/sessions": () => jsonResponse({ sessions: [sessionA(), sessionB()] }),
    [SESSION_A_MESSAGES]: () => jsonResponse(snapshotFor(sessionA(), SESSION_A_TEXT)),
    [SESSION_B_MESSAGES]: sessionBMessages,
  };
}

async function submitRejectedDraft() {
  await screen.findByRole("button", { name: "新建会话" });
  await waitFor(() => {
    expect(
      (screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement).disabled,
    ).toBe(false);
  });
  typeDraft(MULTILINE_DRAFT);
  clickSend();
  expect((await screen.findByRole("alert")).textContent).toBe(AGENT_UNAVAILABLE);
}

describe("chat page selection and error ownership", () => {
  it("never commits session A history while the URL already selects session B", async () => {
    const pendingB = deferredResponse();
    const commits: Array<{ html: string; location: string }> = [];
    const { router } = renderObservedChatPage(
      `/?session=${SESSION_A}`,
      twoSessionRoutes(pendingB.promise),
      (html, location) => {
        commits.push({ html, location });
      },
    );

    expect(await screen.findByText(SESSION_A_TEXT, { exact: true })).toBeTruthy();
    await act(async () => {
      await router.navigate(`/?session=${SESSION_B}`);
    });
    await waitFor(() => {
      expect(currentLocation()).toBe(`/?session=${SESSION_B}`);
      expect(commits.some((commit) => commit.location === `/?session=${SESSION_B}`)).toBe(true);
    });
    const committedB = commits.filter((commit) => commit.location === `/?session=${SESSION_B}`);
    expect(committedB.length).toBeGreaterThan(0);
    expect(committedB[0]?.html.includes(SESSION_A_TEXT)).toBe(false);
    expect(committedB.some((commit) => commit.html.includes(SESSION_A_TEXT))).toBe(false);
    pendingB.resolve(jsonResponse(snapshotFor(sessionB(), SESSION_B_TEXT)));
    expect(await screen.findByText(SESSION_B_TEXT, { exact: true })).toBeTruthy();
    expect(screen.queryByText(SESSION_A_TEXT, { exact: true })).toBeNull();
  });

  it("does not keep session A's prompt error after selecting B or empty", async () => {
    const { router } = renderChatPage(`/?session=${SESSION_A}`, {
      ...twoSessionRoutes(() => jsonResponse(snapshotFor(sessionB(), SESSION_B_TEXT))),
      [SESSION_A_PROMPT]: jsonResponse(
        { error: { code: "session_busy", message: A_PROMPT_ERROR } },
        409,
      ),
    });

    await screen.findByText(SESSION_A_TEXT, { exact: true });
    typeDraft("busy");
    clickSend();
    expect((await screen.findByRole("alert")).textContent).toBe(A_PROMPT_ERROR);
    fireEvent.click(screen.getByRole("button", { name: "beta" }));
    expect(await screen.findByText(SESSION_B_TEXT, { exact: true })).toBeTruthy();
    expect(screen.queryByText(A_PROMPT_ERROR, { exact: true })).toBeNull();
    await act(async () => {
      await router.navigate("/");
    });
    await waitFor(() => {
      expect(currentLocation()).toBe("/");
    });
    expect(screen.queryByText(A_PROMPT_ERROR, { exact: true })).toBeNull();
  });
});

describe("chat page draft retention on pre-acceptance rejection", () => {
  it("keeps the exact multiline draft after a definite 502 and retries once", async () => {
    let prompts = 0;
    const idle: ChatSession = { ...runningSession("idle"), title: "saved title" };
    const initialMessages = deferredResponse();
    renderChatPage(`/?session=${SESSION_A}`, {
      "/api/sessions": () => jsonResponse({ sessions: [idle] }),
      [SESSION_A_MESSAGES]: () => initialMessages.promise,
      [SESSION_A_PROMPT]: () => {
        prompts += 1;
        return jsonResponse(
          { error: { code: "agent_unavailable", message: AGENT_UNAVAILABLE } },
          502,
        );
      },
    });

    await screen.findByRole("button", { name: "新建会话" });
    const rejectedDraft = submitRejectedDraft();
    await act(async () => {});
    expect(
      (screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(prompts).toBe(0);
    await settleDeferredResponse(
      initialMessages,
      jsonResponse({
        session: idle,
        messages: [historyUser],
        streamCursor: { epoch: 1, seq: 0 },
      }),
    );
    await rejectedDraft;
    expect(
      within(await screen.findByRole("region", { name: "消息" })).queryByText(
        MULTILINE_DRAFT,
        exactText,
      ),
    ).toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement).value,
    ).toBe(MULTILINE_DRAFT);
    clickSend();
    await waitFor(() => {
      expect(prompts).toBe(2);
    });
  });

  it("keeps the exact draft after a failed create and retries once", async () => {
    let creates = 0;
    renderChatPage("/", {
      "/api/sessions": (_path, options) => {
        if (options?.method === "POST") {
          creates += 1;
          return jsonResponse(
            { error: { code: "agent_unavailable", message: AGENT_UNAVAILABLE } },
            502,
          );
        }
        return jsonResponse({ sessions: [] });
      },
    });

    await submitRejectedDraft();
    expect(
      (screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement).value,
    ).toBe(MULTILINE_DRAFT);
    clickSend();
    await waitFor(() => {
      expect(creates).toBe(2);
    });
  });
});

describe("chat page ignored-abort GET, renewal, and concurrent submit", () => {
  it("ignores a late aborted initial GET after selecting session B", async () => {
    const pendingA = deferredResponse();
    const { fetchMock, router } = renderChatPage(`/?session=${SESSION_A}`, {
      ...twoSessionRoutes(() => jsonResponse(snapshotFor(sessionB(), SESSION_B_TEXT))),
      [SESSION_A_MESSAGES]: pendingA.promise,
    });

    await screen.findByRole("button", { name: "beta" });
    const initialGet = fetchMock.mock.calls.find(([path]) => path === SESSION_A_MESSAGES);
    await act(async () => {
      await router.navigate(`/?session=${SESSION_B}`);
    });
    expect(await screen.findByText(SESSION_B_TEXT, { exact: true })).toBeTruthy();
    const sourceB = latestSource();
    expect(sourceB.url).toBe(`/api/sessions/${SESSION_B}/events`);
    await settleDeferredResponse(
      pendingA,
      jsonResponse({ error: { code: "not_found", message: "会话不存在" } }, 404),
    );
    expect(initialGet?.[1]?.signal?.aborted).toBe(true);
    expect(currentLocation()).toBe(`/?session=${SESSION_B}`);
    expect(screen.getByText(SESSION_B_TEXT, { exact: true })).toBeTruthy();
    expect(screen.queryByText(SESSION_A_TEXT, { exact: true })).toBeNull();
    expect(latestSource()).toBe(sourceB);
    expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a late aborted recovery GET after account renewal", async () => {
    const pendingRecovery = deferredResponse();
    let messageReads = 0;
    const { fetchMock, getProbe } = renderChatPageWithAuthProbe(`/?session=${SESSION_A}`, {
      "/api/sessions": () => jsonResponse({ sessions: [sessionA()] }),
      [SESSION_A_MESSAGES]: () => {
        messageReads += 1;
        if (messageReads === 1) {
          return jsonResponse(snapshotFor(sessionA(), SESSION_A_TEXT));
        }
        return pendingRecovery.promise;
      },
    });

    expect(await screen.findByText(SESSION_A_TEXT, { exact: true })).toBeTruthy();
    const sourceA = latestSource();
    act(() => {
      sourceA.emitOpen();
    });
    await waitFor(() => {
      expect(messageReads).toBeGreaterThan(1);
    });
    const recoveryCall = fetchMock.mock.calls.at(-1);
    replaceFetchRoutes(fetchMock, {
      "/api/auth/me": () => jsonResponse({ id: "user-2", account: "lisi", role: "member" }),
      "/api/auth/login": () => jsonResponse({ id: "user-2", account: "lisi", role: "member" }),
      "/api/sessions": () => jsonResponse({ sessions: [sessionB()] }),
      [SESSION_B_MESSAGES]: () => jsonResponse(snapshotFor(sessionB(), SESSION_B_TEXT)),
    });
    await renewAccount(getProbe);
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "beta" }));
    expect(await screen.findByText(SESSION_B_TEXT, { exact: true })).toBeTruthy();
    const sourceB = latestSource();
    expect(sourceB).not.toBe(sourceA);
    expect(sourceA.closeCount).toBeGreaterThan(0);
    expect(currentLocation()).toBe(`/?session=${SESSION_B}`);
    await settleDeferredResponse(
      pendingRecovery,
      jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
    );
    expect(recoveryCall?.[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
    expect(screen.getByText("lisi", { exact: true })).toBeTruthy();
    expect(screen.getByText(SESSION_B_TEXT, { exact: true })).toBeTruthy();
    expect(screen.queryByText(SESSION_A_TEXT, { exact: true })).toBeNull();
    expect(currentLocation()).toBe(`/?session=${SESSION_B}`);
    expect(latestSource()).toBe(sourceB);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("accepts only one create POST while the first is pending, then a later independent POST", async () => {
    const pendingCreate = deferredResponse();
    let creates = 0;
    renderChatPage("/", {
      "/api/sessions": (_path, options) => {
        if (options?.method === "POST") {
          creates += 1;
          if (creates === 1) {
            return pendingCreate.promise;
          }
          return jsonResponse(
            {
              id: SECOND_CREATED_ID,
              title: null,
              status: "idle",
              createdAt: 1,
              updatedAt: 1,
            },
            201,
          );
        }
        return jsonResponse({ sessions: [] });
      },
      [sessionMessagesPath(FIRST_CREATED_ID)]: emptyCreatedMessages(),
      [sessionPromptPath(FIRST_CREATED_ID)]: jsonResponse(
        { userMessageId: -3, assistantMessageId: 0 },
        202,
      ),
    });

    await screen.findByRole("button", { name: "新建会话" });
    typeDraft("first");
    clickSend();
    clickSend();
    expect(creates).toBe(1);
    pendingCreate.resolve(
      jsonResponse(
        {
          id: FIRST_CREATED_ID,
          title: null,
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
        201,
      ),
    );
    await waitFor(() => {
      expect(currentLocation()).toBe(`/?session=${FIRST_CREATED_ID}`);
      expect(
        (screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => {
      expect(creates).toBe(2);
    });
  });

  it("keeps the live chat page after a failed logout", async () => {
    const { fetchMock } = renderChatPage(`/?session=${SESSION_A}`, {
      "/api/sessions": () => jsonResponse({ sessions: [sessionA()] }),
      [SESSION_A_MESSAGES]: () => jsonResponse(snapshotFor(sessionA(), SESSION_A_TEXT)),
      "/api/auth/logout": jsonResponse(
        { error: { code: "forbidden", message: "无法退出当前会话" } },
        403,
      ),
    });

    expect(await screen.findByText(SESSION_A_TEXT, { exact: true })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "用户菜单" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect((await screen.findByRole("alert")).textContent).toBe("无法退出当前会话");
    expect(
      within(screen.getByRole("banner")).getByRole("heading", {
        level: 1,
        name: "我的工作 / alpha",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
    expect(currentLocation()).toBe(`/?session=${SESSION_A}`);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/auth/logout")).toHaveLength(1);
  });

  it("keeps the new-session action after a list GET 503 and creates once", async () => {
    let creates = 0;
    const { fetchMock } = renderChatPage(`/?session=${SESSION_A}`, {
      "/api/sessions": (_path, options) => {
        if (options?.method === "POST") {
          creates += 1;
          return jsonResponse(
            {
              id: FIRST_CREATED_ID,
              title: null,
              status: "idle",
              createdAt: 1,
              updatedAt: 1,
            },
            201,
          );
        }
        return jsonResponse({ error: { code: "unavailable", message: "会话列表不可用" } }, 503);
      },
      [SESSION_A_MESSAGES]: () => jsonResponse(snapshotFor(sessionA(), SESSION_A_TEXT)),
      [sessionMessagesPath(FIRST_CREATED_ID)]: emptyCreatedMessages(),
    });

    expect(await screen.findByText(SESSION_A_TEXT, { exact: true })).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toBe("会话列表不可用");
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => {
      expect(creates).toBe(1);
      expect(currentLocation()).toBe(`/?session=${FIRST_CREATED_ID}`);
    });
    expect(
      fetchMock.mock.calls.filter(
        ([path, options]) => path === "/api/sessions" && options?.method === "POST",
      ),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(latestSource().url).toBe(`/api/sessions/${FIRST_CREATED_ID}/events`);
    });
  });
});
