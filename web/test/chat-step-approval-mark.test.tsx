// change chat-interleaved-segments 切片 8（issue 1476）：chat-web「步骤卡的确认标记」与 tool-approval「web 审批条」
// 的兜底记录（design D12，owner 裁定 B4、B9、B13）。seam：整页挂载 + 假 API / 假 EventSource；期望值取自规格场景的
// 字面量。配上本消息步骤的已结算确认只在步骤卡头留小标记（超时 → `超时自动允许`，拒绝 → `已拒绝`，允许不标），
// 配不上的仍是记录卡，位于分段区之后、错误文本之前。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Approval,
  approval,
  approvalPath,
  bodies,
  button,
  cards,
  flush,
  mountPage,
  snapshotWith,
  T0,
} from "./chat-approval-support.js";
import { cleanupChatPage } from "./chat-page-support.js";
import {
  assistant,
  contentOf,
  groups,
  isOpen,
  type Message,
  openSession,
  session,
  slots,
  step,
  triggerOf,
} from "./chat-segments-support.js";
import { historyUser } from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

const MARK = '[data-slot="step-approval-mark"]';
const RECORD_NAMES = ["已允许执行", "已拒绝执行", "超时自动允许"] as const;

afterEach(() => {
  cleanupChatPage();
  vi.useRealTimers();
});

/** 步骤卡（文档顺序）各自的确认小标记文本；没有标记为 null。 */
function marks(article = assistant()) {
  return [...article.querySelectorAll<HTMLElement>('[data-slot="step-card"]')].map(
    (card) => card.querySelector(MARK)?.textContent ?? null,
  );
}

/** 消息内兜底记录的可访问名（文档顺序），取自各记录 `aria-labelledby` 指向的元素。 */
function recordNames(article = assistant()) {
  return [...article.querySelectorAll<HTMLElement>('[data-slot="approval-record"]')].map(
    (record) => document.getElementById(record.getAttribute("aria-labelledby") ?? "")?.textContent,
  );
}

function expectNoRecord(article = assistant()) {
  for (const name of RECORD_NAMES) {
    expect(within(article).queryAllByRole("group", { name })).toHaveLength(0);
  }
  expect(article.querySelector('[data-slot="approval-records"]')).toBeNull();
}

function settled(id: number, decision: Approval["decision"], stepId: number | null): Approval {
  return approval(id, { decision, stepId, tool: "bash", title: "Allow tool: bash" });
}

function request(approvalId: number) {
  return {
    approvalId,
    tool: "bash",
    title: "Allow tool: bash",
    expiresAt: Date.now() + 60_000,
    stepId: null,
  };
}

function bashStart(stepId: number, approvalId: number) {
  return { stepId, name: "bash", detail: "ls", bodyOffset: 0, approvalId };
}

describe("chat-web「步骤卡的确认标记」", () => {
  it("超时、拒绝与正常允许：步骤 5 标 超时自动允许、步骤 6 标 已拒绝、步骤 10 不标；都不是兜底记录", async () => {
    const live = await openSession(session("running"));
    live.emit("approval.request", request(7));
    live.emit("step.start", bashStart(5, 7));
    live.emit("approval.request", request(8));
    live.emit("step.start", bashStart(6, 8));
    live.emit("approval.request", request(9));
    live.emit("step.start", bashStart(10, 9));

    const [group] = groups() as [HTMLElement];
    expect(groups()).toHaveLength(1);
    expect(isOpen(group)).toBe(false);
    expect(assistant().querySelectorAll(MARK)).toHaveLength(0);
    fireEvent.click(triggerOf(group));
    // resolved 到达之前三张卡都没有标记。
    expect(marks()).toEqual([null, null, null]);

    live.emit("approval.resolved", { approvalId: 7, decision: "timeout" });
    live.emit("approval.resolved", { approvalId: 8, decision: "deny" });
    live.emit("approval.resolved", { approvalId: 9, decision: "allow" });

    expect(cards()).toHaveLength(0);
    expect(marks()).toEqual(["超时自动允许", "已拒绝", null]);
    expectNoRecord();
    // 工具段收起时标记不可见（收起的组里没有步骤卡）。
    fireEvent.click(triggerOf(group));
    expect(isOpen(group)).toBe(false);
    expect(assistant().querySelectorAll(MARK)).toHaveLength(0);
  });

  it("标记是状态徽章之前的纯文本元素，不进徽章的可访问名与文本", async () => {
    await openSession(
      session("done", {
        steps: [step(5, 0, "bash", 0, "failed"), step(6, 1, "bash", 0, "done")],
        approvals: [settled(8, "deny", 5), settled(9, "timeout", 6)],
      }),
    );
    fireEvent.click(triggerOf(groups()[0] as HTMLElement));

    const article = within(assistant());
    const failed = article.getByRole("status", { name: "bash 失败" });
    const done = article.getByRole("status", { name: "bash 已完成" });
    expect([failed.textContent, done.textContent]).toEqual(["失败", "已完成"]);
    const found = [...assistant().querySelectorAll<HTMLElement>(MARK)];
    expect(found.map((mark) => mark.textContent)).toEqual(["已拒绝", "超时自动允许"]);
    for (const [index, mark] of found.entries()) {
      expect(mark.localName).toBe("span");
      expect(mark.getAttribute("role")).toBeNull();
      expect(mark.closest('[role="status"]')).toBeNull();
      expect(mark.nextElementSibling).toBe([failed, done][index]);
      expect(mark.querySelector("button, [role]")).toBeNull();
    }
    // 步骤卡（region）的名字仍只是步骤名。
    expect(article.getAllByRole("region", { name: "bash" })).toHaveLength(2);
  });

  it("快照原地重装带来 deny 结算后标记出现，不渲染兜底记录", async () => {
    const live = await openSession(session("running"));
    live.emit("approval.request", request(8));
    live.emit("step.start", bashStart(6, 8));
    fireEvent.click(triggerOf(groups()[0] as HTMLElement));
    expect(marks()).toEqual([null]);

    await live.resync(
      session("running", {
        steps: [{ ...step(6, 0, "bash", 0, "failed"), detail: "ls" }],
        approvals: [settled(8, "deny", 6)],
      }),
    );

    await waitFor(() => expect(marks()).toEqual(["已拒绝"]));
    expectNoRecord();
  });

  it("旧布局的消息同样适用：配上步骤的 deny 只在步骤卡上标 已拒绝，没有兜底记录", async () => {
    await openSession(
      session("done", {
        content: "答",
        steps: [step(5, 0, "bash", null, "failed")],
        approvals: [settled(8, "deny", 5)],
      }),
    );

    expect(slots()).toEqual(["message-body", "tool-group-root", "message-actions"]);
    expectNoRecord();
    fireEvent.click(triggerOf(groups()[0] as HTMLElement));
    expect(marks()).toEqual(["已拒绝"]);
  });
});

