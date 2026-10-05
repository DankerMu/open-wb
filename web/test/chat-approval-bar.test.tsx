import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED,
  approval,
  approvalPath,
  assistants,
  bodies,
  button,
  cards,
  composerInput,
  countdowns,
  DENIED,
  dock,
  emitRequest,
  emitResolved,
  expectRecord,
  flush,
  MESSAGES,
  mountPage,
  OTHER_TITLE,
  type PageRoutes,
  PENDING,
  records,
  settledBody,
  slotText,
  snapshotWith,
  stopButton,
  T0,
  TIMED_OUT,
  TITLE,
  UNAVAILABLE_502,
} from "./chat-approval-support.js";
import {
  cleanupChatLifecycle,
  renderChatPageWithAuthProbe,
  renewAccount,
} from "./chat-page-lifecycle-support.js";
import { OTHER_MESSAGES, OTHER_SESSION_ID, otherSnapshot } from "./chat-page-ownership-support.js";
import { expectChatLocation } from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  historyUser,
  latestSource,
  SESSION_ID,
} from "./chat-stream-support.js";
import { calls, deferredResponse, jsonResponse } from "./support.js";
import { readRepoFile } from "./ui-support.js";

const PROMPT_PATH = `/api/sessions/${SESSION_ID}/prompt`;
const EVENTS_URL = `/api/sessions/${SESSION_ID}/events`;
const OTHER_EVENTS_URL = `/api/sessions/${OTHER_SESSION_ID}/events`;
const SETTLED_409 = { error: { code: "approval_settled", message: "该审批已处理" } };
const BUSY_409 = { error: { code: "session_busy", message: "会话正在生成，请稍候" } };
const REQUEST_FAILED = "请求失败，请稍后重试";

function sourcesFor(url: string) {
  return FakeEventSource.instances.filter((source) => source.url === url);
}

/** 整页没有任何错误呈现：无 alert（提问卡内、输入框上方都没有）、无 Toast。 */
function expectNoErrorShown() {
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
  expect(document.querySelector(".ui-toast")).toBeNull();
}

/** 恰一条 alert，且在 `card` 内：输入框上方没有内联错误，也没有 Toast。 */
function expectCardAlert(card: HTMLElement, message: string) {
  const alerts = screen.getAllByRole("alert");
  expect(alerts.map((alert) => alert.textContent)).toEqual([message]);
  expect(card.contains(alerts[0] as HTMLElement)).toBe(true);
  expect(document.querySelector(".ui-toast")).toBeNull();
}

