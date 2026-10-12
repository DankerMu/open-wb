/**
 * Issue #1363（tasks 23.8–23.9）：workspace-sidebar「布局与开合」的场景「放不下时折叠外壳侧栏」与「只在
 * 打开的那一下判断」里 jsdom 证得了的部分。接缝：真实外壳里的整页；外壳主区的宽度由桩给出（jsdom 没有
 * 布局，`clientWidth` 恒为 0），`localStorage` 的 `workbuddy-sidebar` 既读值也数写入。期望值是规格里的
 * 字面量；主区宽度取自规格的视口减去外壳侧栏的宽度（展开 288、折叠 48）：800 → 512，1200 → 912；边界
 * 是两个最小宽度加分隔线，320 + 240 + 1 = 561。
 *
 * jsdom 证不了的：折叠的过渡结束后两栏各自的宽度、分隔线能否移动、开着侧边栏缩窄窗口，只在
 * `make ui-walk` 里证明。
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSessionMeta, installNarrowViewport } from "./chat-page-session-meta-support.js";
import {
  BOUND,
  CLOSE,
  mountSidebarPage,
  NAME,
  OTHER,
  openSidebar,
  SAME_SPACE,
  selectSession,
  sidebarButton,
  sidebarRegion,
  UNBOUND,
} from "./chat-workspace-sidebar-support.js";

const SHELL_KEY = "workbuddy-sidebar";

afterEach(cleanupSessionMeta);

/** 外壳侧栏（spa-shell 的 `aside[aria-label="侧栏"]`）的 `data-collapsed`。 */
function shellCollapsed() {
  return screen.getByRole("complementary", { name: "侧栏" }).getAttribute("data-collapsed");
}

/** 给外壳主区一个量得到的宽度。 */
function setMainWidth(value: number) {
  Object.defineProperty(screen.getByRole("main"), "clientWidth", { configurable: true, value });
}

/** 从此刻起对 `workbuddy-sidebar` 的写入，按顺序。 */
function shellWrites() {
  const spy = vi.spyOn(Storage.prototype, "setItem");
  return () => spy.mock.calls.filter(([key]) => key === SHELL_KEY).map(([, value]) => value);
}

/** 焦点先放到顶栏按钮上（真实点击会这样），再点它打开侧边栏。 */
async function open() {
  sidebarButton().focus();
  return openSidebar("readme.md");
}

function closeSidebar() {
  const region = sidebarRegion();
  if (!region) throw new Error("侧边栏没有打开");
  fireEvent.click(within(region).getByRole("button", { name: CLOSE }));
  expect(sidebarRegion()).toBeNull();
}

function expandShell() {
  fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
}

/** 主区 512、外壳侧栏展开的会话页，已记下写入探针。 */
async function mountTight() {
  await mountSidebarPage(BOUND);
  const writes = shellWrites();
  setMainWidth(512);
  expect(shellCollapsed()).toBe("false");
  return writes;
}

