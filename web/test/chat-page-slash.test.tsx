/**
 * Issue 556 斜杠命令候选 (parent tasks 10.5): J1–J14 of
 * openspec/changes/slash-command-menu/design.md. Seams: the jsdom chat page inside the real shell
 * over a stubbed `fetch` (the real `createApiClient`), the page beside an auth probe for the
 * account renewal, a recorded `scrollIntoView` (jsdom lacks it), `useSlashMenu` beside a bare
 * `Composer` (J11), the bare `Composer` (J13) and the static CSS text (J14). Expected values are
 * literals from the spec delta.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { quiesce } from "./chat-page-file-changes-support.js";
import { renewAccount, settleDeferredResponse, typeDraft } from "./chat-page-lifecycle-support.js";
import { composer, findMessageArea, SESSION_MESSAGES } from "./chat-page-ownership-support.js";
import { toasts } from "./chat-page-search-support.js";
import {
  CATALOGUE,
  COMMANDS,
  COMPACT,
  cardChildren,
  catalogue,
  commandCalls,
  composerReady,
  expectNothingSent,
  expectThreeCandidates,
  Harness,
  highlighted,
  interceptor,
  LABELS,
  labels,
  mountComposer,
  openAnswering,
  openProbed,
  openSession,
  openWelcome,
  optionOf,
  options,
  PANEL,
  panel,
  press,
  scrolls,
  selection,
  sentPrompts,
  skill,
  slashMenuFixture,
  TODO,
  type,
  untilAborted,
  WEEKLY,
  welcomePanel,
  welcomeRoutes,
} from "./chat-page-slash-support.js";
import { renderChatPage } from "./chat-page-support.js";
import { chatSnapshot } from "./chat-stream-support.js";
import { createFetchMock, deferredResponse, jsonResponse, paths } from "./support.js";
import {
  COLOR_LITERAL_PATTERNS,
  readRepoFile,
  ruleBody,
  stripComments,
  topLevelBlocks,
} from "./ui-support.js";

const NEAREST = { block: "nearest" };
const COMPOSING = { isComposing: true };
const IME_KEY = { keyCode: 229 };

slashMenuFixture();

describe("候选面板 (J1, J2)", () => {
  it("J1 a slash in the welcome composer lists the three commands above the textarea, the first one highlighted", async () => {
    const { fetchMock } = await openWelcome();
    expect(panel()).toBeNull();
    expect(commandCalls(fetchMock)).toHaveLength(0);

    await type("/");

    expectThreeCandidates();
    expect(cardChildren()).toEqual([
      "div.chat-slash",
      "label.ui-sr-only",
      "textarea.chat-composer-input",
      "div.chat-composer-toolbar",
      "div.chat-workspace-picker",
    ]);
    expect(commandCalls(fetchMock)).toEqual([
      [
        COMMANDS,
        {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: expect.any(AbortSignal),
        },
      ],
    ]);
  });

  it("J1 an option without a hint renders no hint element", async () => {
    await openWelcome(catalogue([TODO, skill("plain", "没有提示的技能", null)]));

    await type("/");

    expect(labels()).toEqual(["任务清单", "plain"]);
    expect(options().map((option) => option.querySelectorAll(".chat-slash-hint").length)).toEqual([
      1, 0,
    ]);
    expect(optionOf("plain").textContent).toBe("plain没有提示的技能");
  });

  it("J1 the panel works the same under StrictMode, with one catalogue request", async () => {
    const { fetchMock } = await openWelcome(catalogue(), true);

    await type("/");
    expectThreeCandidates();
    typeDraft("/t");
    expect(labels()).toEqual(["任务清单"]);

    expect(commandCalls(fetchMock)).toHaveLength(1);
  });

  it("J2 a slash in the composer of a selected session lists the same panel", async () => {
    const { fetchMock } = await openSession();

    await type("/");

    expectThreeCandidates();
    expect(cardChildren()).toEqual([
      "div.chat-slash",
      "label.ui-sr-only",
      "textarea.chat-composer-input",
      "div.chat-composer-toolbar",
    ]);
    expect(commandCalls(fetchMock)).toHaveLength(1);
  });
});

describe("过滤、移动与选中 (J3, J4)", () => {
  it("J3 /t keeps 任务清单 through ↓ and ↑, and Enter replaces the draft with `/todo ` without sending", async () => {
    const { fetchMock } = await welcomePanel("/t");
    composer().focus();

    expect(labels()).toEqual(["任务清单"]);
    expect(press("ArrowDown")).toBe(false);
    expect(highlighted()).toBe("任务清单");
    expect(press("ArrowUp")).toBe(false);
    expect(highlighted()).toBe("任务清单");

    const requests = paths(fetchMock);
    expect(press("Enter")).toBe(false);

    expect(composer().value).toBe("/todo ");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(composer());
    // Neither a createSession nor a prompt: no request at all.
    await expectNothingSent(fetchMock, requests);
    expect(commandCalls(fetchMock)).toHaveLength(1);
  });

  it("J3 a draft filtered by its label is picked by the name of the command", async () => {
    await welcomePanel("/week");

    expect(labels()).toEqual(["weekly-report"]);
    press("Enter");

    expect(composer().value).toBe("/skill:weekly-report ");
    expect(panel()).toBeNull();
  });

  it("J4 ↓ and ↑ move the highlight cyclically and scroll the highlighted option into view", async () => {
    await welcomePanel();
    const [first, second, third] = options();
    expect(scrolls).toEqual([]);

    expect(press("ArrowDown")).toBe(false);
    expect(highlighted()).toBe("任务清单");
    expect(selection()).toEqual(["false", "true", "false"]);
    expect(press("ArrowDown")).toBe(false);
    expect(highlighted()).toBe("weekly-report");
    expect(selection()).toEqual(["false", "false", "true"]);
    expect(press("ArrowDown")).toBe(false);
    expect(highlighted()).toBe("整理上下文");
    expect(selection()).toEqual(["true", "false", "false"]);
    expect(press("ArrowUp")).toBe(false);
    expect(highlighted()).toBe("weekly-report");
    expect(press("ArrowUp")).toBe(false);
    expect(highlighted()).toBe("任务清单");

    expect(options()).toEqual([first, second, third]);
    expect(scrolls).toEqual([
      [second, NEAREST],
      [third, NEAREST],
      [first, NEAREST],
      [third, NEAREST],
      [second, NEAREST],
    ]);
  });

  it("J4 a change of the draft puts the highlight back on the first option", async () => {
    await welcomePanel();
    press("ArrowDown");
    press("ArrowDown");
    expect(highlighted()).toBe("weekly-report");

    typeDraft("/skill");
    expect(labels()).toEqual(["weekly-report"]);
    typeDraft("/");

    expect(labels()).toEqual(LABELS);
    expect(highlighted()).toBe("整理上下文");
  });
});

describe("未命中与发送 (J5)", () => {
  it("J5 /help has no candidate, so Enter sends it unchanged and the user bubble shows it as typed", async () => {
    const { fetchMock } = await openAnswering("/help");

    typeDraft("/help");
    expect(panel()).toBeNull();
    expect(press("ArrowDown")).toBe(true);
    expect(press("Escape")).toBe(true);
    expect(press("Tab")).toBe(true);
    expect(composer().value).toBe("/help");
    expect(press("Enter")).toBe(false);

    expect(await sentPrompts(fetchMock)).toEqual([{ message: "/help" }]);
    const bubble = await within(await findMessageArea()).findByText("/help", { exact: true });
    expect(bubble.className).toBe("chat-msg-body");
    expect(bubble.closest("article")?.getAttribute("aria-label")).toBe("用户");
    expect(composer().value).toBe("");
  });

  it("J5 a picked command closes the panel, and the next Enter sends the draft as it is", async () => {
    const { fetchMock } = await openAnswering("/todo ");

    typeDraft("/t");
    press("Enter");
    expect(composer().value).toBe("/todo ");
    expect(await sentPrompts(fetchMock)).toEqual([]);

    expect(press("Enter")).toBe(false);

    expect(await sentPrompts(fetchMock)).toEqual([{ message: "/todo " }]);
  });
});

describe("关闭与重现 (J6)", () => {
  it("J6 Esc closes the panel without sending, and one more character shows it again", async () => {
    const { fetchMock } = await welcomePanel();
    const requests = paths(fetchMock);

    expect(press("Escape")).toBe(false);

    expect(panel()).toBeNull();
    expect(composer().value).toBe("/");
    // Closed: the keys are the composer's again, and Escape is no longer prevented.
    expect(press("Escape")).toBe(true);
    expect(press("ArrowDown")).toBe(true);
    expect(panel()).toBeNull();

    typeDraft("/t");

    expect(labels()).toEqual(["任务清单"]);
    await expectNothingSent(fetchMock, requests);
  });

  it("J6 a closed panel shows again on the same text once the draft has changed in between", async () => {
    await welcomePanel();
    press("ArrowDown");

    press("Escape");
    expect(panel()).toBeNull();
    typeDraft("/t");
    expect(labels()).toEqual(["任务清单"]);
    typeDraft("/");

    expect(labels()).toEqual(LABELS);
    expect(highlighted()).toBe("整理上下文");
  });

  it("J6 Shift+Esc closes the panel as Esc does: the key is prevented and nothing is sent", async () => {
    const { fetchMock } = await welcomePanel();
    const requests = paths(fetchMock);

    expect(press("Escape", { shiftKey: true })).toBe(false);

    expect(panel()).toBeNull();
    expect(composer().value).toBe("/");
    await expectNothingSent(fetchMock, requests);
  });
});

describe("输入法组合态 (J7)", () => {
  it("J7 a composing Enter neither picks nor sends, by isComposing and by key code 229", async () => {
    const { fetchMock } = await welcomePanel("/任");
    expect(labels()).toEqual(["任务清单"]);
    const requests = paths(fetchMock);

    expect(press("Enter", COMPOSING)).toBe(true);
    expect(press("Enter", IME_KEY)).toBe(true);
    expect(press("Tab", COMPOSING)).toBe(true);
    expect(press("Escape", IME_KEY)).toBe(true);

    expect(composer().value).toBe("/任");
    expect(labels()).toEqual(["任务清单"]);
    await expectNothingSent(fetchMock, requests);

    // The same key outside a composition picks.
    expect(press("Enter")).toBe(false);
    expect(composer().value).toBe("/todo ");
  });

  it("J7 a composing ArrowDown leaves the highlight on the first option and is not prevented", async () => {
    await welcomePanel();

    expect(press("ArrowDown", COMPOSING)).toBe(true);
    expect(press("ArrowDown", IME_KEY)).toBe(true);
    expect(press("ArrowUp", COMPOSING)).toBe(true);

    expect(highlighted()).toBe("整理上下文");
    expect(scrolls).toEqual([]);
    expect(press("ArrowDown")).toBe(false);
    expect(highlighted()).toBe("任务清单");
  });
});

describe("候选目录的拉取时机 (J8, J9)", () => {
  it("J8 no panel before the catalogue arrives, one request across re-entries, the panel on arrival", async () => {
    const pending = deferredResponse();
    const { fetchMock } = await openWelcome(() => pending.promise);

    await type("/");
    expect(panel()).toBeNull();
    expect(commandCalls(fetchMock)).toHaveLength(1);

    // A real rising edge while the request is in flight, then a change that keeps the condition.
    await type("");
    await type("/");
    await type("/t");
    await type("/");
    expect(panel()).toBeNull();
    expect(commandCalls(fetchMock)).toHaveLength(1);

    await settleDeferredResponse(pending, jsonResponse({ commands: CATALOGUE }));

    expect(labels()).toEqual(LABELS);
    typeDraft("");
    typeDraft("/t");
    expect(labels()).toEqual(["任务清单"]);
    await quiesce();
    expect(commandCalls(fetchMock)).toHaveLength(1);
  });

  it("J8 a catalogue that arrives after the draft stopped matching is kept for the next slash", async () => {
    const pending = deferredResponse();
    const { fetchMock } = await openWelcome(() => pending.promise);
    await type("/");

    await type("你好");
    const signal = commandCalls(fetchMock)[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    await settleDeferredResponse(pending, jsonResponse({ commands: CATALOGUE }));
    expect(panel()).toBeNull();
    expect(signal?.aborted).toBe(false);

    typeDraft("/");

    expect(labels()).toEqual(LABELS);
    await quiesce();
    expect(commandCalls(fetchMock)).toHaveLength(1);
  });

  it.each([
    ["a network failure", () => new Error("offline")],
    ["a 500", () => jsonResponse({ error: { code: "internal", message: "服务器内部错误" } }, 500)],
    ["a malformed catalogue", () => jsonResponse({ commands: [{ ...WEEKLY, hint: 1 }] })],
  ])(
    "J9 %s shows nothing and is retried only when the draft matches anew",
    async (_label, failure) => {
      let reads = 0;
      const { fetchMock } = await openWelcome(() => {
        reads += 1;
        return reads === 1 ? failure() : jsonResponse({ commands: CATALOGUE });
      });
      const alerts = screen.queryAllByRole("alert").length;
      const errors = vi.spyOn(console, "error");

      await type("/");

      expect(panel()).toBeNull();
      expect(commandCalls(fetchMock)).toHaveLength(1);
      expect(toasts()).toEqual([]);
      expect(screen.queryAllByRole("alert")).toHaveLength(alerts);
      expect(press("ArrowDown")).toBe(true);
      expect(press("Tab")).toBe(true);
      expect(composer().value).toBe("/");

      // Further typing while the condition holds starts no request.
      await type("/t");
      await type("/to");
      expect(panel()).toBeNull();
      expect(commandCalls(fetchMock)).toHaveLength(1);

      await type("");
      await type("/");

      expect(commandCalls(fetchMock)).toHaveLength(2);
      expect(labels()).toEqual(LABELS);
      expect(toasts()).toEqual([]);
      expect(screen.queryAllByRole("alert")).toHaveLength(alerts);
      expect(errors).not.toHaveBeenCalled();
    },
  );
});

describe("点击与 Tab 选中 (J10)", () => {
  it("J10 a click picks the clicked option without sending or taking the focus from the textarea", async () => {
    const { fetchMock } = await welcomePanel();
    composer().focus();
    const requests = paths(fetchMock);

    expect(fireEvent.mouseDown(optionOf("任务清单"))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("listbox", { name: PANEL }))).toBe(false);
    expect(highlighted()).toBe("整理上下文");
    fireEvent.click(optionOf("任务清单"));

    expect(composer().value).toBe("/todo ");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(composer());
    await expectNothingSent(fetchMock, requests);
  });

  it("J10 a click on the description of an option picks that option", async () => {
    await welcomePanel();

    fireEvent.click(within(optionOf("weekly-report")).getByText("写周报", { exact: true }));

    expect(composer().value).toBe("/skill:weekly-report ");
  });

  it("J10 Tab picks the highlighted option", async () => {
    const { fetchMock } = await welcomePanel();
    const requests = paths(fetchMock);
    press("ArrowDown");

    expect(press("Tab")).toBe(false);

    expect(composer().value).toBe("/todo ");
    expect(panel()).toBeNull();
    await expectNothingSent(fetchMock, requests);
  });

  it("J10 Shift+Tab, Shift+Enter and Shift with an arrow are left alone: no pick, no move, nothing sent", async () => {
    const { fetchMock } = await welcomePanel();
    const requests = paths(fetchMock);
    const shift = { shiftKey: true };

    expect(press("Tab", shift)).toBe(true);
    expect(press("Enter", shift)).toBe(true);
    expect(press("ArrowDown", shift)).toBe(true);
    expect(press("ArrowUp", shift)).toBe(true);

    expect(composer().value).toBe("/");
    expect(highlighted()).toBe("整理上下文");
    await expectNothingSent(fetchMock, requests);
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
  ])("J10 keys with %s are not intercepted", async (_label, modifier) => {
    const { fetchMock } = await welcomePanel();
    const requests = paths(fetchMock);

    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
      expect(press(key, modifier)).toBe(true);
    }

    expect(composer().value).toBe("/");
    expect(highlighted()).toBe("整理上下文");
    await expectNothingSent(fetchMock, requests);
  });

  it("J10 keys the panel does not use reach the composer untouched", async () => {
    await welcomePanel();

    for (const key of ["a", "ArrowLeft", "Home", " ", "Backspace"]) {
      expect(press(key)).toBe(true);
    }

    expect(highlighted()).toBe("整理上下文");
  });
});

describe("禁用 (J11)", () => {
  it("J11 a disabled composer holding a slash shows no panel and requests no catalogue", async () => {
    const fetchMock = createFetchMock({ [COMMANDS]: catalogue() });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<Harness enabled={false} />);
    await quiesce();

    expect(composer().value).toBe("/");
    expect(panel()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(press("ArrowDown")).toBe(true);

    view.rerender(<Harness enabled />);
    await quiesce();

    expect(labels()).toEqual(LABELS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.rerender(<Harness enabled={false} />);

    expect(panel()).toBeNull();
    expect(press("ArrowDown")).toBe(true);
    expect(press("Escape")).toBe(true);
    view.rerender(<Harness enabled />);
    await quiesce();
    expect(highlighted()).toBe("整理上下文");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("J11 the panel leaves when a running session locks the composer of the page, the draft kept", async () => {
    const running = chatSnapshot();
    const { fetchMock } = renderChatPage("/", {
      ...welcomeRoutes(catalogue()),
      "/api/sessions": () => jsonResponse({ sessions: [running.session] }),
      [SESSION_MESSAGES]: () => jsonResponse(running),
    });
    await composerReady();
    await type("/");
    expect(labels()).toEqual(LABELS);

    const list = screen.getByRole("navigation", { name: "会话列表" });
    fireEvent.click(within(list).getByRole("button", { name: "saved title" }));
    await waitFor(() => expect(composer().disabled).toBe(true));
    await quiesce();

    expect(composer().value).toBe("/");
    expect(composer().disabled).toBe(true);
    expect(panel()).toBeNull();
    expect(commandCalls(fetchMock)).toHaveLength(1);
  });
});

describe("client 身份变化与卸载 (J12)", () => {
  it("J12 a renewed account drops the catalogue, reads it again and shows the new one from its first option", async () => {
    const second = deferredResponse();
    const { fetchMock, getProbe } = await openProbed([
      jsonResponse({ commands: CATALOGUE }),
      second.promise,
    ]);
    await type("/");
    press("ArrowDown");
    press("ArrowDown");
    expect(highlighted()).toBe("weekly-report");

    await renewAccount(getProbe);
    await quiesce();

    expect(composer().value).toBe("/");
    expect(panel()).toBeNull();
    expect(commandCalls(fetchMock)).toHaveLength(2);

    await settleDeferredResponse(second, jsonResponse({ commands: [TODO, COMPACT] }));

    // The highlight was on the third option; the shorter catalogue starts over on its first.
    expect(labels()).toEqual(["任务清单", "整理上下文"]);
    expect(highlighted()).toBe("任务清单");
    expect(press("Enter")).toBe(false);
    expect(composer().value).toBe("/todo ");
  });

  it("J12 an arrow key moves from the first option of the shorter catalogue, not from the old highlight", async () => {
    const second = deferredResponse();
    const { getProbe } = await openProbed([
      jsonResponse({ commands: [...CATALOGUE, skill("minutes", "写会议纪要")] }),
      second.promise,
    ]);
    await type("/");
    press("ArrowUp");
    expect(highlighted()).toBe("minutes");

    await renewAccount(getProbe);
    await quiesce();
    await settleDeferredResponse(second, jsonResponse({ commands: [TODO, COMPACT] }));
    expect(highlighted()).toBe("任务清单");
    scrolls.length = 0;
    expect(press("ArrowDown")).toBe(false);

    // From the fourth of four options: one step from the first of two, not (3 + 1) mod 2 = 0.
    expect(highlighted()).toBe("整理上下文");
    expect(scrolls).toEqual([[optionOf("整理上下文"), NEAREST]]);
  });

  it("J12 a renewal aborts the catalogue request in flight and its late answer is not shown", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const { fetchMock, getProbe } = await openProbed([first.promise, second.promise]);
    await type("/");
    const signal = commandCalls(fetchMock)[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    await renewAccount(getProbe);
    await quiesce();

    expect(signal?.aborted).toBe(true);
    expect(commandCalls(fetchMock)).toHaveLength(2);
    expect(commandCalls(fetchMock)[1]?.[1]?.signal?.aborted).toBe(false);

    await settleDeferredResponse(first, jsonResponse({ commands: CATALOGUE }));
    expect(panel()).toBeNull();

    await settleDeferredResponse(second, jsonResponse({ commands: [WEEKLY] }));
    expect(labels()).toEqual(["weekly-report"]);
    expect(commandCalls(fetchMock)).toHaveLength(2);
  });

  it("J12 the late answer of the aborted request does not replace the catalogue of the new client already shown", async () => {
    const old = deferredResponse();
    const renewed = deferredResponse();
    const { fetchMock, getProbe } = await openProbed([old.promise, renewed.promise]);
    await type("/");
    await renewAccount(getProbe);
    await quiesce();
    await settleDeferredResponse(renewed, jsonResponse({ commands: [WEEKLY, TODO] }));
    expect(labels()).toEqual(["weekly-report", "任务清单"]);

    await settleDeferredResponse(old, jsonResponse({ commands: CATALOGUE }));

    expect(labels()).toEqual(["weekly-report", "任务清单"]);
    expect(highlighted()).toBe("weekly-report");
    // The catalogue is kept, so the draft matching anew starts no third request.
    await type("");
    await type("/");
    expect([labels(), commandCalls(fetchMock).length]).toEqual([["weekly-report", "任务清单"], 2]);
  });

  it("J12 an aborted request that fails, as fetch does, leaves the request of the new client in flight", async () => {
    const second = deferredResponse();
    let reads = 0;
    const { fetchMock, getProbe } = await openProbed((path, options) => {
      reads += 1;
      return reads === 1 ? untilAborted(path, options) : second.promise;
    });
    await type("/");

    await renewAccount(getProbe);
    await quiesce();
    expect(commandCalls(fetchMock)).toHaveLength(2);

    // The draft matches anew while the new client's request is in flight: no third request.
    await type("");
    await type("/");
    expect(commandCalls(fetchMock)).toHaveLength(2);

    await settleDeferredResponse(second, jsonResponse({ commands: [TODO] }));
    expect([labels(), commandCalls(fetchMock).length]).toEqual([["任务清单"], 2]);
  });

  it("J12 unmounting the page aborts the catalogue request in flight", async () => {
    const pending = deferredResponse();
    const { fetchMock, view } = await openWelcome(() => pending.promise);
    await type("/");
    const signal = commandCalls(fetchMock)[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    const errors = vi.spyOn(console, "error");

    view.unmount();

    expect(signal?.aborted).toBe(true);
    await settleDeferredResponse(pending, jsonResponse({ commands: CATALOGUE }));
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("Composer 插槽契约 (J13)", () => {
  it("J13 an interceptor that returns false leaves Enter to the composer, which submits once", () => {
    const interceptKeyDown = interceptor(false);
    const onSubmit = mountComposer({ interceptKeyDown });

    expect(press("Enter")).toBe(false);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(interceptKeyDown).toHaveBeenCalledTimes(1);
    expect(interceptKeyDown.mock.calls[0]?.[0].key).toBe("Enter");
    expect(press("a")).toBe(true);
    expect(interceptKeyDown).toHaveBeenCalledTimes(2);
  });

  it("J13 an interceptor that returns true keeps the composer from submitting or preventing the key", () => {
    const interceptKeyDown = interceptor(true);
    const onSubmit = mountComposer({ interceptKeyDown });

    expect(press("Enter")).toBe(true);

    expect(interceptKeyDown).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("J13 without an interceptor Enter submits as before", () => {
    const onSubmit = mountComposer({});

    expect(press("Enter")).toBe(false);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("J13 the slot node is rendered bare as the first child of the card", () => {
    mountComposer({ slashMenu: <div className="slot-probe">候选</div> });

    expect(cardChildren()).toEqual([
      "div.slot-probe",
      "label.ui-sr-only",
      "textarea.chat-composer-input",
      "div.chat-composer-toolbar",
    ]);
  });

  it("J13 a hidden panel leaves no wrapper in the card of a selected session", async () => {
    await openSession();
    const bare = ["label.ui-sr-only", "textarea.chat-composer-input", "div.chat-composer-toolbar"];
    expect(cardChildren()).toEqual(bare);

    await type("/help");
    expect(cardChildren()).toEqual(bare);
    await type("/");
    press("Escape");

    expect(cardChildren()).toEqual(bare);
  });

  it("J13 a hidden panel leaves no wrapper in the welcome card, which ends with its footer", async () => {
    await openWelcome();
    const bare = [
      "label.ui-sr-only",
      "textarea.chat-composer-input",
      "div.chat-composer-toolbar",
      "div.chat-workspace-picker",
    ];
    expect(cardChildren()).toEqual(bare);

    await type("/");
    typeDraft("/todo ");

    expect(cardChildren()).toEqual(bare);
  });
});

describe("样式契约 (J14)", () => {
  const TOKEN = /^var\(--wb-[a-z0-9-]+\)$/;
  const css = () => stripComments(readRepoFile("web/src/features/chat/messages.css"));
  /** The value of `property` in the rule of `selector`; undefined when the rule does not set it. */
  const declared = (selector: string, property: string) =>
    new RegExp(`(?<![-\\w])${property}\\s*:\\s*([^;]+);`).exec(ruleBody(css(), selector))?.[1];

  it("J14 the panel has a bounded height and scrolls vertically", () => {
    expect(declared(".chat-slash", "max-height")).toMatch(/^\d+px$/);
    expect(declared(".chat-slash", "overflow-y")).toBe("auto");
  });

  it("J14 the highlighted option has a background of its own, from a token", () => {
    expect(declared(".chat-slash-option--active", "background")).toMatch(TOKEN);
    expect(declared(".chat-slash-option", "background")).not.toBe(
      declared(".chat-slash-option--active", "background"),
    );
  });

  it("J14 the hint is muted text from a token, unlike the label", () => {
    expect(declared(".chat-slash-hint", "color")).toMatch(
      /^var\(--wb-text-(secondary|tertiary)\)$/,
    );
    expect(declared(".chat-slash-label", "color")).toBe("var(--wb-text-primary)");
  });

  it("J14 the panel rules hold no bare colour and take every colour from a token", () => {
    const rules = topLevelBlocks(css()).filter((block) => block.prelude.includes(".chat-slash"));
    const selectors = rules.map((block) => block.prelude);
    expect(selectors).toContain(".chat-slash-option--active");
    expect(selectors.length).toBeGreaterThan(3);

    const bodies = rules.map((block) => block.body).join("\n");
    for (const pattern of COLOR_LITERAL_PATTERNS) expect(bodies).not.toMatch(pattern);
    const colours = [
      ...bodies.matchAll(/(?<![-\w])(?:color|background(?:-color)?)\s*:\s*([^;]+);/g),
    ];
    expect(colours.length).toBeGreaterThan(3);
    for (const [, value] of colours) expect(value).toMatch(TOKEN);
    for (const [, value = ""] of bodies.matchAll(/(?<![-\w])border[-\w]*\s*:\s*([^;]+);/g)) {
      if (/[a-z]/i.test(value.replace(/\d+px|solid|var\([^)]*\)/g, ""))) {
        throw new Error(`border 声明含非 token 的值：${value}`);
      }
    }
  });
});
