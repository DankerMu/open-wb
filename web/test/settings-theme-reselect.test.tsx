import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./radix-platform.js";
import {
  createAuthenticatedFetch,
  expectAuthenticatedShell,
  renderApp,
  resetSettingsTestState,
} from "./settings-support.js";

/*
 * spa-shell「设置页」场景「再点已选项不改变主题」：主题控件是单选组，再点已选项不得清空选择、
 * 不得改写主题。toggle 语义（再点即取消）的实现会在这里变红。
 */

afterEach(() => {
  resetSettingsTestState();
});

const THEME_KEY = "workbuddy-theme";

async function renderSettingsWith(stored: string) {
  window.localStorage.setItem(THEME_KEY, stored);
  vi.stubGlobal("fetch", createAuthenticatedFetch());
  renderApp("/settings");
  await expectAuthenticatedShell("/settings");
  return screen.getByRole("radiogroup", { name: "主题" });
}

function checkedStates(group: HTMLElement) {
  return within(group)
    .getAllByRole("radio")
    .map((radio) => radio.getAttribute("aria-checked"));
}

describe("再点已选项不改变主题", () => {
  it("当前为深色时再点深色：仍选中深色，data-theme 与 storage 仍为 dark", async () => {
    const group = await renderSettingsWith("dark");
    const dark = within(group).getByRole("radio", { name: "深色" });
    expect(checkedStates(group)).toEqual(["false", "true", "false"]);

    // 每点一次都核对一遍：toggle 语义下第一次点会清掉选择，第二次点又选回来，只看终态会漏掉。
    for (const attempt of [1, 2]) {
      fireEvent.click(dark);

      expect(checkedStates(group), `第 ${attempt} 次再点`).toEqual(["false", "true", "false"]);
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
      expect(screen.getByText("当前生效：深色", { exact: true })).toBeTruthy();
    }
  });

  it("先选浅色再点一次浅色：不回到跟随系统，三项里始终恰有一项选中", async () => {
    const group = await renderSettingsWith("system");
    const light = within(group).getByRole("radio", { name: "浅色" });
    expect(checkedStates(group)).toEqual(["false", "false", "true"]);

    fireEvent.click(light);
    expect(checkedStates(group)).toEqual(["true", "false", "false"]);
    fireEvent.click(light);

    expect(checkedStates(group)).toEqual(["true", "false", "false"]);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("方向键移动即选中：在深色上按右方向键选中跟随系统并写入 storage", async () => {
    const group = await renderSettingsWith("dark");
    const dark = within(group).getByRole("radio", { name: "深色" });
    const system = within(group).getByRole("radio", { name: "跟随系统" });

    act(() => dark.focus());
    fireEvent.keyDown(dark, { key: "ArrowRight" });
    // Radix 的 roving focus 在下一拍把焦点移到下一项，该项聚焦时即选中。
    await waitFor(() => expect(document.activeElement).toBe(system));

    expect(checkedStates(group)).toEqual(["false", "false", "true"]);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("system");
  });
});
