// issue 1446（#910 切片 5b）：chat-web「消息线程」的「等待指示与小圆点」段与场景「等待指示」。
// seam：判据是纯函数，逐个分支直接调；呈现走整页挂载 + 假 API / 假 EventSource，期望值取自场景字面量。
// jsdom 不加载样式表：流光与 reduce 下暂停只钉工具类，计算样式由 ui-walk 第 2 步在真实浏览器里读。
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { hasVisibleBlock } from "../src/features/chat/message-waiting.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, latestSource, SESSION_ID } from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

afterEach(cleanupChatPage);

const WAITING = '[data-slot="message-waiting"]';
const CARET = '[data-slot="message-caret"]';
const FOLD = '[data-slot="reasoning-root"]';
const RETRYING = "上游出错，正在重试…";

const NOTHING = {
  approvals: [],
  error: null,
  retrying: false,
  steps: [],
  text: "",
  thinking: "",
} satisfies Parameters<typeof hasVisibleBlock>[0];

const APPROVAL = { id: 1, tool: "bash", title: "ls", expiresAt: 1 };
const STEP = {
  id: 1,
  ordinal: 0,
  name: "bash",
  detail: "ls",
  output: "",
  status: "running" as const,
  changes: null,
};

describe("hasVisibleBlock：可见块判据（纯函数）", () => {
  it("没有思考、正文、步骤、已结算审批、错误与重试时为假", () => {
    expect(hasVisibleBlock(NOTHING)).toBe(false);
  });

  it("思考、正文、步骤、已结算审批、错误、重试中任一项单独即为真", () => {
    const cases = {
      thinking: { thinking: "想" },
      text: { text: "答" },
      steps: { steps: [STEP] },
      allow: { approvals: [{ ...APPROVAL, decision: "allow" as const }] },
      deny: { approvals: [{ ...APPROVAL, decision: "deny" as const }] },
      timeout: { approvals: [{ ...APPROVAL, decision: "timeout" as const }] },
      error: {
        error: { reason: "upstream_error" as const, message: "上游出错", status: null, detail: "" },
      },
      retrying: { retrying: true },
    };
    for (const [name, fields] of Object.entries(cases)) {
      expect(hasVisibleBlock({ ...NOTHING, ...fields }), name).toBe(true);
    }
  });

  it("待决审批在停靠区，不算可见块；与已结算审批同在时以后者为准", () => {
    const pending = { ...APPROVAL, decision: null };
    expect(hasVisibleBlock({ ...NOTHING, approvals: [pending] })).toBe(false);
    const settled = { ...APPROVAL, id: 2, decision: "allow" as const };
    expect(hasVisibleBlock({ ...NOTHING, approvals: [pending, settled] })).toBe(true);
  });
});

/** 选中一个 running 会话：助手消息还没有任何内容（`chatSnapshot()` 缺省即此），事件从 `1:1` 起。 */
async function mountWaiting() {
  const snapshot = chatSnapshot();
  renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [`/api/sessions/${SESSION_ID}/messages`]: () => jsonResponse(snapshot),
  });
  const article = await screen.findByRole("article", { name: "助手" });
  await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
  const source = latestSource();
  act(() => source.emitOpen());
  let seq = 0;
  const emit = (type: string, data: unknown) => {
    seq += 1;
    act(() => source.emitData(type, `1:${String(seq)}`, data));
  };
  return { article, emit };
}

/** 内容到达之前：消息内只有 `role="status"` 的 `正在思考…`，没有小圆点、没有折叠块。 */
function expectWaitingOnly(article: HTMLElement) {
  const waiting = article.querySelector(WAITING);
  expect(waiting?.getAttribute("role")).toBe("status");
  expect(waiting?.textContent).toBe("正在思考…");
  expect(within(article).getAllByRole("status")).toEqual([waiting]);
  // 消息的内容区只有它：没有正文、步骤、审批、错误，也没有操作行。
  expect([...(article.querySelector('[data-slot="message-content"]')?.children ?? [])]).toEqual([
    waiting,
  ]);
  expect(article.querySelector(CARET)).toBeNull();
  expect(article.querySelector(FOLD)).toBeNull();
}

/** 已有可见块且仍在运行：没有等待指示，恰一个小圆点。 */
async function expectDotOnly(article: HTMLElement) {
  await waitFor(() => expect(article.querySelectorAll(CARET)).toHaveLength(1));
  expect(article.querySelector(WAITING)).toBeNull();
}

