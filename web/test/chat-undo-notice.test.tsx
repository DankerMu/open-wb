// 撤回后的「未还原文件」说明（message-undo「web 撤回」：「列出未还原的文件」「未还原文件被截断」）：
// 出现、次序、末行，以及关闭、发送、切换会话、换账号与下一次撤回时的去留。seam：整页挂载 + 假 API。
import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderChatPageWithAuthProbe, renewAccount } from "./chat-page-lifecycle-support.js";
import { OTHER_SESSION_ID, promptAccepted, SESSION_PROMPT } from "./chat-page-ownership-support.js";
import { chooseEntryAction } from "./chat-page-session-meta-support.js";
import { FakeEventSource, latestSource, SESSION_ID } from "./chat-stream-support.js";
import {
  alerts,
  cleanupUndoPage,
  clickUndo,
  envelope,
  FULL,
  flush,
  GUIDANCE,
  LIST,
  MESSAGES,
  mount,
  nav,
  REWOUND_SESSION,
  S,
  selectInNav,
  snapshotOf,
  TRIMMED,
  textarea,
  transcript,
  typeDraft,
  UNDO,
  UNRESTORED,
  undoBodies,
  undoButton,
  undone,
  userArticles,
} from "./chat-undo-support.js";
import { calls, deferredResponse, jsonResponse } from "./support.js";

const DISMISS = "关闭提示";
const MORE = "等共";
const NONE = { count: 0, paths: [] };
/** 场景「列出未还原的文件」的 `files`。 */
const BIG = {
  skipped: { count: 1, paths: [{ path: "big.bin", reason: "too_large" as const }] },
  failed: NONE,
};
/** 场景「未还原文件被截断」的 `files`。 */
const TRUNCATED = {
  skipped: { count: 3, paths: [{ path: "a.bin", reason: "too_large" as const }] },
  failed: { count: 1, paths: [{ path: "b.txt" }] },
};
const EMPTY = snapshotOf({ ...REWOUND_SESSION, status: "idle" }, []);
const REWOUND_READ = () => jsonResponse(snapshotOf(REWOUND_SESSION, S.messages.slice(0, 2)));

type Files = NonNullable<Parameters<typeof undone>[2]>;

/** 第一次撤回（u3）带 `first`；第二次撤回（u1）带 `second`，其后的快照为空。 */
function twoUndos(first: Files, second: Files) {
  let posts = 0;
  return () => {
    posts += 1;
    return posts === 1
      ? undone(REWOUND_READ, "第二个问题", first)
      : undone(() => jsonResponse(EMPTY), "第一个问题", second);
  };
}

/** 说明的容器：页面上有多个 `role="status"`，按标题文本定位。没有时为 null。 */
function notice() {
  const title = screen.queryByText(UNRESTORED);
  if (title === null) {
    return null;
  }
  const container = title.closest<HTMLElement>('[role="status"]');
  expect(container).not.toBeNull();
  return container;
}

function shownNotice() {
  const container = notice();
  expect(container).not.toBeNull();
  return container as HTMLElement;
}

