import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAYBOOKS,
  PLAYBOOKS_SHOWN,
  type Playbook,
  playbookWindow,
  WELCOME_QUICK_PROMPTS,
  type WelcomePrompt,
} from "../src/features/chat/welcome-content.js";
import {
  CREATED_MESSAGES,
  CREATED_PROMPT,
  CREATED_SESSION_ID,
  emptyCreatedSnapshot,
  idleCreatedSession,
} from "./chat-page-ownership-support.js";
import { cleanupChatPage, expectChatLocation, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  historyUser,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { currentLocation, deferredResponse, jsonResponse } from "./support.js";

const BASH_START_DETAIL = '{"command":"echo workbuddy-smoke"}';
const BASH_RESULT_DETAIL = '{"output":"workbuddy-smoke"}';
const SNAPSHOT_ASSISTANT = "Hello ";
const STREAMED_BODY = "Hello \u0000\uFEFF中文 😀";
const exactText = { exact: true, collapseWhitespace: false, trim: false } as const;
const messagesPath = `/api/sessions/${SESSION_ID}/messages`;

const runningSnapshot = chatSnapshot({
  content: SNAPSHOT_ASSISTANT,
  steps: [
    {
      id: 11,
      ordinal: 0,
      name: "bash",
      detail: BASH_START_DETAIL,
      status: "running",
    },
  ],
  cursor: { epoch: 1, seq: 3 },
});

afterEach(() => {
  cleanupChatPage();
});

async function mountKeyboardComposer() {
  const snapshot = chatSnapshot({
    status: "done",
    assistantStatus: "done",
    cursor: { epoch: 1, seq: null },
  });
  const pending = deferredResponse();
  const promptPath = `/api/sessions/${SESSION_ID}/prompt`;
  const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [messagesPath]: () => jsonResponse(snapshot),
    [promptPath]: () => pending.promise,
  });
  const input = (await screen.findByRole("textbox", {
    name: "给助手发消息",
  })) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  return { input, fetchMock, promptPath };
}
describe("chat page route integration", () => {
  it("loads a deep-linked running snapshot before opening events, then streams later frames to done", async () => {
    const initialMessages = deferredResponse();
    let messageReads = 0;
    const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": (_path, options) => {
        if (options?.method === "POST") {
          throw new Error("unexpected request POST /api/sessions");
        }
        return jsonResponse({ sessions: [runningSnapshot.session] });
      },
      [messagesPath]: (_path, options) => {
        if (options?.method === "POST") {
          throw new Error(`unexpected request POST ${messagesPath}`);
        }
        messageReads += 1;
        if (messageReads === 1) {
          return initialMessages.promise;
        }
        return jsonResponse(runningSnapshot);
      },
    });

    const banner = await screen.findByRole("banner");
    expect(
      await within(banner).findByRole("heading", { level: 1, name: "我的工作 / saved title" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await screen.findByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "新建会话" })).toBeTruthy();

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([requestPath]) => requestPath === messagesPath),
      ).toHaveLength(1);
    });
    expect(fetchMock.mock.calls.find(([requestPath]) => requestPath === messagesPath)?.[1]).toEqual(
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      },
    );
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.queryByText(historyUser.content, exactText)).toBeNull();
    expect(screen.queryByText(SNAPSHOT_ASSISTANT, exactText)).toBeNull();

    initialMessages.resolve(jsonResponse(runningSnapshot));

    expect(await screen.findByText(historyUser.content, exactText)).toBeTruthy();
    expect(screen.getByText(SNAPSHOT_ASSISTANT, exactText)).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "会话列表" })).getByText("saved title", {
        exact: true,
      }),
    ).toBeTruthy();
    expect(screen.getByText("bash", { exact: true })).toBeTruthy();
    expect(screen.getByText(BASH_START_DETAIL, { exact: true })).toBeTruthy();
    expect(screen.getByRole("status", { name: "bash 运行中" })).toBeTruthy();
    expect(screen.getByText("生成中", { exact: true })).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(currentLocation()).toBe(`/?session=${SESSION_ID}`);
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = latestSource();
    expect(source.url).toBe(`/api/sessions/${SESSION_ID}/events`);
    expect(source.withCredentials).toBe(true);

    act(() => {
      source.emitOpen();
      source.emitData("text.delta", "1:4", { messageId: 0, delta: "\u0000\uFEFF中文" });
    });
    expect(
      await screen.findByText(`${SNAPSHOT_ASSISTANT}\u0000\uFEFF中文`, exactText),
    ).toBeTruthy();

    act(() => {
      source.emitData("text.delta", "1:5", { messageId: 0, delta: " 😀" });
      source.emitData("step.end", "1:6", {
        messageId: 0,
        stepId: 11,
        status: "done",
        detail: BASH_RESULT_DETAIL,
      });
      source.emitData("turn.end", "1:7", { messageId: 0, status: "done" });
    });

    expect(await screen.findByText(STREAMED_BODY, exactText)).toBeTruthy();
    expect(screen.getByText(historyUser.content, exactText)).toBeTruthy();
    expect(screen.getByText(BASH_RESULT_DETAIL, { exact: true })).toBeTruthy();
    expect(screen.queryByText(BASH_START_DETAIL, { exact: true })).toBeNull();
    expect(screen.queryByRole("status", { name: "bash 运行中" })).toBeNull();
    expect(screen.getByRole("status", { name: "bash 已完成" })).toBeTruthy();
    expect(screen.queryByText("生成中", { exact: true })).toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement).disabled,
    ).toBe(false);
    expect(currentLocation()).toBe(`/?session=${SESSION_ID}`);
  });

  it("sends the exact multiline draft with Enter once and keeps a pending send locked", async () => {
    const { input, fetchMock, promptPath } = await mountKeyboardComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock.mock.calls.filter(([path]) => path === promptPath)).toHaveLength(0);
    const text = "  第一行\n第二行  ";
    fireEvent.change(input, { target: { value: text } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([path]) => path === promptPath)).toHaveLength(1);
    });
    const sent = fetchMock.mock.calls.find(([path]) => path === promptPath);
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ message: text });
    fireEvent.keyDown(input, { key: "Enter", repeat: true });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock.mock.calls.filter(([path]) => path === promptPath)).toHaveLength(1);
  });

  it("leaves newline and IME confirmation keys alone until a deliberate Enter", async () => {
    const { input, fetchMock, promptPath } = await mountKeyboardComposer();
    fireEvent.change(input, { target: { value: "中文草稿" } });
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(true);
    fireEvent.keyDown(input, { key: "Enter", repeat: true });
    expect(fetchMock.mock.calls.filter(([path]) => path === promptPath)).toHaveLength(0);
    expect(input.value).toBe("中文草稿");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([path]) => path === promptPath)).toHaveLength(1);
    });
  });
});

