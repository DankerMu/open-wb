import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickSend, typeDraft } from "./chat-page-lifecycle-support.js";
import {
  OTHER_MESSAGES,
  OTHER_SESSION_ID,
  otherIdleSession,
  otherSnapshot,
  promptAccepted,
  SESSION_MESSAGES,
  SESSION_PROMPT,
} from "./chat-page-ownership-support.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, historyUser, latestSource, SESSION_ID } from "./chat-stream-support.js";
import { calls, deferredResponse, jsonResponse } from "./support.js";
import { waitMs } from "./ui-support.js";

/* jsdom has no layout: scroll metrics of the thread viewport (the scroll container, selected by
   its `data-slot`) are mocked at the prototype level so that even the first mount's layout effect
   is observable. */
const VIEWPORT = '[data-slot="thread-viewport"]';
const METRIC_NAMES = ["scrollHeight", "clientHeight", "scrollTop"] as const;
const metrics = { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 };
let seq = 3;
/** When set, the viewport's `scrollHeight` is read from the DOM it holds at that moment. */
let renderedHeight: ((viewport: HTMLElement) => number) | null = null;

function scrollHeightOf(viewport: HTMLElement): number {
  return renderedHeight ? renderedHeight(viewport) : metrics.scrollHeight;
}

function isTranscript(element: HTMLElement): boolean {
  return element.matches(VIEWPORT);
}

function installMetrics() {
  const height = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
  const client = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isTranscript(this) ? scrollHeightOf(this) : height?.get?.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isTranscript(this) ? metrics.clientHeight : client?.get?.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return isTranscript(this) ? metrics.scrollTop : top?.get?.call(this);
    },
    set(this: HTMLElement, value: number) {
      if (!isTranscript(this)) {
        top?.set?.call(this, value);
        return;
      }
      const max = Math.max(scrollHeightOf(this) - metrics.clientHeight, 0);
      metrics.scrollTop = Math.min(Math.max(value, 0), max);
    },
  });
}

beforeEach(() => {
  Object.assign(metrics, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
  seq = 3;
  renderedHeight = null;
  installMetrics();
});

afterEach(() => {
  cleanupChatPage();
  for (const name of METRIC_NAMES) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

const runningSnapshot = () =>
  chatSnapshot({ assistantStatus: "running", content: "起始", cursor: { epoch: 1, seq: 3 } });

function transcript(): HTMLElement {
  const element = document.querySelector<HTMLElement>(VIEWPORT);
  if (!element) throw new Error("expected the thread viewport");
  return element;
}

function jumpButton() {
  return screen.queryByRole("button", { name: "回到最新" });
}

function assistantText(): string {
  return (
    document.querySelector('article[aria-label="助手"] [data-slot="message-body"]')?.textContent ??
    ""
  );
}

function userScroll(scrollTop: number) {
  metrics.scrollTop = scrollTop;
  fireEvent.scroll(transcript());
}

async function openStream() {
  await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
  act(() => {
    latestSource().emitOpen();
  });
}

/** Grows the content height first, then streams a delta and waits until it renders. */
async function growAndStream(scrollHeight: number, delta: string) {
  act(() => {
    metrics.scrollHeight = scrollHeight;
    seq += 1;
    latestSource().emitData("text.delta", `1:${seq}`, { messageId: 0, delta });
  });
  await waitFor(() => expect(assistantText()).toContain(delta));
}

async function openLongSession() {
  const mounted = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () =>
      jsonResponse({ sessions: [runningSnapshot().session, otherIdleSession()] }),
    [SESSION_MESSAGES]: () => jsonResponse(runningSnapshot()),
    [OTHER_MESSAGES]: () => {
      metrics.scrollHeight = 4000;
      return jsonResponse(otherSnapshot());
    },
  });
  await waitFor(() => expect(assistantText()).toContain("起始"));
  await openStream();
  expect(metrics.scrollTop).toBe(2500);
  return mounted;
}

describe("(F1) opening a long history starts at the bottom", () => {
  it("follows the content that arrives after mount, without a jump button", async () => {
    metrics.scrollHeight = 500;
    const history = deferredResponse();
    const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [runningSnapshot().session] }),
      [SESSION_MESSAGES]: () => history.promise,
    });
    await waitFor(() => expect(calls(fetchMock, SESSION_MESSAGES)).toHaveLength(1));
    expect(metrics.scrollTop).toBe(0);
    await act(async () => {
      metrics.scrollHeight = 3000;
      history.resolve(jsonResponse(runningSnapshot()));
    });
    await waitFor(() => expect(assistantText()).toContain("起始"));
    expect(metrics.scrollTop).toBe(2500);
    expect(jumpButton()).toBeNull();
  });
});

