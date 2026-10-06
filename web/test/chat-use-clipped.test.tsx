/**
 * `useClipped` (openspec/changes/s1f-chat-followups, design D3): whether a scroll container's content
 * is taller than its visible height. jsdom does no layout, so `scrollHeight` and `clientHeight` are
 * stubbed; the numbers are only compared, never asserted as pixels.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClipped } from "../src/features/chat/use-clipped.js";

/** The stubbed heights of the probed element; every other element reads 0. */
const heights = { content: 0, visible: 0 };
let measured = 0;

function Probe({ shown = true, trigger }: { shown?: boolean; trigger: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const clipped = useClipped(ref, [trigger, shown]);
  return (
    <>
      <output>{String(clipped)}</output>
      {shown ? <div data-testid="scroller" ref={ref} /> : null}
    </>
  );
}

const clipped = () => screen.getByRole("status").textContent;
const scroller = () => screen.getByTestId("scroller");

/** A `ResizeObserver` the test drives: what it observes and whether it was disconnected. */
class ControlledObserver {
  static created: ControlledObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(readonly notify: () => void) {
    ControlledObserver.created.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

const realObserver = globalThis.ResizeObserver;

function installObserver(value: unknown) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = value;
}

beforeEach(() => {
  heights.content = 0;
  heights.visible = 0;
  measured = 0;
  ControlledObserver.created = [];
  installObserver(ControlledObserver);
  const isScroller = (el: Element) => el.getAttribute("data-testid") === "scroller";
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return isScroller(this) ? heights.visible : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    if (!isScroller(this)) return 0;
    measured += 1;
    return heights.content;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  installObserver(realObserver);
});

describe("useClipped", () => {
  it("measures once on mount: taller content is clipped, content that fits is not", () => {
    heights.content = 50;
    heights.visible = 6;
    render(<Probe trigger="a" />);
    expect(clipped()).toBe("true");
    expect(measured).toBe(1);

    cleanup();
    measured = 0;
    heights.content = 6;
    render(<Probe trigger="a" />);
    expect(clipped()).toBe("false");
    expect(measured).toBe(1);
  });

  it("measures again when a trigger changes, and not when none does", () => {
    heights.content = 2;
    heights.visible = 6;
    const { rerender } = render(<Probe trigger="a" />);
    expect(clipped()).toBe("false");

    heights.content = 50;
    rerender(<Probe trigger="a" />);
    expect(clipped()).toBe("false");
    expect(measured).toBe(1);

    rerender(<Probe trigger="b" />);
    expect(clipped()).toBe("true");
    expect(measured).toBe(2);
  });

  it("measures again when the ResizeObserver reports, and disconnects it on unmount", () => {
    heights.content = 2;
    heights.visible = 6;
    const { unmount } = render(<Probe trigger="a" />);
    const [observer] = ControlledObserver.created as [ControlledObserver];
    expect(ControlledObserver.created).toHaveLength(1);
    expect(observer.observed).toEqual([scroller()]);
    expect(clipped()).toBe("false");

    heights.content = 50;
    act(() => observer.notify());
    expect(clipped()).toBe("true");
    heights.visible = 60;
    act(() => observer.notify());
    expect(clipped()).toBe("false");

    expect(observer.disconnected).toBe(false);
    unmount();
    expect(observer.disconnected).toBe(true);
  });

  it("measures and observes an element that only appears with a later trigger", () => {
    heights.content = 50;
    heights.visible = 6;
    const { rerender } = render(<Probe shown={false} trigger="a" />);
    expect(clipped()).toBe("false");
    expect(measured).toBe(0);
    expect(ControlledObserver.created).toHaveLength(0);

    rerender(<Probe shown trigger="a" />);
    expect(clipped()).toBe("true");
    expect(ControlledObserver.created).toHaveLength(1);
    expect(ControlledObserver.created[0]?.observed).toEqual([scroller()]);
  });

  it("measures on mount and on a trigger change without throwing when there is no ResizeObserver", () => {
    installObserver(undefined);
    expect(typeof ResizeObserver).toBe("undefined");
    heights.content = 50;
    heights.visible = 6;
    const { rerender, unmount } = render(<Probe trigger="a" />);
    expect(clipped()).toBe("true");

    heights.content = 2;
    rerender(<Probe trigger="b" />);
    expect(clipped()).toBe("false");
    expect(() => unmount()).not.toThrow();
  });
});