const HERO = "WorkBuddy，我帮你";
const DISCLAIMER = "内容由 AI 生成，请核实重要信息";
const SALES_PROMPT = "分析 2026 年 7 月销售数据，生成周报：同比环比、区域拆解、异常标注";
const PPT_PROMPT = "把 Q3 经营数据做成 18 页分析 PPT";
const ARCHIVE_PROMPT = "整理本地项目文档并建立分类索引";
const REPORT_PROMPT = "汇总本季度部门进展并输出汇报材料";

// Oracle: resource/workbuddy-live-demo.html:1221-1239 (office scene), 2553-2561, 2674.
const EXPECTED_QUICK_PROMPTS: WelcomePrompt[] = [
  { label: "文档处理", icon: "file-text", prompt: PPT_PROMPT },
  { label: "内部汇报", icon: "zap", prompt: REPORT_PROMPT },
  { label: "数据分析及可视化", icon: "file-spreadsheet", prompt: SALES_PROMPT },
  { label: "资料归档", icon: "folder", prompt: ARCHIVE_PROMPT },
  { label: "幻灯片", icon: "file-chart-line", prompt: "帮我做一份项目评审 PPT 大纲" },
  { label: "产品需求", icon: "file-text", prompt: "帮我整理一份产品需求文档" },
];
const EXPECTED_PLAYBOOKS: Playbook[] = [
  {
    title: "数据分析",
    desc: "清洗销售数据，生成周报与区域拆解看板",
    icon: "file-spreadsheet",
    prompt: SALES_PROMPT,
  },
  {
    title: "内容创作",
    desc: "把经营数据做成 18 页分析 PPT",
    icon: "file-chart-line",
    prompt: PPT_PROMPT,
  },
  {
    title: "工程研发",
    desc: "重构模块并补齐回归测试",
    icon: "code",
    prompt: "帮我重构一个模块并补齐回归测试",
  },
  {
    title: "AI 应用",
    desc: "设计一个 Agent 应用的交互流程",
    icon: "sparkles",
    prompt: "帮我设计一个 Agent 应用的交互流程",
  },
  { title: "资料归档", desc: ARCHIVE_PROMPT, icon: "search", prompt: ARCHIVE_PROMPT },
  {
    title: "视觉设计",
    desc: "为发布活动设计一张科技感海报",
    icon: "image",
    prompt: "帮我设计一张内部活动海报",
  },
  { title: "内部汇报", desc: "汇总部门进展并输出汇报材料", icon: "zap", prompt: REPORT_PROMPT },
];
const ALL_TITLES = EXPECTED_PLAYBOOKS.map((item) => item.title);
const FIRST_WINDOW = ["数据分析", "内容创作", "工程研发", "AI 应用", "资料归档"];
const SECOND_WINDOW = ["内容创作", "工程研发", "AI 应用", "资料归档", "视觉设计"];