/** 卡的集合变化后 400ms 内的作答点击被忽略：推进注入时钟越过它。 */
function passClickGuard() {
  act(() => {
    vi.advanceTimersByTime(400);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanupChatLifecycle();
  vi.useRealTimers();
});

describe("approval prompt card: pending, countdown and settled records", () => {
  it("A1 docks one pending card above the composer with badge, full title, one countdown sentence and live buttons", async () => {
    const { source } = await mountPage(snapshotWith([]));
    expect(dock()).toBeNull();
    emitRequest(source, 1, 7);

    const [card] = cards() as [HTMLElement];
    expect(cards()).toHaveLength(1);
    expect(slotText(card, "approval-tool")).toBe("bash");
    expect(slotText(card, "approval-title")).toBe(TITLE);
    expect(card.querySelector('[data-slot="approval-title"]')?.classList).toContain(
      "whitespace-pre-wrap",
    );
    const sentences = countdowns(card);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]?.textContent).toBe("（60s 内未操作将自动允许）");
    expect(within(card).queryByRole("progressbar")).toBeNull();
    expect(within(card).queryAllByText(/^\d+s$/)).toHaveLength(0);
    expect(button(card, "允许").disabled).toBe(false);
    expect(button(card, "拒绝").disabled).toBe(false);
    // 助手消息内没有待决审批的任何元素，也还没有已结算记录
    const article = assistants()[0] as HTMLElement;
    expect(within(article).queryAllByRole("group")).toHaveLength(0);
    expect(article.textContent).not.toContain("Reason: run ls");
    // 有 pending 审批时回合仍 running：composer 锁定，`停止` 可用
    expect(composerInput().disabled).toBe(true);
    expect(screen.getByText("生成中", { exact: true })).toBeTruthy();
    expect(stopButton().disabled).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(countdowns(card).map((sentence) => sentence.textContent)).toEqual([
      "（59s 内未操作将自动允许）",
    ]);
  });

  it("A2 recomputes the countdown every second and floors it at 0 with buttons still live", async () => {
    const { source } = await mountPage(snapshotWith([]));
    emitRequest(source, 1, 7);
    const [card] = cards() as [HTMLElement];

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(countdowns(card)[0]?.textContent).toBe("（0s 内未操作将自动允许）");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(countdowns(card)).toHaveLength(1);
    expect(countdowns(card)[0]?.textContent).toBe("（0s 内未操作将自动允许）");
    expect(button(card, "允许").disabled).toBe(false);
    expect(button(card, "拒绝").disabled).toBe(false);
  });

  it("A3 sends allow exactly once, stays disabled across a snapshot swap and leaves only on approval.resolved", async () => {
    const answer = deferredResponse();
    const { fetchMock, page, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => answer.promise,
    });
    emitRequest(source, 1, 7);
    const [card] = cards() as [HTMLElement];

    fireEvent.click(button(card, "允许"));
    fireEvent.click(button(card, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
    expect(button(card, "允许").disabled).toBe(true);
    expect(button(card, "拒绝").disabled).toBe(true);
    expect(cards()).toEqual([card]);

    const reads = calls(fetchMock, MESSAGES).length;
    page.snapshot = snapshotWith([approval(7)], 1);
    act(() => {
      source.emitGap();
    });
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    const [swapped] = cards() as [HTMLElement];
    expect(button(swapped, "允许").disabled).toBe(true);
    expect(button(swapped, "拒绝").disabled).toBe(true);
    fireEvent.click(button(swapped, "允许"));
    await flush();
    expect(calls(fetchMock, approvalPath(7))).toHaveLength(1);

    // 200 本身不改卡头：resolved 到达前它仍是待决提问卡
    answer.resolve(settledBody(7, "allow"));
    await flush();
    const [answered] = cards() as [HTMLElement];
    expect(countdowns(answered)).toHaveLength(1);
    expect(records()).toHaveLength(0);

    emitResolved(source, 2, 7, "allow");
    expect(cards()).toHaveLength(0);
    expect(dock()).toBeNull();
    const [record] = records();
    expectRecord(record, ALLOWED);
    expect(slotText(record as HTMLElement, "approval-tool")).toBe("bash");
    expect(slotText(record as HTMLElement, "approval-title")).toBe(TITLE);
    expect(
      (record as HTMLElement).querySelector('[data-slot="approval-title"]')?.classList,
    ).toContain("whitespace-pre-wrap");
  });

  it("A3b answers deny with the card's id and settles into a 已拒绝执行 record", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => settledBody(7, "deny"),
    });
    emitRequest(source, 1, 7);

    fireEvent.click(button(cards()[0] as HTMLElement, "拒绝"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "deny" }]);
    emitResolved(source, 2, 7, "deny");

    expect(cards()).toHaveLength(0);
    expectRecord(records()[0], DENIED);
  });

  it("A4 turns timeout into a 超时自动允许 record and deny into 已拒绝执行, without buttons or countdown", async () => {
    const { source } = await mountPage(snapshotWith([]));
    emitRequest(source, 1, 7);
    emitRequest(source, 2, 8, { title: OTHER_TITLE });
    expect(cards()).toHaveLength(2);
    emitResolved(source, 3, 8, "deny");
    emitResolved(source, 4, 7, "timeout");

    expect(cards()).toHaveLength(0);
    const [seven, eight] = records() as [HTMLElement, HTMLElement];
    expect(records()).toHaveLength(2);
    expectRecord(seven, TIMED_OUT);
    expectRecord(eight, DENIED);
    expect(slotText(seven, "approval-title")).toBe(TITLE);
    expect(slotText(eight, "approval-title")).toBe(OTHER_TITLE);
    expect(screen.queryAllByRole("group", { name: ALLOWED })).toHaveLength(0);
  });

  it("A10 shows the tool field as the badge and never re-parses the title", async () => {
    const { source } = await mountPage(snapshotWith([]));
    emitRequest(source, 1, 7, { tool: "python", title: "Allow tool: bash\nReason: x" });
    expect(slotText(cards()[0] as HTMLElement, "approval-tool")).toBe("python");
  });

  it("A11 keeps exactly one interval while any card is pending and clears it once none is", async () => {
    const { source } = await mountPage(snapshotWith([]));
    expect(vi.getTimerCount()).toBe(0);
    emitRequest(source, 1, 7);
    expect(vi.getTimerCount()).toBe(1);
    emitRequest(source, 2, 8, { title: OTHER_TITLE });
    expect(vi.getTimerCount()).toBe(1);
    emitResolved(source, 3, 7, "allow");
    expect(vi.getTimerCount()).toBe(1);
    emitResolved(source, 4, 8, "deny");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("approval prompt card: answer outcomes", () => {
  it("A5 reconciles a 409 approval_settled silently and reconnects from the new snapshot", async () => {
    const { fetchMock, page, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => jsonResponse(SETTLED_409, 409),
    });
    emitRequest(source, 1, 7);
    const reads = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    page.snapshot = snapshotWith([approval(7, { decision: "timeout" })], 1);

    fireEvent.click(button(cards()[0] as HTMLElement, "允许"));
    await flush();

    expectNoErrorShown();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(source.closeCount).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(sources + 1);
    expect(latestSource().url).toBe(EVENTS_URL);
    expect(cards()).toHaveLength(0);
    expectRecord(records()[0], TIMED_OUT);
  });

  it("A5 counter-case: a 409 with another code is an alert inside the card, re-enables and never reconciles", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => jsonResponse(BUSY_409, 409),
    });
    emitRequest(source, 1, 7);
    const reads = calls(fetchMock, MESSAGES).length;

    fireEvent.click(button(cards()[0] as HTMLElement, "允许"));
    await flush();

    const [card] = cards() as [HTMLElement];
    expectCardAlert(card, BUSY_409.error.message);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(source.closeCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(button(card, "允许").disabled).toBe(false);
    expect(button(card, "拒绝").disabled).toBe(false);
  });

  it("A5b keeps the live source and stays silent when the reconcile GET fails", async () => {
    const { fetchMock, page, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => jsonResponse(SETTLED_409, 409),
    });
    emitRequest(source, 1, 7);
    const reads = calls(fetchMock, MESSAGES).length;
    page.messages = () => jsonResponse(UNAVAILABLE_502, 502);

    fireEvent.click(button(cards()[0] as HTMLElement, "允许"));
    await flush();

    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expectNoErrorShown();
    expect(source.closeCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    const [card] = cards() as [HTMLElement];
    expect(button(card, "允许").disabled).toBe(true);
    expect(button(card, "拒绝").disabled).toBe(true);

    emitResolved(source, 2, 7, "timeout");
    expect(cards()).toHaveLength(0);
    expectRecord(records()[0], TIMED_OUT);
  });

  it("A6 shows a 502 as an alert inside the card, re-enables it, and the retry clears the alert and succeeds", async () => {
    const retry = deferredResponse();
    let answers = 0;
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => {
        answers += 1;
        return answers === 1 ? jsonResponse(UNAVAILABLE_502, 502) : retry.promise;
      },
    });
    emitRequest(source, 1, 7);
    const reads = calls(fetchMock, MESSAGES).length;

    fireEvent.click(button(cards()[0] as HTMLElement, "允许"));
    await flush();
    const [card] = cards() as [HTMLElement];
    expectCardAlert(card, "Agent 运行时不可用");
    expect(screen.getAllByRole("group", { name: PENDING })).toEqual([card]);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(button(card, "允许").disabled).toBe(false);
    expect(button(card, "拒绝").disabled).toBe(false);
    expect(countdowns(card)).toHaveLength(1);

    // 第二次点击当即清除 alert（请求仍在途），两按钮禁用
    fireEvent.click(button(card, "允许"));
    expectNoErrorShown();
    await flush();
    expectNoErrorShown();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([
      { decision: "allow" },
      { decision: "allow" },
    ]);
    expect(button(card, "允许").disabled).toBe(true);
    expect(button(card, "拒绝").disabled).toBe(true);

    retry.resolve(settledBody(7, "allow"));
    await flush();
    emitResolved(source, 2, 7, "allow");
    expect(cards()).toHaveLength(0);
    expectRecord(records()[0], ALLOWED);
    expectNoErrorShown();
    expect(calls(fetchMock, approvalPath(7))).toHaveLength(2);
  });

  it.each([
    [400, "invalid_request", "请求参数无效"],
    [404, "not_found", "审批不存在"],
    [503, "service_unavailable", "服务暂不可用"],
  ])(
    "A6c shows a %i envelope message inside the card and re-enables both buttons",
    async (status, code, message) => {
      const { fetchMock, source } = await mountPage(snapshotWith([]), {
        [approvalPath(7)]: () => jsonResponse({ error: { code, message } }, status),
      });
      emitRequest(source, 1, 7);

      fireEvent.click(button(cards()[0] as HTMLElement, "允许"));
      await flush();

      const [card] = cards() as [HTMLElement];
      expectCardAlert(card, message);
      expect(calls(fetchMock, approvalPath(7))).toHaveLength(1);
      expect([button(card, "允许").disabled, button(card, "拒绝").disabled]).toEqual([
        false,
        false,
      ]);
    },
  );

  it("A6b shows the request_failed wording inside the card when the answer fails on the network", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => Promise.reject(new TypeError("network down")),
    });
    emitRequest(source, 1, 7);
    emitRequest(source, 2, 8, { title: OTHER_TITLE });
    passClickGuard();

    fireEvent.click(button(cards()[0] as HTMLElement, "拒绝"));
    await flush();

    const [seven, eight] = cards() as [HTMLElement, HTMLElement];
    expectCardAlert(seven, REQUEST_FAILED);
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "deny" }]);
    expect(button(seven, "允许").disabled).toBe(false);
    expect(button(seven, "拒绝").disabled).toBe(false);
    // 其它卡不受影响
    expect(within(eight).queryAllByRole("alert")).toHaveLength(0);
    expect(button(eight, "允许").disabled).toBe(false);
    expect(composerInput().disabled).toBe(true);
  });

  it("A7 answers two concurrent cards independently by their own ids", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => settledBody(7, "allow"),
      [approvalPath(8)]: () => settledBody(8, "deny"),
    });
    emitRequest(source, 1, 7);
    emitRequest(source, 2, 8, { title: OTHER_TITLE });

    const [seven, eight] = cards() as [HTMLElement, HTMLElement];
    expect(cards()).toHaveLength(2);
    expect(slotText(seven, "approval-title")).toBe(TITLE);
    expect(slotText(eight, "approval-title")).toBe(OTHER_TITLE);
    expect(seven.compareDocumentPosition(eight) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 卡的集合刚变过（8 加入、随后 8 消失）：各等过防误点的 400ms 再点
    passClickGuard();
    fireEvent.click(button(eight, "拒绝"));
    await flush();
    expect(bodies(fetchMock, approvalPath(8))).toEqual([{ decision: "deny" }]);
    expect(calls(fetchMock, approvalPath(7))).toHaveLength(0);
    expect(button(eight, "允许").disabled).toBe(true);
    expect(button(eight, "拒绝").disabled).toBe(true);
    expect(button(seven, "允许").disabled).toBe(false);
    expect(button(seven, "拒绝").disabled).toBe(false);
    expect(countdowns(seven)).toHaveLength(1);

    emitResolved(source, 3, 8, "deny");
    expect(cards()).toEqual([seven]);
    expect(records()).toHaveLength(1);
    expectRecord(records()[0], DENIED);
    expect(composerInput().disabled).toBe(true);

    passClickGuard();
    fireEvent.click(button(seven, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
    emitResolved(source, 4, 7, "allow");
    expect(cards()).toHaveLength(0);
    const settled = records();
    expect(settled).toHaveLength(2);
    expectRecord(settled[0], ALLOWED);
    expectRecord(settled[1], DENIED);
    expect(screen.queryAllByRole("button", { name: /^(允许|拒绝)$/ })).toHaveLength(0);
  });
});