/* The runtime hands new messages to the thread one effect after the page state changed, so a
   recompute tied to the page state would measure the DOM without them. Here the height is a
   function of the rendered messages and no resize callback is ever delivered (the platform stub
   is a no-op): only a recompute in the commit that rendered the messages lands on their bottom. */
describe("(F1b) the recompute measures the DOM that holds the new messages", () => {
  it("lands on the bottom of the rendered history without a resize callback", async () => {
    renderedHeight = (viewport) => 500 + 1250 * viewport.querySelectorAll("article").length;
    const history = deferredResponse();
    const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [chatSnapshot().session] }),
      [SESSION_MESSAGES]: () => history.promise,
    });
    await waitFor(() => expect(calls(fetchMock, SESSION_MESSAGES)).toHaveLength(1));
    expect(metrics.scrollTop).toBe(0);
    await act(async () => {
      history.resolve(jsonResponse(chatSnapshot()));
    });
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(metrics.scrollTop).toBe(2500);
    expect(jumpButton()).toBeNull();
  });
});

describe("(F2) scrolled up more than a viewport", () => {
  it("shows the button and keeps the position when a delta arrives", async () => {
    await openLongSession();
    userScroll(1000);
    expect(jumpButton()).not.toBeNull();
    await growAndStream(3200, "增量一");
    expect(metrics.scrollTop).toBe(1000);
    expect(jumpButton()).not.toBeNull();
  });
});

describe("(F3) clicking 回到最新 resumes following", () => {
  it("scrolls to the bottom, hides the button and follows the next delta", async () => {
    await openLongSession();
    userScroll(1000);
    await growAndStream(3200, "增量一");
    const button = jumpButton();
    if (!button) throw new Error("expected the 回到最新 button");
    fireEvent.click(button);
    expect(metrics.scrollTop).toBe(2700);
    expect(jumpButton()).toBeNull();
    await growAndStream(3400, "增量二");
    expect(metrics.scrollTop).toBe(2900);
  });
});

describe("(F4) scrolled up less than a viewport", () => {
  it("keeps the position without a button until content growth exceeds a viewport", async () => {
    await openLongSession();
    userScroll(2200);
    expect(jumpButton()).toBeNull();
    await growAndStream(3200, "增量一");
    expect(metrics.scrollTop).toBe(2200);
    expect(jumpButton()).toBeNull();
    await growAndStream(3201, "增量二");
    expect(metrics.scrollTop).toBe(2200);
    expect(jumpButton()).not.toBeNull();
  });
});

describe("(F5) hysteresis and the 4px bottom tolerance", () => {
  it("keeps the button until the transcript is within 4px of the bottom", async () => {
    await openLongSession();
    userScroll(1000);
    expect(jumpButton()).not.toBeNull();
    userScroll(2200);
    expect(jumpButton()).not.toBeNull();
    userScroll(2495);
    expect(jumpButton()).not.toBeNull();
    userScroll(2496);
    expect(jumpButton()).toBeNull();
    await growAndStream(3100, "增量一");
    expect(metrics.scrollTop).toBe(2600);
  });
});

describe("(F6) switching sessions resets follow state", () => {
  it("starts the other session at its bottom without a button", async () => {
    const { router } = await openLongSession();
    userScroll(1000);
    expect(jumpButton()).not.toBeNull();
    await act(async () => {
      await router.navigate(`/?session=${OTHER_SESSION_ID}`);
    });
    expect(await screen.findByText("other user", { exact: true })).toBeTruthy();
    expect(metrics.scrollTop).toBe(3500);
    expect(jumpButton()).toBeNull();
  });
});

describe("(F7) welcome state", () => {
  it("renders neither a thread viewport nor the button", async () => {
    renderChatPage("/", { "/api/sessions": () => jsonResponse({ sessions: [] }) });
    expect(
      await screen.findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" }),
    ).toBeTruthy();
    expect(document.querySelector(VIEWPORT)).toBeNull();
    expect(screen.queryByRole("region", { name: "消息" })).toBeNull();
    expect(jumpButton()).toBeNull();
  });
});

