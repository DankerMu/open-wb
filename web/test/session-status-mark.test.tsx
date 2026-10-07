// 会话状态标记（session-sidebar「会话状态标记」两个场景、chat-web「列表条目的状态元素」）。
// seam：组件 `SessionStatusMark` 与 `sessionStatusText`。期望文案与属性值逐字取自规格条文。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStatusMark } from "../src/features/chat/session-status-mark.js";
import { SESSION_STATUS_LABEL, sessionStatusText } from "../src/features/chat/status-label.js";
import type { ChatSession } from "../src/lib/session-contract.js";

type State = Pick<ChatSession, "status" | "pendingApproval">;
type Row = { title: string; session: State; text: string; mark: string | null };

/** 「六种状态的呈现」的六个会话，次序与规格相同。 */
const SIX: Row[] = [
  {
    title: "一",
    session: { status: "running", pendingApproval: true },
    text: "等待确认",
    mark: "waiting",
  },
  {
    title: "二",
    session: { status: "running", pendingApproval: false },
    text: "运行中",
    mark: "running",
  },
  {
    title: "三",
    session: { status: "failed", pendingApproval: false },
    text: "失败",
    mark: "failed",
  },
  { title: "四", session: { status: "done", pendingApproval: false }, text: "已完成", mark: null },
  {
    title: "五",
    session: { status: "stopped", pendingApproval: false },
    text: "已停止",
    mark: null,
  },
  { title: "六", session: { status: "idle", pendingApproval: false }, text: "未开始", mark: null },
];

const marksIn = (root: Element) => [...root.querySelectorAll("[data-status-mark]")];

afterEach(cleanup);

describe("会话状态标记", () => {
  it("六种状态的呈现：可访问名以六种文案结尾，前三者各带一个可见标记，后三者没有", () => {
    render(
      <ul>
        {SIX.map((row) => (
          <li key={row.title}>
            <SessionStatusMark session={row.session} title={row.title} />
          </li>
        ))}
      </ul>,
    );
    const statuses = screen.getAllByRole("status");
    expect(statuses.map((element) => element.getAttribute("aria-label"))).toEqual([
      "一 等待确认",
      "二 运行中",
      "三 失败",
      "四 已完成",
      "五 已停止",
      "六 未开始",
    ]);
    expect(
      statuses.map((element) =>
        marksIn(element).map((mark) => mark.getAttribute("data-status-mark")),
      ),
    ).toEqual([["waiting"], ["running"], ["failed"], [], [], []]);
    for (const row of SIX) {
      expect(screen.getByRole("status", { name: `${row.title} ${row.text}` })).toBeTruthy();
    }
  });

  it.each(SIX)("$text：标记是装饰性的，文案只有一份且视觉隐藏", ({ title, session, text }) => {
    const { container } = render(<SessionStatusMark session={session} title={title} />);
    for (const mark of marksIn(container)) {
      expect(mark.getAttribute("aria-hidden")).toBe("true");
      expect(mark.textContent).toBe("");
      expect(mark.hasAttribute("tabindex")).toBe(false);
      expect(mark.tagName).toBe("SPAN");
    }
    const carriers = screen.getAllByText(text);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.classList.contains("sr-only")).toBe(true);
    expect(carriers[0]?.closest("[aria-hidden]")).toBeNull();
    expect(container.textContent).toBe(text);
  });

  it("待决确认结算后回到运行中：标记由 waiting 变为 running，可访问名随之改变", () => {
    const { container, rerender } = render(
      <SessionStatusMark session={{ status: "running", pendingApproval: true }} title="周报" />,
    );
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("周报 等待确认");
    expect(marksIn(container).map((mark) => mark.getAttribute("data-status-mark"))).toEqual([
      "waiting",
    ]);

    rerender(
      <SessionStatusMark session={{ status: "running", pendingApproval: false }} title="周报" />,
    );
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("周报 运行中");
    expect(marksIn(container).map((mark) => mark.getAttribute("data-status-mark"))).toEqual([
      "running",
    ]);
  });

  it.each(["idle", "running", "done", "failed", "stopped"] as const)(
    "pendingApproval 优先于 status=%s",
    (status) => {
      const session = { status, pendingApproval: true };
      const { container } = render(<SessionStatusMark session={session} title="甲" />);
      expect(sessionStatusText(session)).toBe("等待确认");
      expect(screen.getByRole("status", { name: "甲 等待确认" })).toBeTruthy();
      expect(marksIn(container).map((mark) => mark.getAttribute("data-status-mark"))).toEqual([
        "waiting",
      ]);
    },
  );

  it("减少动态效果下运行中的指示不转动；另外两种标记本来就不动", () => {
    const classesOf = (session: State) => {
      const { container, unmount } = render(<SessionStatusMark session={session} title="甲" />);
      const tokens = [...(marksIn(container)[0]?.classList ?? [])];
      unmount();
      return tokens;
    };
    const running = classesOf({ status: "running", pendingApproval: false });
    expect(running).toContain("animate-spin");
    expect(running).toContain("motion-reduce:animate-none");
    for (const session of [
      { status: "running", pendingApproval: true },
      { status: "failed", pendingApproval: false },
    ] as const) {
      expect(classesOf(session).filter((token) => token.includes("animate"))).toEqual([]);
    }
  });

  it("列表条目的状态元素：甲 等待确认 有可见标记，乙 已完成 没有", () => {
    render(
      <>
        <SessionStatusMark session={{ status: "running", pendingApproval: true }} title="甲" />
        <SessionStatusMark session={{ status: "done", pendingApproval: false }} title="乙" />
      </>,
    );
    expect(marksIn(screen.getByRole("status", { name: "甲 等待确认" }))).toHaveLength(1);
    expect(marksIn(screen.getByRole("status", { name: "乙 已完成" }))).toHaveLength(0);
  });
});

describe("sessionStatusText", () => {
  it("没有待决确认时取 SESSION_STATUS_LABEL，五个键原样", () => {
    expect(
      (["idle", "running", "done", "failed", "stopped"] as const).map((status) =>
        sessionStatusText({ status, pendingApproval: false }),
      ),
    ).toEqual(["未开始", "运行中", "已完成", "失败", "已停止"]);
    expect(SESSION_STATUS_LABEL).toEqual({
      idle: "未开始",
      running: "运行中",
      done: "已完成",
      failed: "失败",
      stopped: "已停止",
    });
  });
});
