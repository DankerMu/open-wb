import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OTHER_MESSAGES,
  OTHER_SESSION_ID,
  otherIdleSession,
  otherSnapshot,
  SESSION_MESSAGES,
} from "./chat-page-ownership-support.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, latestSource, SESSION_ID } from "./chat-stream-support.js";
import { calls, deferredResponse, jsonResponse } from "./support.js";
import { readRepoFile, ruleBody, stripComments } from "./ui-support.js";

/* jsdom has no layout: scroll metrics of the `.chat-transcript` element are mocked at the
   prototype level so that even the first mount's layout effect is observable. */
const METRIC_NAMES = ["scrollHeight", "clientHeight", "scrollTop"] as const;
const metrics = { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 };
let seq = 3;

function isTranscript(element: HTMLElement): boolean {
  return element.classList.contains("chat-transcript");
}

function installMetrics() {
  const height = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
  const client = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isTranscript(this) ? metrics.scrollHeight : height?.get?.call(this);
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
      const max = Math.max(metrics.scrollHeight - metrics.clientHeight, 0);
      metrics.scrollTop = Math.min(Math.max(value, 0), max);
    },
  });
}

beforeEach(() => {
  Object.assign(metrics, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
  seq = 3;
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
  const element = document.querySelector<HTMLElement>(".chat-transcript");
  if (!element) throw new Error("expected a .chat-transcript element");
  return element;
}

function jumpButton() {
  return screen.queryByRole("button", { name: "回到最新" });
}

function assistantText(): string {
  return document.querySelector(".chat-msg-assistant .chat-md")?.textContent ?? "";
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
  it("keeps the plain transcript slot directly under .chat-main with no frame or button", async () => {
    renderChatPage("/", { "/api/sessions": () => jsonResponse({ sessions: [] }) });
    expect(
      await screen.findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" }),
    ).toBeTruthy();
    expect(transcript().parentElement?.classList.contains("chat-main")).toBe(true);
    userScroll(0);
    expect(document.querySelector(".chat-transcript-frame")).toBeNull();
    expect(jumpButton()).toBeNull();
  });
});

describe("(F8) button presentation", () => {
  it("styles the floating button and its frame with semantic tokens", () => {
    const css = stripComments(readRepoFile("web/src/features/chat/messages.css"));
    const button = ruleBody(css, ".chat-jump-latest");
    expect(button).toContain("position: absolute");
    expect(button).toContain("background: var(--wb-bg-primary)");
    expect(button).toContain("box-shadow: var(--wb-shadow-popover)");
    expect(ruleBody(css, ".chat-transcript-frame")).toContain("position: relative");
  });

  it("renders a decorative chevron-down icon and the name 回到最新 only", async () => {
    await openLongSession();
    userScroll(1000);
    const button = jumpButton();
    if (!button) throw new Error("expected the 回到最新 button");
    const icon = button.querySelector("svg.ui-icon");
    expect(icon?.classList.contains("lucide-chevron-down")).toBe(true);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(button.textContent).toBe("回到最新");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.parentElement?.classList.contains("chat-transcript-frame")).toBe(true);
  });
});

/* Spy ResizeObserver for R1–R5: installed on globalThis before mount and restored afterwards.
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

/** Observers created for a follow transcript (other components may observe other elements). */
function followObservers(): SpyResizeObserver[] {
  return SpyResizeObserver.instances.filter((spy) =>
    spy.history.some((target) => target instanceof HTMLElement && isTranscript(target)),
  );
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
  if (!(element instanceof HTMLElement) || !element.matches("section.chat-thread")) {
    throw new Error("expected section.chat-thread as the transcript's content root");
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

  it("(R4) binds the content root once it renders and disconnects on unmount", async () => {
    metrics.scrollHeight = 500;
    const history = deferredResponse();
    const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [runningSnapshot().session] }),
      [SESSION_MESSAGES]: () => history.promise,
    });
    await waitFor(() => expect(calls(fetchMock, SESSION_MESSAGES)).toHaveLength(1));
    const [spy] = followObservers();
    expect(followObservers()).toHaveLength(1);
    expect(transcript().firstElementChild).toBeNull();
    expect([...(spy?.observed ?? [])]).toEqual([transcript()]);
    await act(async () => {
      metrics.scrollHeight = 3000;
      history.resolve(jsonResponse(runningSnapshot()));
    });
    await waitFor(() => expect(assistantText()).toContain("起始"));
    expect([...(spy?.observed ?? [])]).toEqual([transcript(), thread()]);
    const observedThread = thread();
    await growAndStream(3200, "增量一");
    expect(thread()).toBe(observedThread);
    expect(spy?.history).toHaveLength(2);
    expect(spy?.disconnects).toBe(0);
    cleanupChatPage();
    expect(followObservers()).toHaveLength(1);
    expect(spy?.disconnects).toBe(1);
    expect(spy?.observed.size).toBe(0);
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
    const [first] = followObservers();
    expect(followObservers()).toHaveLength(1);
    await act(async () => {
      await mounted.router.navigate(`/?session=${OTHER_SESSION_ID}`);
    });
    await waitFor(() => expect(calls(mounted.fetchMock, OTHER_MESSAGES)).toHaveLength(1));
    expect(first?.disconnects).toBe(1);
    expect(first?.observed.size).toBe(0);
    const [, second] = followObservers();
    expect(followObservers()).toHaveLength(2);
    expect([...(second?.observed ?? [])]).toEqual([transcript()]);
    await act(async () => {
      metrics.scrollHeight = 4000;
      other.resolve(jsonResponse(otherSnapshot()));
    });
    expect(await screen.findByText("other user", { exact: true })).toBeTruthy();
    expect([...(second?.observed ?? [])]).toEqual([transcript(), thread()]);
    expect(second?.disconnects).toBe(0);
    expect(metrics.scrollTop).toBe(3500);
  });

  it("(R5) degrades to content-only follow without ResizeObserver", async () => {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
    expect(typeof globalThis.ResizeObserver).toBe("undefined");
    await openLongSession();
    await growAndStream(3200, "增量一");
    expect(metrics.scrollTop).toBe(2700);
    expect(jumpButton()).toBeNull();
    expect(SpyResizeObserver.instances).toHaveLength(0);
  });
});
