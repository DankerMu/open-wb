/**
 * ui-primitives「焦点归还不滚动」as rewritten by s1f-chat-surface (issue 859): its subject is the
 * session rename dialog, which stays on the old `Dialog` now that the html artifact preview moved
 * to the copied-layer dialog. Seam: the jsdom chat page; jsdom lays nothing out, so "does not
 * scroll" is observed as the argument of the hand-back `focus` call.
 */
import "./radix-platform.js";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  A,
  cleanupSessionMeta,
  crumb,
  findList,
  focusOn,
  mountSessions,
  openTopbarRename,
  patchPath,
  type RenameControls,
  renameDialog,
  view,
} from "./chat-page-session-meta-support.js";
import {
  escapeOnFocusEntry,
  keepTooltipExitAnimation,
  tooltipStates,
} from "./escape-race-support.js";
import { calls } from "./support.js";

const TITLE = "季度复盘";

afterEach(cleanupSessionMeta);

describe("会话重命名对话框：焦点归还不滚动", () => {
  const closings: Array<[string, (controls: RenameControls) => void]> = [
    ["Escape", ({ input }) => fireEvent.keyDown(input, { key: "Escape" })],
    ["取消", ({ cancel }) => fireEvent.click(cancel)],
  ];

  it.each(closings)(
    "closing the rename dialog with %s focuses the banner's 重命名 button with preventScroll",
    async (_name, close) => {
      mountSessions(`/?session=${A}`, [view(A, TITLE)]);
      await findList(TITLE);
      await crumb(TITLE);
      const controls = await openTopbarRename();
      await focusOn(controls.input);
      const focus = vi.spyOn(controls.trigger, "focus");

      close(controls);

      await waitFor(() => expect(renameDialog()).toBeNull());
      await focusOn(controls.trigger);
      expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
    },
  );

  // The standing evidence for keeping `useEscapeFallback` (ADR-0013 addendum 「Escape 实测」): with the
  // name dialog's fallback unwired the case goes red — the key is dispatched to the tooltip's layer only.
  it("opened from the banner's 重命名 while its tooltip is still closing: an Escape landing the moment focus enters the dialog still closes it, sends nothing and hands the focus back", async () => {
    keepTooltipExitAnimation();
    const { fetchMock } = mountSessions(`/?session=${A}`, [view(A, TITLE)]);
    await findList(TITLE);
    await crumb(TITLE);
    const trigger = within(screen.getByRole("banner")).getByRole("button", { name: "重命名" });
    trigger.focus();
    await waitFor(() => expect(tooltipStates()).toEqual(["instant-open"]));

    const seen = escapeOnFocusEntry(() => fireEvent.click(trigger));

    // Radix consumed the key on the closing tooltip's layer; the dialog's own layer never saw it.
    expect(seen).toEqual({ fired: 1, prevented: true, tooltips: ["closed"] });
    await waitFor(() => expect(renameDialog()).toBeNull());
    await focusOn(trigger);
    expect(calls(fetchMock, patchPath(A))).toEqual([]);
  });
});