describe("(F8) button presentation", () => {
  it("renders a decorative chevron-down icon and the name 回到最新 only", async () => {
    await openLongSession();
    userScroll(1000);
    const button = jumpButton();
    if (!button) throw new Error("expected the 回到最新 button");
    const icon = button.querySelector("svg");
    expect(icon?.classList.contains("lucide-chevron-down")).toBe(true);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(button.textContent).toBe("回到最新");
    expect(button.getAttribute("type")).toBe("button");
    // 浮在滚动容器之外：不随转录滚走。
    expect(transcript().contains(button)).toBe(false);
    expect(button.parentElement).toBe(transcript().parentElement);
  });
});

/* Issue 726: a scroll event is a user scroll-up only when `scrollTop` went down. No
   ResizeObserver is installed here, so no resize callback precedes the scroll event. */
describe("(S) scroll events that are not a user scroll-up", () => {
  it("(S1) re-sticks when the container shrinks after the pin write and scrollTop is unchanged", async () => {
    await openLongSession();
    metrics.clientHeight = 444;
    fireEvent.scroll(transcript());
    expect(metrics.scrollTop).toBe(2556);
    expect(jumpButton()).toBeNull();
    await growAndStream(3200, "增量一");
    expect(metrics.scrollTop).toBe(2756);
    expect(jumpButton()).toBeNull();
  });

  it("(S2) a smaller scrollTop unpins, also right after a content update moved the bottom", async () => {
    await openLongSession();
    await growAndStream(3200, "增量一");
    expect(metrics.scrollTop).toBe(2700);
    userScroll(2600);
    expect(jumpButton()).toBeNull();
    await growAndStream(3400, "增量二");
    expect(metrics.scrollTop).toBe(2600);
    await growAndStream(3700, "增量三");
    expect(metrics.scrollTop).toBe(2600);
    expect(jumpButton()).not.toBeNull();
  });

  it("(S2) a smaller scrollTop unpins after 回到最新 moved the bottom", async () => {
    await openLongSession();
    userScroll(0);
    fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
    expect(metrics.scrollTop).toBe(2500);
    userScroll(2400);
    await growAndStream(3200, "增量一");
    expect(metrics.scrollTop).toBe(2400);
  });

  it("(S3) an unpinned transcript stays unpinned until it is within 4px of the bottom", async () => {
    await openLongSession();
    userScroll(2200);
    metrics.clientHeight = 444;
    fireEvent.scroll(transcript());
    expect(metrics.scrollTop).toBe(2200);
    expect(jumpButton()).toBeNull();
    userScroll(2300);
    await growAndStream(3200, "增量一");
    expect(metrics.scrollTop).toBe(2300);
    expect(jumpButton()).not.toBeNull();
    fireEvent.scroll(transcript());
    expect(metrics.scrollTop).toBe(2300);
    expect(jumpButton()).not.toBeNull();
    userScroll(2752);
    expect(jumpButton()).toBeNull();
    await growAndStream(3400, "增量二");
    expect(metrics.scrollTop).toBe(2956);
  });
});

/* Spy ResizeObserver for R1–R8: installed on globalThis before mount and restored afterwards.
   `resizeElement` is a no-op when no instance observes the element, so on a source without an
   observer the R cases fail on their assertions rather than crash. */
class SpyResizeObserver {
  static instances: SpyResizeObserver[] = [];
  readonly observed = new Set<Element>();
  readonly history: Element[] = [];
  disconnects = 0;

  constructor(private readonly callback: ResizeObserverCallback) {
    SpyResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.add(target);
    this.history.push(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.disconnects += 1;
    this.observed.clear();
  }

  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

/** Observers that ever observed the thread viewport: the scroll layer's own and the ones the
    viewport primitive creates for itself (other components may observe other elements). */
function followObservers(): SpyResizeObserver[] {
  return SpyResizeObserver.instances.filter((spy) =>
    spy.history.some((target) => target instanceof HTMLElement && isTranscript(target)),
  );
}

/** Observers currently observing `element`. */
function observing(element: Element): SpyResizeObserver[] {
  return SpyResizeObserver.instances.filter((spy) => spy.observed.has(element));
}

function resizeElement(element: Element) {
  act(() => {
    for (const spy of SpyResizeObserver.instances) {
      if (spy.observed.has(element)) spy.fire();
    }
  });
}

function thread(): HTMLElement {
  const element = transcript().firstElementChild;
  if (
    !(element instanceof HTMLElement) ||
    element !== screen.getByRole("region", { name: "消息" })
  ) {
    throw new Error("expected the 消息 region as the viewport's content root");
  }
  return element;
}

function distance(): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

describe("(R) size changes without a content change", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");

  beforeEach(() => {
    SpyResizeObserver.instances = [];
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: SpyResizeObserver,
    });
  });