describe("tool-approval「web 审批条」：兜底记录", () => {
  it("已配对的已结算确认不渲染记录（允许，经点击作答）：展开后步骤 5 没有标记", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(T0);
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => jsonResponse(settled(7, "allow", 5)),
    });
    const emit = (type: string, seq: number, data: Record<string, unknown>) =>
      act(() => {
        source.emitData(type, `1:${String(seq)}`, { messageId: 0, ...data });
      });
    emit("approval.request", 1, request(7));
    emit("step.start", 2, bashStart(5, 7));
    await flush();

    fireEvent.click(button(cards()[0] as HTMLElement, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
    emit("approval.resolved", 3, { approvalId: 7, decision: "allow" });
    await flush();

    expect(cards()).toHaveLength(0);
    expectNoRecord();
    fireEvent.click(triggerOf(groups()[0] as HTMLElement));
    expect(within(assistant()).getByRole("status", { name: "bash 运行中" })).toBeTruthy();
    expect(marks()).toEqual([null]);
  });

  it("已配对的已结算确认不渲染记录（拒绝）：展开后步骤 6 标 已拒绝", async () => {
    const live = await openSession(session("running"));
    live.emit("approval.request", request(8));
    live.emit("step.start", bashStart(6, 8));
    live.emit("approval.resolved", { approvalId: 8, decision: "deny" });

    expect(cards()).toHaveLength(0);
    expectNoRecord();
    fireEvent.click(triggerOf(groups()[0] as HTMLElement));
    expect(marks()).toEqual(["已拒绝"]);
  });

  it("已配对的已结算确认不渲染记录：以快照重新加载两条消息（stepId 5 与 6）后同样", async () => {
    const base = session("done", {
      content: "第一条",
      steps: [step(5, 0, "bash", 0)],
      approvals: [settled(7, "allow", 5)],
    });
    const second: Message = {
      ...(base.messages[1] as Message),
      id: 2,
      content: "第二条",
      createdAt: 2,
      steps: [step(6, 0, "bash", 0, "failed")],
      approvals: [settled(8, "deny", 6)],
    };
    await openSession({
      ...base,
      messages: [...base.messages, { ...historyUser, id: 1, createdAt: 1 }, second],
    });

    const [first, last] = screen.getAllByRole("article", { name: "助手" }) as [
      HTMLElement,
      HTMLElement,
    ];
    for (const article of [first, last]) {
      expectNoRecord(article);
      fireEvent.click(triggerOf(groups(article)[0] as HTMLElement));
    }
    expect([marks(first), marks(last)]).toEqual([[null], ["已拒绝"]]);
  });

  it("配不上本消息步骤的已结算确认是兜底记录，按 id 升序，位于分段区之后、错误文本之前", async () => {
    await openSession(
      session("failed", {
        content: "答",
        steps: [step(5, 0, "bash", 0)],
        approvals: [settled(3, "allow", null), settled(4, "deny", 999), settled(6, "timeout", 5)],
        error: { reason: "upstream_timeout", message: "上游超时", status: null, detail: "" },
      }),
    );

    expect(slots().slice(0, 4)).toEqual([
      "tool-group-root",
      "message-body",
      "approval-records",
      "message-error",
    ]);
    expect(recordNames()).toEqual(["已允许执行", "已拒绝执行"]);
    expect(within(assistant()).queryAllByRole("group", { name: "超时自动允许" })).toHaveLength(0);
    expect(contentOf().children[2]?.querySelectorAll('[data-slot="approval-record"]')).toHaveLength(
      2,
    );
    fireEvent.click(triggerOf(groups()[0] as HTMLElement));
    expect(marks()).toEqual(["超时自动允许"]);
  });
});
