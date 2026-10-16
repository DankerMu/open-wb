// change chat-interleaved-segments 切片 6（issue 1475）：chat-web「消息线程」的「分段布局的块次序」「分段布局下的
// 小圆点」「分段区没有块时的小圆点」与分段下的「正文逐字展开」，以及「工具段摘要与折叠」「展开态只随用户点击
// 变化」的双工具段部分。seam：整页挂载 + 假 API / 假 EventSource（chat-segments-support.tsx），期望值取自规格
// 场景的字面量。「分段布局的块次序」里「消息内没有兜底确认记录」与「bash 步骤卡带 超时自动允许」两条依赖切片 8，
// 留给 8.2，这里只断言分段区的块与次序、操作行与 `复制`。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupChatPage } from "./chat-page-support.js";
import {
  assistant,
  BODY,
  CARET,
  contentOf,
  folds,
  groups,
  isOpen,
  openSession,
  segment,
  session,
  slots,
  step,
  titleOf,
  triggerOf,
} from "./chat-segments-support.js";

afterEach(() => {
  cleanupChatPage();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

function bodies() {
  return [...assistant().querySelectorAll<HTMLElement>(BODY)];
}

function carets() {
  return [...assistant().querySelectorAll<HTMLElement>(CARET)];
}

/** 唯一的小圆点；断言消息内恰一个。 */
function onlyCaret() {
  const found = carets();
  expect(found).toHaveLength(1);
  return found[0] as HTMLElement;
}

describe("chat-web「消息线程」：分段布局的块次序", () => {
  it("正文段、工具段（读取）、折叠块（已思考 2 秒）、工具段（执行命令）、正文段，均收起；复制写入全文", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const read = step(41, 0, "read", 5);
    const bash = step(42, 1, "bash", 5);
    await openSession(
      session("done", {
        content: "先看一下。看完了，结论如下。",
        thinking: "想想再答",
        thinkingMs: 2100,
        thinkingSegments: [segment(5, 0, 4, 1, 2100)],
        steps: [read, bash],
        approvals: [
          {
            id: 9,
            tool: "bash",
            title: "Allow tool: bash",
            requestedAt: 1,
            expiresAt: 2,
            decision: "timeout",
            stepId: bash.id,
          },
        ],
      }),
    );

    const parts = [...contentOf().children] as HTMLElement[];
    expect(slots().slice(0, 5)).toEqual([
      "message-body",
      "tool-group-root",
      "reasoning-root",
      "tool-group-root",
      "message-body",
    ]);
    expect(slots().at(-1)).toBe("message-actions");
    expect(parts[0]?.textContent).toBe("先看一下。");
    expect(parts[4]?.textContent).toBe("看完了，结论如下。");
    const [first, second] = groups();
    expect([first, second]).toEqual([parts[1], parts[3]]);
    expect(triggerOf(first as HTMLElement).textContent).toBe("读取 1 个文件");
    expect(triggerOf(second as HTMLElement).textContent).toBe("执行 1 条命令");
    expect([first, second].map((group) => isOpen(group as HTMLElement))).toEqual([false, false]);
    expect(folds()).toEqual([parts[2]]);
    expect(titleOf(parts[2] as HTMLElement)).toEqual(["已思考 2 秒", false]);
    expect(isOpen(parts[2] as HTMLElement)).toBe(false);

    fireEvent.click(within(assistant()).getByRole("button", { name: "复制" }));
    await screen.findByText("已复制");
    expect(writeText.mock.calls).toEqual([["先看一下。看完了，结论如下。"]]);
  });

  it("先思考后正文：块键不撞，React 不报同级重复键，折叠块与正文段都在", async () => {
    const errors = vi.spyOn(console, "error");
    await openSession(
      session("done", {
        content: "答",
        thinking: "想",
        thinkingMs: 300,
        thinkingSegments: [segment(0, 0, 1, 0, 300)],
      }),
    );

    expect(slots()).toEqual(["reasoning-root", "message-body", "message-actions"]);
    const keyWarnings = errors.mock.calls.filter((call) => String(call[0]).includes("same key"));
    expect(keyWarnings).toEqual([]);
  });
});

describe("chat-web「消息线程」：分段布局下的小圆点", () => {
  it("step.start 之后小圆点单独在工具段之下；第二个正文段到达后在它的 MarkdownBody 之后；turn.end 后没有", async () => {
    const live = await openSession(session("running"));

    live.emit("text.delta", { delta: "先看一下。" });
    live.emit("step.start", {
      stepId: 21,
      name: "read",
      detail: "a.md",
      bodyOffset: 5,
      approvalId: null,
    });

    expect(slots()).toEqual(["message-body", "tool-group-root", "message-caret-row"]);
    const alone = onlyCaret();
    expect(alone.closest(BODY)).toBeNull();
    expect(alone.parentElement).toBe(contentOf().children[2]);

    live.emit("step.end", { stepId: 21, status: "done", output: "" });
    live.emit("text.delta", { delta: "好了" });

    expect(slots()).toEqual(["message-body", "tool-group-root", "message-body"]);
    const [, last] = bodies();
    const caret = onlyCaret();
    expect(caret.parentElement).toBe(last);
    expect(last?.lastElementChild).toBe(caret);
    expect(last?.textContent).toBe("好了");

    live.emit("turn.end", { status: "done" });
    expect(carets()).toEqual([]);
  });

  it("只有一段思考：没有 message-body，小圆点单独在折叠块之下", async () => {
    const live = await openSession(session("running"));

    live.emit("thinking.delta", { delta: "想" });

    expect(bodies()).toEqual([]);
    expect(slots()).toEqual(["reasoning-root", "message-caret-row"]);
    expect(onlyCaret().closest(BODY)).toBeNull();
  });

  it("已停止且没有正文段：（已停止生成）占位是分段区末尾的 message-body", async () => {
    const live = await openSession(session("running"));
    live.emit("step.start", {
      stepId: 21,
      name: "bash",
      detail: "ls",
      bodyOffset: 0,
      approvalId: null,
    });

    live.emit("turn.end", { status: "stopped" });

    expect(slots().slice(0, 3)).toEqual(["tool-group-root", "message-body", "message-stopped"]);
    expect(bodies().map((body) => body.textContent)).toEqual(["（已停止生成）"]);
    expect(carets()).toEqual([]);
  });
});

describe("chat-web「消息线程」：分段区没有块时的小圆点", () => {
  it("正文只有 \\n：恰一个小圆点单独一行在分段区的位置、没有 message-body；好了 到达后在该正文段末尾", async () => {
    const live = await openSession(session("running"));

    live.emit("text.delta", { delta: "\n" });

    expect(bodies()).toEqual([]);
    expect(assistant().querySelector('[data-slot="message-waiting"]')).toBeNull();
    expect(slots()[0]).toBe("message-caret-row");
    expect(onlyCaret().parentElement).toBe(contentOf().firstElementChild);

    live.emit("text.delta", { delta: "好了" });

    const [body] = bodies();
    expect(bodies()).toHaveLength(1);
    expect(onlyCaret().parentElement).toBe(body);
    expect(body?.lastElementChild).toBe(onlyCaret());
  });
});

const PAGE_CLOCK = ["requestAnimationFrame", "cancelAnimationFrame", "Date"] as const;
const TWO_HUNDRED = `${"春夏秋冬".repeat(48)}一二三甲乙丙丁戊`;

describe("chat-web「消息线程」：分段下的正文逐字展开", () => {
  it("被工具段隔开的第一个正文段不再增长，只有最后一个正文段逐帧由短到长", async () => {
    const live = await openSession(
      session("running", { content: "A", steps: [step(21, 0, "bash", 1, "done")] }),
    );
    await live.emitAsync("text.delta", { delta: "B" });
    expect(bodies().map((body) => body.textContent)).toEqual(["A", "B"]);
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });

    await live.emitAsync("text.delta", { delta: TWO_HUNDRED });

    const full = `B${TWO_HUNDRED}`;
    const lengths: number[] = [];
    for (let frame = 0; frame < 125 && bodies()[1]?.textContent !== full; frame += 1) {
      act(() => {
        vi.advanceTimersByTime(16);
      });
      const shown = bodies()[1]?.textContent ?? "";
      expect(full.startsWith(shown)).toBe(true);
      expect(bodies()[0]?.textContent).toBe("A");
      lengths.push(shown.length);
    }
    expect(bodies()[1]?.textContent).toBe(full);
    expect(new Set(lengths).size).toBeGreaterThan(10);
  });
});