function quickRow() {
  return screen.getByRole("group", { name: "快捷任务" });
}

function playbookRegion() {
  return screen.getByRole("region", { name: "最佳实践案例" });
}

function welcomeInput() {
  return screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement;
}

function playbookCards(): HTMLButtonElement[] {
  return Array.from(playbookRegion().querySelectorAll<HTMLButtonElement>(".chat-playbook-card"));
}

function cardTitle(card: HTMLElement): string | undefined {
  return ALL_TITLES.find((title) => within(card).queryByText(title, { exact: true }) !== null);
}

function cardTitles(): (string | undefined)[] {
  return playbookCards().map(cardTitle);
}

function cardNamed(title: string): HTMLButtonElement {
  const card = playbookCards().find((candidate) => cardTitle(candidate) === title);
  if (!card) throw new Error(`playbook card ${title} is not rendered`);
  return card;
}

function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function welcomeControls(): HTMLButtonElement[] {
  return [
    ...within(quickRow()).getAllByRole<HTMLButtonElement>("button"),
    ...within(playbookRegion()).getAllByRole<HTMLButtonElement>("button"),
  ];
}

async function mountWelcome(routes: Parameters<typeof renderChatPage>[1] = {}) {
  const mounted = renderChatPage("/", {
    "/api/sessions": () => jsonResponse({ sessions: [] }),
    ...routes,
  });
  expect(await screen.findByRole("heading", { level: 1, name: HERO })).toBeTruthy();
  return mounted;
}