describe("approval prompt card: ownership fences", () => {
  async function switchToOther() {
    fireEvent.click(screen.getByRole("button", { name: "other session" }));
    await expectChatLocation(`/?session=${OTHER_SESSION_ID}`);
    await screen.findByText("other user", { exact: true });
    await flush();
  }

  it("A12 drops a late 409 after the user switched to another session", async () => {
    const answer = deferredResponse();
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => answer.promise,
      [OTHER_MESSAGES]: () => jsonResponse(otherSnapshot()),
    });
    emitRequest(source, 1, 7);
    fireEvent.click(button(cards()[0] as HTMLElement, "允许"));
    await flush();
    await switchToOther();
    const reads = calls(fetchMock, MESSAGES).length;
    expect(sourcesFor(OTHER_EVENTS_URL)).toHaveLength(1);

    answer.resolve(jsonResponse(SETTLED_409, 409));
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(sourcesFor(EVENTS_URL)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("A12b drops a reconcile snapshot that resolves after the user switched sessions", async () => {
    const reconcile = deferredResponse();
    const { fetchMock, page, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => jsonResponse(SETTLED_409, 409),
      [OTHER_MESSAGES]: () => jsonResponse(otherSnapshot()),
    });
    emitRequest(source, 1, 7);
    const reads = calls(fetchMock, MESSAGES).length;
    page.messages = () => reconcile.promise;
    fireEvent.click(button(cards()[0] as HTMLElement, "允许"));
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);

    await switchToOther();
    const [other] = sourcesFor(OTHER_EVENTS_URL);
    expect(other).toBeDefined();
    reconcile.resolve(jsonResponse(snapshotWith([approval(7, { decision: "timeout" })], 1)));
    await flush();

    expect(other?.closeCount).toBe(0);
    expect(sourcesFor(EVENTS_URL)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("other user", { exact: true })).toBeTruthy();
    expect(document.querySelector('[data-slot="approval-record"]')).toBeNull();
  });

  it("A12c drops a late 409 after account renewal kept the same session selected", async () => {
    const answer = deferredResponse();
    const page: PageRoutes = {
      snapshot: snapshotWith([]),
      messages: () => jsonResponse(page.snapshot),
    };
    const { fetchMock, getProbe } = renderChatPageWithAuthProbe(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [page.snapshot.session] }),
      [MESSAGES]: () => page.messages(),
      [approvalPath(7)]: () => answer.promise,
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = latestSource();
    act(() => {
      source.emitOpen();
    });
    await flush();
    emitRequest(source, 1, 7);
    page.snapshot = snapshotWith([approval(7)], 1);
    fireEvent.click(button(cards()[0] as HTMLElement, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);

    await renewAccount(getProbe);
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();
    await flush();
    expect(FakeEventSource.instances).toHaveLength(2);
    const renewed = latestSource();
    expect(renewed.url).toBe(EVENTS_URL);
    expect(source.closeCount).toBeGreaterThan(0);
    act(() => {
      renewed.emitOpen();
    });
    await flush();
    const reads = calls(fetchMock, MESSAGES).length;

    answer.resolve(jsonResponse(SETTLED_409, 409));
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(renewed.closeCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("A13 answering leaves an in-flight prompt and its acceptance reconcile untouched", async () => {
    const prompt = deferredResponse();
    const done = chatSnapshot({
      status: "done",
      assistantStatus: "done",
      content: "earlier answer",
      cursor: { epoch: 1, seq: 0 },
    });
    const { fetchMock, page, source } = await mountPage(done, {
      [PROMPT_PATH]: () => prompt.promise,
      [approvalPath(9)]: () => settledBody(9, "allow"),
    });
    await waitFor(() => expect(composerInput().disabled).toBe(false));
    fireEvent.change(composerInput(), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(calls(fetchMock, PROMPT_PATH)).toHaveLength(1);

    // #633：新回合事件先于 202 到达且末条助手已 done，页面不本地追加，而是恢复一次快照；
    // 权威快照（游标 1:2）带助手 2 与待审批 9，提问卡随快照装入后出现。
    page.snapshot = {
      session: { ...done.session, status: "running" },
      messages: [
        ...done.messages,
        { ...historyUser, id: 1, content: "继续", createdAt: 1 },
        {
          ...historyUser,
          id: 2,
          role: "assistant",
          status: "running",
          content: "",
          createdAt: 2,
          approvals: [approval(9)],
        },
      ],
      streamCursor: { epoch: 1, seq: 2 },
    };
    // 首次加载 + open 恢复。
    expect(calls(fetchMock, MESSAGES)).toHaveLength(2);
    act(() => {
      source.emitData("turn.start", "1:1", { messageId: 2 });
    });
    act(() => {
      source.emitData("approval.request", "1:2", {
        messageId: 2,
        approvalId: 9,
        tool: "bash",
        title: TITLE,
        expiresAt: T0 + 60_000,
      });
    });
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(3);
    expect(assistants()).toHaveLength(2);
    expect(within(assistants()[1] as HTMLElement).queryAllByRole("group")).toHaveLength(0);
    const [group] = cards() as [HTMLElement];
    fireEvent.click(button(group, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(9))).toEqual([{ decision: "allow" }]);

    const reads = calls(fetchMock, MESSAGES).length;
    expect(reads).toBe(3);
    const sources = FakeEventSource.instances.length;
    prompt.resolve(jsonResponse({ userMessageId: 1, assistantMessageId: 2 }, 202));
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(source.closeCount).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(sources + 1);
  });
});

describe("approval prompt card: source guards", () => {
  it("G2 turn-actions.ts owns no React state and does not import the page", () => {
    const source = readRepoFile("web/src/features/chat/turn-actions.ts");
    for (const banned of ["useState(", "useEffect(", "useRef(", "useMemo(", "./page.js"]) {
      expect(source).not.toContain(banned);
    }
  });
});