  afterEach(() => {
    cleanupChatPage();
    if (original) Object.defineProperty(globalThis, "ResizeObserver", original);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  it("(R1) re-sticks a pinned transcript when its container shrinks", async () => {
    await openLongSession();
    metrics.clientHeight = 452;
    expect(distance()).toBe(48);
    resizeElement(transcript());
    expect(metrics.scrollTop).toBe(2548);
    expect(distance()).toBeLessThanOrEqual(4);
    expect(jumpButton()).toBeNull();
  });

  it("(R2) keeps a scrolled-up position and shows 回到最新 once growth exceeds a viewport", async () => {
    await openLongSession();
    userScroll(2200);
    expect(jumpButton()).toBeNull();
    metrics.scrollHeight = 3300;
    resizeElement(thread());
    expect(metrics.scrollTop).toBe(2200);
    expect(jumpButton()).not.toBeNull();
  });

  it("(R3) keeps following when the content root grows while pinned", async () => {
    await openLongSession();
    metrics.scrollHeight = 3600;
    resizeElement(thread());
    expect(metrics.scrollTop).toBe(3100);
    expect(distance()).toBeLessThanOrEqual(4);
    expect(jumpButton()).toBeNull();
  });

  /* The viewport primitive observes the scroll container for itself (and may replace its
     observers between renders), so more than one observer holds it; the content root is bound by
     the scroll layer's observer alone, and that one is never replaced within a session. */
  it("(R4) binds the content root once it renders and disconnects on unmount", async () => {
    metrics.scrollHeight = 500;
    const history = deferredResponse();
    const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [runningSnapshot().session] }),
      [SESSION_MESSAGES]: () => history.promise,
    });
    await waitFor(() => expect(calls(fetchMock, SESSION_MESSAGES)).toHaveLength(1));
    const mounted = observing(transcript());
    expect(mounted.length).toBeGreaterThanOrEqual(1);
    expect(transcript().firstElementChild).toBeNull();
    for (const each of mounted) expect([...each.observed]).toEqual([transcript()]);
    await act(async () => {
      metrics.scrollHeight = 3000;
      history.resolve(jsonResponse(runningSnapshot()));
    });
    await waitFor(() => expect(assistantText()).toContain("起始"));
    const [spy, ...others] = observing(thread());
    expect(others).toEqual([]);
    expect(mounted).toContain(spy);
    expect([...(spy?.observed ?? [])]).toEqual([transcript(), thread()]);
    const observedThread = thread();
    await growAndStream(3200, "增量一");
    expect(thread()).toBe(observedThread);
    expect(spy?.history).toHaveLength(2);
    expect(spy?.disconnects).toBe(0);
    const created = followObservers();
    cleanupChatPage();
    expect(followObservers()).toEqual(created);
    expect(spy?.disconnects).toBe(1);
    for (const each of created) expect(each.observed.size).toBe(0);
  });

  it("(R4) disconnects on a session switch and observes the new session's content root", async () => {
    const other = deferredResponse();
    const mounted = renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () =>
        jsonResponse({ sessions: [runningSnapshot().session, otherIdleSession()] }),
      [SESSION_MESSAGES]: () => jsonResponse(runningSnapshot()),
      [OTHER_MESSAGES]: () => other.promise,
    });
    await waitFor(() => expect(assistantText()).toContain("起始"));
    const first = followObservers();
    const [firstLayer, ...rest] = observing(thread());
    expect(rest).toEqual([]);
    expect(firstLayer?.disconnects).toBe(0);
    await act(async () => {
      await mounted.router.navigate(`/?session=${OTHER_SESSION_ID}`);
    });
    await waitFor(() => expect(calls(mounted.fetchMock, OTHER_MESSAGES)).toHaveLength(1));
    expect(firstLayer?.disconnects).toBe(1);
    for (const each of first) expect(each.observed.size).toBe(0);
    const second = observing(transcript());
    expect(second.length).toBeGreaterThanOrEqual(1);
    for (const each of second) {
      expect(first).not.toContain(each);
      expect([...each.observed]).toEqual([transcript()]);
    }
    await act(async () => {
      metrics.scrollHeight = 4000;
      other.resolve(jsonResponse(otherSnapshot()));
    });
    expect(await screen.findByText("other user", { exact: true })).toBeTruthy();
    const [spy, ...others] = observing(thread());
    expect(others).toEqual([]);
    expect(second).toContain(spy);
    expect([...(spy?.observed ?? [])]).toEqual([transcript(), thread()]);
    expect(spy?.disconnects).toBe(0);
    expect(metrics.scrollTop).toBe(3500);
  });

  it("(R5) degrades to content-only follow without ResizeObserver", async () => {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
    expect(typeof globalThis.ResizeObserver).toBe("undefined");
    await openLongSession();
    await growAndStream(3200, "增量一");
    expect(metrics.scrollTop).toBe(2700);
    expect(jumpButton()).toBeNull();
    expect(followObservers()).toHaveLength(0);
  });

  it("(R6) a resize that brings a scrolled-up transcript to the bottom pins it and hides 回到最新", async () => {
    await openLongSession();
    userScroll(0);
    expect(jumpButton()).not.toBeNull();
    metrics.clientHeight = 3000;
    expect(distance()).toBe(0);
    resizeElement(transcript());
    expect(metrics.scrollTop).toBe(0);
    expect(jumpButton()).toBeNull();
    await growAndStream(3500, "增量一");
    expect(distance()).toBeLessThanOrEqual(4);
    expect(jumpButton()).toBeNull();
  });

  it("(R7) keeps 回到最新 and the position when a resize leaves the distance within a viewport", async () => {
    await openLongSession();
    userScroll(1000);
    expect(jumpButton()).not.toBeNull();
    metrics.clientHeight = 1800;
    expect(distance()).toBe(200);
    resizeElement(transcript());
    expect(metrics.scrollTop).toBe(1000);
    expect(jumpButton()).not.toBeNull();
    await growAndStream(3100, "增量一");
    expect(metrics.scrollTop).toBe(1000);
    expect(jumpButton()).not.toBeNull();
  });

  /* At distance 0 `scrollTop` is already at its clamp, so R6 cannot see a stray write; at the
     4px tolerance edge but still overflowing, a write to the bottom would move it. */
  it("(R8) pins at exactly the 4px tolerance without writing scrollTop", async () => {
    await openLongSession();
    userScroll(0);
    expect(jumpButton()).not.toBeNull();
    metrics.clientHeight = 2996;
    expect(distance()).toBe(4);
    resizeElement(transcript());
    expect(metrics.scrollTop).toBe(0);
    expect(jumpButton()).toBeNull();
    await growAndStream(3500, "增量一");
    expect(distance()).toBeLessThanOrEqual(4);
  });

  /* Sits under (R) on purpose: the viewport primitive mounts only where `ResizeObserver` is
     defined (a plain div otherwise), and this block's spy supplies it; outside it the case would
     pass without the primitive. The primitive scrolls with `scrollTo` one animation frame after
     the runtime reports a run start; jsdom has no `scrollTo` on elements, so that platform method
     is stubbed here and moves the mocked `scrollTop` the way a browser would. The follow-up turn
     makes the last message a running assistant message, which is what the runtime calls a run
     start. */
  it("(N1) a new turn started after the user scrolled up does not pull the transcript to the bottom", async () => {
    const scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions) {
      if (isTranscript(this)) this.scrollTop = options?.top ?? 0;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
      writable: true,
    });
    try {
      const done = chatSnapshot({ status: "done", assistantStatus: "done", content: "起始" });
      const next = {
        ...done,
        session: { ...done.session, status: "running" as const },
        messages: [
          ...done.messages,
          { ...historyUser, id: 1, content: "继续", createdAt: 1 },
          {
            ...historyUser,
            id: 2,
            role: "assistant" as const,
            content: "",
            status: "running" as const,
            createdAt: 2,
          },
        ],
      };
      let accepted = false;
      renderChatPage(`/?session=${SESSION_ID}`, {
        "/api/sessions": () => jsonResponse({ sessions: [done.session] }),
        [SESSION_MESSAGES]: () => jsonResponse(accepted ? next : done),
        [SESSION_PROMPT]: () => {
          accepted = true;
          return jsonResponse({ ...promptAccepted, userMessageId: 1, assistantMessageId: 2 }, 202);
        },
      });
      await waitFor(() => expect(assistantText()).toContain("起始"));
      expect(metrics.scrollTop).toBe(2500);
      userScroll(1000);
      expect(jumpButton()).not.toBeNull();

      typeDraft("继续");
      clickSend();
      await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(4));
      expect(screen.getByText("生成中", { exact: true })).toBeTruthy();
      // 基元把滚动排在下一帧：等过几帧再看。
      await waitMs(100);

      expect(scrollTo).not.toHaveBeenCalled();
      expect(metrics.scrollTop).toBe(1000);
      expect(jumpButton()).not.toBeNull();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
  });
});