/** 说明里的各行，依文档次序。 */
function lines(container: HTMLElement = shownNotice()) {
  return within(container)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

/** 第一条用户消息（u1）的 `撤回`。 */
function firstUndo() {
  return undoButton((userArticles() as [HTMLElement])[0]);
}

function send(text: string) {
  typeDraft(text);
  fireEvent.submit(textarea().closest("form") as HTMLFormElement);
}

/** 记下此后任何一次提交里是否渲染过说明的标题（含随即被撤掉的一闪）。 */
function watchNotice() {
  const added = (records: MutationRecord[]) =>
    records
      .flatMap((record) => [...record.addedNodes])
      .filter((node) => node.textContent?.includes(UNRESTORED)).length;
  let count = 0;
  const observer = new MutationObserver((records) => {
    count += added(records);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    seen() {
      count += added(observer.takeRecords());
      observer.disconnect();
      return count;
    },
  };
}

afterEach(cleanupUndoPage);

describe("未还原文件说明", () => {
  it("列出未还原的文件：输入框上方出现标题与 big.bin，没有「等共」；关闭后消失", async () => {
    const { fetchMock } = await mount(S, { [UNDO]: () => undone(undefined, undefined, BIG) });
    expect(notice()).toBeNull();
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));

    const container = shownNotice();
    expect(container.getAttribute("role")).toBe("status");
    expect(lines(container)).toEqual(["big.bin"]);
    expect(container.textContent).not.toContain(MORE);
    // 不显示原因。
    expect(container.textContent).not.toContain("too_large");
    // 就地显示在输入框上方、线程之下。
    const thread = screen.getByRole("region", { name: "消息" });
    const form = textarea().closest("form") as HTMLFormElement;
    expect(
      thread.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form.contains(container)).toBe(false);
    expect(textarea().value).toBe("第二个问题");
    expect(alerts()).toEqual([]);
    expect(document.querySelector(".ui-toast")).toBeNull();

    const dismiss = within(container).getByRole<HTMLButtonElement>("button", { name: DISMISS });
    expect(dismiss.type).toBe("button");
    // 按钮随说明卸载：焦点交给输入框，不落回 body（jsdom 的 click 不移焦点，先聚焦按钮）。
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(textarea());
    // 关闭不动草稿、线程，也不发请求。
    expect(textarea().value).toBe("第二个问题");
    expect(transcript()).toEqual(TRIMMED);
    expect(undoBodies(fetchMock)).toHaveLength(1);
  });

  it.each([
    ["被受理", () => jsonResponse(promptAccepted, 202), [] as string[]],
    [
      "被拒",
      () => jsonResponse(envelope("agent_unavailable", "Agent 不可用"), 502),
      ["Agent 不可用"],
    ],
  ] as const)(
    "列出未还原的文件：关闭后再撤回一次重现；发送下一条后消失，发送%s、落定之后也不再出现",
    async (_, reply, expectedAlerts) => {
      const prompt = deferredResponse();
      const { fetchMock } = await mount(S, {
        [UNDO]: twoUndos(BIG, BIG),
        [SESSION_PROMPT]: () => prompt.promise,
      });
      await clickUndo();
      await waitFor(() => expect(transcript()).toEqual(TRIMMED));
      fireEvent.click(within(shownNotice()).getByRole("button", { name: DISMISS }));
      expect(notice()).toBeNull();

      await clickUndo(firstUndo());
      await waitFor(() => expect(transcript()).toEqual([]));
      expect(undoBodies(fetchMock)).toHaveLength(2);
      expect(lines()).toEqual(["big.bin"]);

      send("下一条");
      expect(calls(fetchMock, SESSION_PROMPT)).toHaveLength(1);
      // 请求还在途，说明已经撤掉。
      expect(notice()).toBeNull();

      await act(async () => {
        prompt.resolve(reply());
      });
      await flush();
      expect(alerts()).toEqual(expectedAlerts);
      expect(notice()).toBeNull();
    },
  );

  it("未还原文件被截断：依次是 a.bin、b.txt、等共 4 项", async () => {
    await mount(S, { [UNDO]: () => undone(undefined, undefined, TRUNCATED) });
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));
    expect(lines()).toEqual(["a.bin", "b.txt", "等共 4 项"]);
  });

  it("两张表各按响应里的次序、不去重；同名路径不触发 React 的 key 警告", async () => {
    const consoleError = vi.spyOn(console, "error");
    const files = {
      skipped: {
        count: 3,
        paths: [
          { path: "z/dup", reason: "name_encoding" as const },
          { path: "a.bin", reason: "too_large" as const },
          { path: "z/dup", reason: "name_encoding" as const },
        ],
      },
      failed: { count: 2, paths: [{ path: "z/dup" }, { path: "b.txt" }] },
    };
    await mount(S, { [UNDO]: () => undone(undefined, undefined, files) });
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));
    expect(lines()).toEqual(["z/dup", "a.bin", "z/dup", "z/dup", "b.txt"]);
    expect(shownNotice().textContent).not.toContain(MORE);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("只有 failed 时同样显示", async () => {
    const files = { skipped: NONE, failed: { count: 1, paths: [{ path: "out/b.html" }] } };
    await mount(S, { [UNDO]: () => undone(undefined, undefined, files) });
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));
    expect(lines()).toEqual(["out/b.html"]);
  });

  it("切到别的会话再回来：两边都没有说明", async () => {
    await mount(S, { [UNDO]: () => undone(undefined, undefined, BIG) }, true);
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));
    expect(lines()).toEqual(["big.bin"]);

    await selectInNav("other session", OTHER_SESSION_ID);
    expect(transcript()).toEqual(["B 问", "B 回答"]);
    expect(notice()).toBeNull();

    await selectInNav("saved title", SESSION_ID);
    act(() => latestSource().emitOpen());
    await flush();
    expect(transcript()).toEqual(TRIMMED);
    expect(notice()).toBeNull();
  });

  it("请求在途时切到别的会话，迟到的 200 带 skipped：那边没有说明，回来也没有（一闪也没有）", async () => {
    const undo = deferredResponse();
    const { fetchMock } = await mount(S, { [UNDO]: () => undo.promise }, true);
    await clickUndo();
    expect(undoBodies(fetchMock)).toHaveLength(1);
    await selectInNav("other session", OTHER_SESSION_ID);
    const watch = watchNotice();

    await act(async () => {
      undo.resolve(undone(undefined, undefined, BIG));
    });
    await flush();
    expect(transcript()).toEqual(["B 问", "B 回答"]);
    expect(notice()).toBeNull();

    await selectInNav("saved title", SESSION_ID);
    act(() => latestSource().emitOpen());
    await flush();
    expect(transcript()).toEqual(TRIMMED);
    expect(notice()).toBeNull();
    expect(watch.seen()).toBe(0);
  });

  it("说明在场时第二次撤回返回 0/0：说明撤掉", async () => {
    const { fetchMock } = await mount(S, { [UNDO]: twoUndos(BIG, {}) });
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));
    expect(lines()).toEqual(["big.bin"]);

    await clickUndo(firstUndo());
    await waitFor(() => expect(transcript()).toEqual([]));
    expect(undoBodies(fetchMock)).toHaveLength(2);
    expect(textarea().value).toBe("第一个问题");
    expect(notice()).toBeNull();
  });

  it("说明在场时第二次撤回带另一份 files：以新的一份为准", async () => {
    await mount(S, { [UNDO]: twoUndos(BIG, TRUNCATED) });
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));
    await clickUndo(firstUndo());
    await waitFor(() => expect(transcript()).toEqual([]));
    expect(lines()).toEqual(["a.bin", "b.txt", "等共 4 项"]);
  });

  it("200 之后的重读失败：说明照留", async () => {
    await mount(S, {
      [UNDO]: () =>
        undone(
          () => jsonResponse(envelope("agent_unavailable", "Agent 不可用"), 502),
          undefined,
          BIG,
        ),
    });
    await clickUndo();
    expect(alerts()).toEqual([`Agent 不可用。${GUIDANCE}`]);
    expect(transcript()).toEqual(FULL);
    expect(lines()).toEqual(["big.bin"]);
  });

  it("换账号后不再出现", async () => {
    const { getProbe } = renderChatPageWithAuthProbe(`/?session=${SESSION_ID}`, {
      [LIST]: () => jsonResponse({ sessions: [S.session] }),
      [MESSAGES]: () => jsonResponse(S),
      [UNDO]: () => undone(undefined, undefined, BIG),
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(textarea().disabled).toBe(false));
    await clickUndo();
    await waitFor(() => expect(lines()).toEqual(["big.bin"]));

    await renewAccount(getProbe);
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();
    await flush();
    await waitFor(() => expect(textarea().disabled).toBe(false));
    expect(notice()).toBeNull();
  });

  it("会话被归档后只读：说明不渲染", async () => {
    const archived = { ...REWOUND_SESSION, archivedAt: 1_760_000_000_000 };
    await mount(S, {
      [UNDO]: () => undone(undefined, undefined, BIG),
      [`/api/sessions/${SESSION_ID}`]: () => jsonResponse(archived),
    });
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));
    expect(lines()).toEqual(["big.bin"]);

    await chooseEntryAction(nav(), "saved title", "归档");
    expect(await screen.findByText("该会话已归档，恢复后才能继续对话")).toBeTruthy();
    expect(notice()).toBeNull();
  });

  it("长列表：两张表各 200 行加末行都在说明里，容器自带限高与内部滚动", async () => {
    const skipped = Array.from({ length: 200 }, (_, i) => ({
      path: `s/${i}.bin`,
      reason: "too_large" as const,
    }));
    const failed = Array.from({ length: 200 }, (_, i) => ({ path: `f/${i}.txt` }));
    const files = {
      skipped: { count: 260, paths: skipped },
      failed: { count: 201, paths: failed },
    };
    await mount(S, { [UNDO]: () => undone(undefined, undefined, files) });
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));
    const container = shownNotice();
    expect(lines(container)).toEqual([
      ...skipped.map((entry) => entry.path),
      ...failed.map((entry) => entry.path),
      "等共 461 项",
    ]);
    const classes = [container, ...container.querySelectorAll("*")].flatMap((element) => [
      ...element.classList,
    ]);
    expect(container.classList.contains("flex-none")).toBe(true);
    expect(classes.some((name) => name.startsWith("max-h-"))).toBe(true);
    expect(classes).toContain("overflow-y-auto");
  });
});