describe("放不下时折叠外壳侧栏", () => {
  it("F1 主区放不下、外壳侧栏展开：打开动作把外壳侧栏折叠并写入折叠偏好，焦点仍在顶栏按钮；关闭侧边栏后外壳侧栏仍是折叠的", async () => {
    const writes = await mountTight();

    const { trigger } = await open();

    expect(shellCollapsed()).toBe("true");
    expect(window.localStorage.getItem(SHELL_KEY)).toBe("collapsed");
    expect(writes()).toStrictEqual(["collapsed"]);
    expect(sidebarRegion()).not.toBeNull();
    expect(sidebarButton()).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    closeSidebar();

    expect(shellCollapsed()).toBe("true");
    expect(window.localStorage.getItem(SHELL_KEY)).toBe("collapsed");
    expect(writes()).toStrictEqual(["collapsed"]);
  });

  it("F2 主区放得下：打开动作不折叠外壳侧栏，也不写折叠偏好", async () => {
    await mountSidebarPage(BOUND);
    const writes = shellWrites();
    setMainWidth(912);

    await open();

    expect(shellCollapsed()).toBe("false");
    expect(writes()).toStrictEqual([]);
    expect(window.localStorage.getItem(SHELL_KEY)).toBeNull();
  });

  it("F3 外壳侧栏已经折叠：主区放不下时打开动作不做任何事，仍是折叠、不写折叠偏好", async () => {
    window.localStorage.setItem(SHELL_KEY, "collapsed");
    await mountSidebarPage(BOUND);
    const writes = shellWrites();
    setMainWidth(512);
    expect(shellCollapsed()).toBe("true");

    await open();

    expect(shellCollapsed()).toBe("true");
    expect(writes()).toStrictEqual([]);
    expect(window.localStorage.getItem(SHELL_KEY)).toBe("collapsed");
  });

  it.each([
    [560, "true", ["collapsed"]],
    [561, "false", []],
  ])(
    "F4 边界是两个最小宽度加分隔线：主区 %i 时打开后外壳侧栏 data-collapsed=%s",
    async (width, collapsed, written) => {
      await mountSidebarPage(BOUND);
      const writes = shellWrites();
      setMainWidth(width);

      await open();

      expect(shellCollapsed()).toBe(collapsed);
      expect(writes()).toStrictEqual(written);
    },
  );

  it("F8 主区宽度量不到（为 0）：打开动作不折叠外壳侧栏，也不写折叠偏好", async () => {
    await mountSidebarPage(BOUND);
    const writes = shellWrites();
    expect(screen.getByRole("main").clientWidth).toBe(0);

    await open();

    expect(shellCollapsed()).toBe("false");
    expect(writes()).toStrictEqual([]);
  });
});

describe("只在打开的那一下判断", () => {
  it("F5 窄屏：打开的是模态层，不读写外壳侧栏的折叠偏好", async () => {
    installNarrowViewport();
    await mountSidebarPage(BOUND);
    const writes = shellWrites();
    setMainWidth(390);

    fireEvent.click(sidebarButton());
    const layer = await screen.findByRole("dialog", { name: NAME });
    await within(layer).findByRole("button", { name: "readme.md" });

    expect(writes()).toStrictEqual([]);
    expect(window.localStorage.getItem(SHELL_KEY)).toBeNull();
  });

  it("F6 折叠之后用户自己点 展开侧栏：侧边栏开着切到同空间与另一个空间的会话，外壳侧栏一直是展开的", async () => {
    const writes = await mountTight();
    await open();
    expect(shellCollapsed()).toBe("true");

    expandShell();
    expect(shellCollapsed()).toBe("false");

    await selectSession(SAME_SPACE);
    expect(sidebarRegion()).not.toBeNull();
    expect(shellCollapsed()).toBe("false");

    await selectSession(OTHER);
    await within(sidebarRegion() as HTMLElement).findByRole("button", { name: "w2.txt" });
    expect(shellCollapsed()).toBe("false");
    expect(writes()).toStrictEqual(["collapsed", "expanded"]);
  });

  it("F7 打开的意图在回到绑定会话时恢复不折叠外壳侧栏；关闭后再点一次顶栏按钮重新判断，又把它折叠", async () => {
    const writes = await mountTight();
    await open();
    expandShell();
    expect(shellCollapsed()).toBe("false");

    await selectSession(UNBOUND);
    expect(sidebarRegion()).toBeNull();
    await selectSession(BOUND);
    const restored = await screen.findByRole("complementary", { name: NAME });
    await within(restored).findByRole("button", { name: "readme.md" });
    expect(shellCollapsed()).toBe("false");
    expect(writes()).toStrictEqual(["collapsed", "expanded"]);

    closeSidebar();
    expect(shellCollapsed()).toBe("false");
    await open();

    expect(shellCollapsed()).toBe("true");
    expect(writes()).toStrictEqual(["collapsed", "expanded", "collapsed"]);
    expect(window.localStorage.getItem(SHELL_KEY)).toBe("collapsed");
  });
});