describe("welcome state", () => {
  it("(W1) renders hero, quick chips, composer, five playbooks and the disclaimer in order", async () => {
    await mountWelcome();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([HERO]);
    expect(screen.queryByRole("banner")).toBeNull();

    const chips = within(quickRow()).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(
      EXPECTED_QUICK_PROMPTS.map((item) => item.label),
    );
    for (const chip of chips) expect(chip.querySelector("svg")).not.toBeNull();

    const region = playbookRegion();
    expect(
      within(region).getByText("不知道做什么，试试最佳实践案例", { exact: true }),
    ).toBeTruthy();
    expect(within(region).getByRole("button", { name: "换一批" })).toBeTruthy();
    expect(playbookCards()).toHaveLength(5);
    expect(cardTitles()).toEqual(FIRST_WINDOW);
    const disclaimer = screen.getByText(DISCLAIMER, { exact: true });

    const input = welcomeInput();
    expect(input.placeholder).toBe("今天帮你做些什么");
    expect(screen.queryByRole("button", { name: /查看更多|附件|模型|麦克风/ })).toBeNull();
    for (const scene of ["日常办公", "代码开发", "创意设计"]) {
      expect(screen.queryByText(scene)).toBeNull();
    }

    const hero = screen.getByRole("heading", { level: 1, name: HERO });
    expect(precedes(hero, quickRow())).toBe(true);
    expect(precedes(quickRow(), input)).toBe(true);
    expect(precedes(input, region)).toBe(true);
    expect(precedes(region, disclaimer)).toBe(true);
  });

  it("(W2) fills the draft from a card or chip without sending", async () => {
    const { fetchMock } = await mountWelcome();
    fireEvent.click(cardNamed("内容创作"));
    // Let any deferred submit that a pick might schedule run before asserting nothing was sent.
    await act(settle);
    expect(welcomeInput().value).toBe(PPT_PROMPT);
    fireEvent.click(within(quickRow()).getByRole("button", { name: "数据分析及可视化" }));
    await act(settle);
    expect(welcomeInput().value).toBe(SALES_PROMPT);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toEqual([]);
    expect(currentLocation()).toBe("/");
  });

  it("(W2) keeps chips and cards disabled while a create-send is locked", async () => {
    const pendingCreate = deferredResponse();
    await mountWelcome({
      "/api/sessions": (_path, options) =>
        options?.method === "POST" ? pendingCreate.promise : jsonResponse({ sessions: [] }),
    });
    fireEvent.change(welcomeInput(), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(welcomeInput().disabled).toBe(true));
    const locked = welcomeControls();
    expect(locked).toHaveLength(6 + 1 + 5);
    for (const control of locked) expect(control.disabled).toBe(true);
    // Submit already moved the draft into the pending create; a locked card must not refill it.
    expect(welcomeInput().value).toBe("");
    fireEvent.click(cardNamed("内容创作"));
    expect(welcomeInput().value).toBe("");

    pendingCreate.resolve(
      jsonResponse({ error: { code: "internal", message: "创建会话失败" } }, 500),
    );
    expect(await screen.findByText("创建会话失败", { exact: true })).toBeTruthy();
    await waitFor(() => expect(welcomeInput().value).toBe("hello"));
    for (const control of welcomeControls()) expect(control.disabled).toBe(false);
    expect(currentLocation()).toBe("/");
  });

  it("(W3) rotates the five-card window within the static set", async () => {
    await mountWelcome();
    const refresh = within(playbookRegion()).getByRole("button", { name: "换一批" });
    fireEvent.click(refresh);
    expect(cardTitles()).not.toEqual(FIRST_WINDOW);
    expect(cardTitles()).toEqual(SECOND_WINDOW);
    for (const title of cardTitles()) expect(ALL_TITLES).toContain(title);
    for (let click = 2; click <= 7; click += 1) {
      fireEvent.click(refresh);
      expect(playbookCards()).toHaveLength(5);
    }
    expect(cardTitles()).toEqual(FIRST_WINDOW);
  });

  it("(W4) ports the demo content verbatim and wraps the window modulo seven", () => {
    expect(WELCOME_QUICK_PROMPTS).toEqual(EXPECTED_QUICK_PROMPTS);
    expect(PLAYBOOKS).toEqual(EXPECTED_PLAYBOOKS);
    expect(PLAYBOOKS_SHOWN).toBe(5);
    const titles = (start: number) => playbookWindow(start).map((item) => item.title);
    expect(titles(0)).toEqual(FIRST_WINDOW);
    expect(titles(6)).toEqual(["内部汇报", "数据分析", "内容创作", "工程研发", "AI 应用"]);
    expect(playbookWindow(7)).toEqual(playbookWindow(0));
    expect(titles(8)).toEqual(SECOND_WINDOW);
  });

  it("(W4) renders no welcome content for a selected session", async () => {
    const snapshot = chatSnapshot({
      status: "done",
      assistantStatus: "done",
      cursor: { epoch: 1, seq: null },
    });
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [messagesPath]: () => jsonResponse(snapshot),
    });
    expect(await screen.findByText(historyUser.content, exactText)).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: HERO })).toBeNull();
    expect(screen.queryByRole("group", { name: "快捷任务" })).toBeNull();
    expect(screen.queryByRole("region", { name: "最佳实践案例" })).toBeNull();
    expect(screen.queryByText(DISCLAIMER, { exact: true })).toBeNull();
  });

  it("(W5) keeps the same composer textarea across the welcome-to-session handoff", async () => {
    const pendingPrompt = deferredResponse();
    await mountWelcome({
      "/api/sessions": (_path, options) =>
        options?.method === "POST"
          ? jsonResponse(idleCreatedSession(), 201)
          : jsonResponse({ sessions: [] }),
      [CREATED_MESSAGES]: () => jsonResponse(emptyCreatedSnapshot()),
      [CREATED_PROMPT]: () => pendingPrompt.promise,
    });
    const input = welcomeInput();
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await expectChatLocation(`/?session=${CREATED_SESSION_ID}`);
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "快捷任务" })).toBeNull();
    });
    expect(welcomeInput()).toBe(input);
  });
});