describe("chat-web「工具段摘要与折叠」：展开态只随用户点击变化（双工具段）", () => {
  it("两个工具段互不影响；失败、新步骤并入与快照原地重装都不改变展开态；收起后保持收起", async () => {
    const live = await openSession(session("running"));
    live.emit("text.delta", { delta: "先" });
    live.emit("step.start", {
      stepId: 21,
      name: "read",
      detail: "a",
      bodyOffset: 1,
      approvalId: null,
    });
    live.emit("step.end", { stepId: 21, status: "done", output: "" });
    live.emit("text.delta", { delta: "再" });
    live.emit("step.start", {
      stepId: 22,
      name: "bash",
      detail: "b",
      bodyOffset: 2,
      approvalId: null,
    });
    const [first, second] = groups() as [HTMLElement, HTMLElement];
    expect(slots().slice(0, 4)).toEqual([
      "message-body",
      "tool-group-root",
      "message-body",
      "tool-group-root",
    ]);
    const states = () => groups().map(isOpen);

    fireEvent.click(triggerOf(first));
    expect(states()).toEqual([true, false]);
    live.emit("step.end", { stepId: 22, status: "failed", output: "boom" });
    expect(states()).toEqual([true, false]);
    // 新步骤只会并入最后一个工具段（偏移单调），所以并入的是第二个；第一个的展开态照样保留。
    live.emit("step.start", {
      stepId: 23,
      name: "bash",
      detail: "c",
      bodyOffset: 2,
      approvalId: null,
    });
    expect(triggerOf(second).textContent).toBe("执行 2 条命令，1 步失败，进行中");
    expect(groups()).toEqual([first, second]);
    expect(states()).toEqual([true, false]);

    await live.resync(
      session("running", {
        content: "先再",
        steps: [
          { ...step(21, 0, "read", 1), detail: "a" },
          { ...step(22, 1, "bash", 2, "failed"), detail: "b", output: "boom" },
          { ...step(23, 2, "bash", 2, "running"), detail: "c" },
        ],
      }),
    );
    await waitFor(() => expect(groups()).toEqual([first, second]));
    expect(states()).toEqual([true, false]);

    fireEvent.click(triggerOf(first));
    live.emit("step.end", { stepId: 23, status: "done", output: "" });
    expect(states()).toEqual([false, false]);
  });
});
