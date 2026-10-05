/**
 * Issue 861 项目配置入口 on the copied-layer dialog (openspec/changes/s1f-chat-surface, chat-web
 * 「会话页」Project config entry): H1–H3. The behaviour cases G1–G9 stay in
 * chat-page-project-config.test.tsx; here is what the move itself has to hold: the dialog is the
 * copied one, focus opens on its 关闭 and goes back to the header button, and Escape still closes
 * it under a toast. Seam: the jsdom chat page inside the real shell over a stubbed `fetch`.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quiesce } from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import {
  cleanupSessionMeta,
  crumb,
  focusOn,
  messagesPath,
  patchPath,
  RENAMED_TOAST,
  toasts,
  view,
} from "./chat-page-session-meta-support.js";
import { renderChatPage } from "./chat-page-support.js";
import { PROJECT_A, welcomeRoutes } from "./chat-page-welcome-scene-support.js";
import { deferredResponse, jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const TITLE = "助手会读取的项目配置文件";
const NOTE = "以下位置存在配置文件；同一层有多个说明文件时只有一个生效";
const SESSION = { ...view("a".repeat(32), "绑定会话"), workspaceId: PROJECT_A.id };
const FILES = [
  { path: ".omp/SYSTEM.md", kind: "system", depth: 0 },
  { path: "AGENTS.md", kind: "instructions", depth: 0 },
  { path: ".omp/agents/reviewer.md", kind: "agent", depth: 1 },
];

function banner() {
  return within(screen.getByRole("banner", { hidden: true }));
}

function configButton() {
  return banner().getByRole<HTMLButtonElement>("button", { name: "项目配置 3", hidden: true });
}

function slotTexts(scope: Element, slot: string) {
  return Array.from(scope.querySelectorAll(`[data-slot="${slot}"]`), (node) => node.textContent);
}

/** The session page on SESSION with its three files listed; `rename` answers the PATCH. */
async function mount(rename: () => Promise<Response> | Response = () => jsonResponse(SESSION)) {
  renderChatPage(`/?session=${SESSION.id}`, {
    ...welcomeRoutes(),
    "/api/sessions": () => jsonResponse({ sessions: [SESSION] }),
    [messagesPath(SESSION.id)]: () =>
      jsonResponse({ session: SESSION, messages: [], streamCursor: { epoch: 1, seq: 0 } }),
    [`/api/project-config?workspaceId=${PROJECT_A.id}`]: () => jsonResponse({ files: FILES }),
    [patchPath(SESSION.id)]: rename,
  });
  await quiesce();
  await crumb("绑定会话");
}

async function openDialog() {
  const button = configButton();
  button.focus();
  fireEvent.click(button);
  return { button, dialog: await screen.findByRole("dialog", { name: TITLE }) };
}

afterEach(cleanupSessionMeta);

describe("项目配置入口：拷入层对话框 (H1–H3)", () => {
  it("H1 the list is the copied dialog: modal, titled and described by its own slots, each row a text path and a kind badge, nothing of the old layer", async () => {
    await mount();

    const { dialog } = await openDialog();

    expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(slotTexts(dialog, "dialog-title")).toEqual([TITLE]);
    expect(slotTexts(dialog, "dialog-description")).toEqual([NOTE]);
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).toBeNull();
    expect(slotTexts(dialog, "project-config-path")).toEqual(FILES.map((file) => file.path));
    expect(slotTexts(dialog, "project-config-kind")).toEqual(["系统提示", "说明", "智能体"]);
    // A long path wraps inside its row; a long list scrolls inside the dialog.
    const path = dialog.querySelector('[data-slot="project-config-path"]');
    expect(path?.classList.contains("wrap-anywhere")).toBe(true);
    expect(path?.classList.contains("min-w-0")).toBe(true);
    const scroller = path?.closest("section")?.parentElement;
    expect(scroller?.classList.contains("overflow-y-auto")).toBe(true);
    expect(scroller?.classList.contains("max-h-[60vh]")).toBe(true);
    expect(
      document.querySelectorAll('.ui-dialog, .ui-tag, [class*="chat-project-config"]'),
    ).toHaveLength(0);
  });

  it("H2 focus opens on 关闭; pressing it closes the list and hands the focus back to the header button without scrolling", async () => {
    await mount();
    const { button, dialog } = await openDialog();
    const close = within(dialog).getByRole("button", { name: "关闭" });
    expect(close.getAttribute("data-slot")).toBe("dialog-close");
    await focusOn(close);
    const onButton = vi.spyOn(button, "focus");

    fireEvent.click(close);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusOn(button);
    expect(onButton.mock.calls).toEqual([[{ preventScroll: true }]]);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  // The toast is the session list's 已重命名. It arrives while the list is open, so it sits above
  // the dialog in the Radix layer stack and takes its Escape.
  it("H3 Escape closes the list while a toast is shown, and the focus is back on the header button", async () => {
    const renamed = deferredResponse();
    await mount(() => renamed.promise);
    fireEvent.click(banner().getByRole("button", { name: "重命名" }));
    const rename = await screen.findByRole("dialog", { name: "重命名任务" });
    fireEvent.change(within(rename).getByRole("textbox", { name: "任务名称" }), {
      target: { value: "新标题" },
    });
    fireEvent.click(within(rename).getByRole("button", { name: "保存" }));
    fireEvent.click(within(rename).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await yieldMacrotask();
    const { button, dialog } = await openDialog();
    await focusOn(within(dialog).getByRole("button", { name: "关闭" }));

    await settleDeferredResponse(renamed, jsonResponse({ ...SESSION, title: "新标题" }));
    await waitFor(() => expect(toasts()).toEqual([RENAMED_TOAST]));

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusOn(button);
  });
});