/** 终态：二者都不显示。 */
async function expectNeither(article: HTMLElement) {
  await waitFor(() => expect(article.querySelector(CARET)).toBeNull());
  expect(article.querySelector(WAITING)).toBeNull();
}

describe("chat-web「等待指示」：首块到达前只有等待指示，之后只有小圆点", () => {
  it("等待指示带流光工具类，reduce 下由同一个元素的 motion-reduce 类停下", async () => {
    const { article } = await mountWaiting();
    expectWaitingOnly(article);
    const classes = [...(article.querySelector(WAITING)?.classList ?? [])];
    expect(classes).toEqual(expect.arrayContaining(["shimmer", "motion-reduce:animate-none"]));
  });

  it("先到 thinking.delta：折叠块出现、等待指示消失、小圆点出现，直到回合结束不再出现", async () => {
    const { article, emit } = await mountWaiting();
    expectWaitingOnly(article);

    emit("thinking.delta", { messageId: 0, delta: "先想一想" });
    await waitFor(() => expect(article.querySelector(FOLD)).not.toBeNull());
    await expectDotOnly(article);

    emit("text.delta", { messageId: 0, delta: "答" });
    await expectDotOnly(article);
    emit("step.start", { messageId: 0, stepId: 1, name: "bash", detail: "ls" });
    await expectDotOnly(article);
    emit("turn.end", { messageId: 0, status: "done" });
    await expectNeither(article);
  });

  it("先到 step.start：工具调用组出现、等待指示消失、小圆点出现，直到回合结束不再出现", async () => {
    const { article, emit } = await mountWaiting();
    expectWaitingOnly(article);

    emit("step.start", { messageId: 0, stepId: 1, name: "bash", detail: "ls" });
    await waitFor(() =>
      expect(within(article).getByRole("button", { name: "1 个步骤 · bash 运行中" })).toBeTruthy(),
    );
    await expectDotOnly(article);

    emit("step.end", { messageId: 0, stepId: 1, status: "done", output: "a" });
    await expectDotOnly(article);
    emit("text.delta", { messageId: 0, delta: "好了" });
    await expectDotOnly(article);
    emit("turn.end", { messageId: 0, status: "done" });
    await expectNeither(article);
  });

  it("先到 text.delta：正文出现、等待指示消失、小圆点在正文之后，直到回合结束不再出现", async () => {
    const { article, emit } = await mountWaiting();
    expectWaitingOnly(article);

    emit("text.delta", { messageId: 0, delta: "你好" });
    await expectDotOnly(article);
    const body = article.querySelector('[data-slot="message-body"]');
    expect(body?.lastElementChild?.matches(CARET)).toBe(true);
    expect(await within(article).findByText("你好")).toBeTruthy();

    emit("text.delta", { messageId: 0, delta: "，世界" });
    await expectDotOnly(article);
    emit("turn.end", { messageId: 0, status: "done" });
    await expectNeither(article);
  });

  it("尚无可见块时收到 turn.retry：重试提示出现、等待指示消失，运行中只剩小圆点", async () => {
    const { article, emit } = await mountWaiting();
    expectWaitingOnly(article);

    emit("turn.retry", { messageId: 0 });
    const hint = await within(article).findByText(RETRYING);
    expect(hint.getAttribute("role")).toBe("status");
    await expectDotOnly(article);

    // 重试结束于下一块内容：提示让位给正文，等待指示不回来。
    emit("text.delta", { messageId: 0, delta: "恢复了" });
    await waitFor(() => expect(within(article).queryByText(RETRYING)).toBeNull());
    await expectDotOnly(article);
  });

  it("尚无可见块时回合结束（done 或 stopped）：二者都不显示", async () => {
    for (const status of ["done", "stopped"] as const) {
      const { article, emit } = await mountWaiting();
      expectWaitingOnly(article);
      emit("turn.end", { messageId: 0, status });
      await expectNeither(article);
      cleanupChatPage();
    }
  });

  it("尚无可见块时收到 error 与 turn.end(failed)：二者都不显示，只显示分类错误", async () => {
    const { article, emit } = await mountWaiting();
    expectWaitingOnly(article);

    emit("error", {
      messageId: 0,
      reason: "upstream_error",
      message: "上游出错：模型服务内部错误",
      status: 503,
      detail: "",
    });
    emit("turn.end", { messageId: 0, status: "failed" });
    const alert = await within(article).findByRole("alert");
    expect(alert.textContent).toBe("上游出错：模型服务内部错误（HTTP 503）");
    await expectNeither(article);
    expect(within(article).queryAllByRole("status")).toEqual([]);
  });
});
