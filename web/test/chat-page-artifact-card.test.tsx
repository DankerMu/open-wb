/**
 * Issue #536 产物卡 (parent tasks 7.5b): A1–A15 of openspec/changes/artifact-card/design.md.
 * Seams: the pure `artifactKind`, the jsdom chat page over a stubbed `fetch`, the two Blob URL
 * statics and `navigator.clipboard`. Expected values are
 * literals from the spec deltas; cases marked (guard) already hold before the change. H1 is from
 * review round 1; H2–H6 live in chat-page-artifact-card-state.test.tsx.
 *
 * Issue #1110 (s1f-files-page 25.2): the html card's 打开网页预览 opens the workspace sidebar instead
 * of a dialog and the image card's 下载 is a link to the download endpoint; neither asks the preview
 * API any more (A2, A3, A5). The sidebar's side of 打开网页预览 is in
 * chat-workspace-sidebar-reveal-html.test.tsx. Only the code card still fetches: A10 and A12 moved
 * to it.
 */

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { artifactKind } from "../src/features/chat/stream-artifacts.js";
import {
  APP,
  action,
  actions,
  alerts,
  artifactCardFixture,
  artifactCards,
  BLOB_URL,
  CHART,
  CODE_TEXT,
  COPY_APP,
  cardTitles,
  changedTurn,
  copiedStatus,
  DOWNLOAD_CHART,
  INDEX,
  link,
  OPEN_INDEX,
  openPreviewing,
  previewCalls,
  previewRoute,
  previewSignal,
  REQUEST_FAILED,
  rejectOnAbort,
  siteRoutes,
  slot,
  stubClipboard,
  switchSession,
  truncatedPreview,
  withOtherSession,
  withoutUnhandledRejections,
} from "./chat-page-artifact-card-support.js";
import {
  assistantMessage,
  type Change,
  cardNamed,
  cards,
  edit,
  goLive,
  listed,
  listedGroup,
  type Message,
  openSession,
  PROJ,
  quiesce,
  ROOT_PREFIX,
  reply,
  replyParts,
  rowTexts,
  stepBadge,
  tagAndClass,
  toolStep,
  turn,
  UNLISTED_ID,
  WORKSPACES,
  withNeighbour,
  write,
} from "./chat-page-file-changes-support.js";
import {
  renderChatPageWithAuthProbe,
  renewAccount,
  settleDeferredResponse,
} from "./chat-page-lifecycle-support.js";
import { envelope, SESSION_MESSAGES } from "./chat-page-ownership-support.js";
import { deferred, historyUser, SESSION_ID } from "./chat-stream-support.js";
import { hasLucideGlyph, imagePreviewResponse } from "./files-fixture.js";
import { BASE } from "./files-site-fixture.js";
import { pageNotices } from "./page-notices.js";
import { deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";

const blobs = artifactCardFixture();

describe("artifactKind", () => {
  const code = (label: string, name: string) => ({ kind: "code" as const, label, name });
  const derived: Array<[string, ReturnType<typeof artifactKind>]> = [
    [INDEX, { kind: "html", label: "HTML", name: "index.html" }],
    [CHART, { kind: "image", label: "PNG", name: "chart.PNG" }],
    ["a.jpg", { kind: "image", label: "JPG", name: "a.jpg" }],
    ["b.JPEG", { kind: "image", label: "JPG", name: "b.JPEG" }],
    ["docs/readme.md", code("MD", "readme.md")],
    ["notes.txt", code("TXT", "notes.txt")],
    ["var/run.log", code("LOG", "run.log")],
    ["data/rows.csv", code("CSV", "rows.csv")],
    ["package.json", code("JSON", "package.json")],
    ["dist/main.js", code("JS", "main.js")],
    [APP, code("TS", "app.ts")],
    ["ui/card.tsx", code("TSX", "card.tsx")],
  ];

  it.each(derived)("A1 %s derives its kind, label and file name", (path, expected) => {
    expect(artifactKind(path)).toStrictEqual(expected);
  });

  const underived = ["main.py", "Makefile", "a.tar.gz", "trailing.", "dir.html/readme"];

  it.each(underived)("A1 %s derives no artifact", (path) => {
    expect(artifactKind(path)).toBeNull();
  });

  // Beyond the design's list: a bare name equal to a table key, and Object.prototype member names.
  it.each(["out/html", "json", "x.constructor", "y.toString", "z.__proto__"])(
    "A1 %s derives no artifact either",
    (path) => {
      expect(artifactKind(path)).toBeNull();
    },
  );

  // Review round 1: the extension follows the LAST dot of the LAST segment, and a dot that only
  // leads the name is no extension (Node `extname` gives "" there, so the preview API refuses it).
  const lastDot: Array<[string, ReturnType<typeof artifactKind>]> = [
    ["vite.config.ts", code("TS", "vite.config.ts")],
    ["dist/app.min.js", code("JS", "app.min.js")],
    ["web/src/ui/card.tsx", code("TSX", "card.tsx")],
    ["cfg/.config.json", code("JSON", ".config.json")],
  ];

  it.each(lastDot)("H1 %s derives its kind, label and file name", (path, expected) => {
    expect(artifactKind(path)).toStrictEqual(expected);
  });

  it.each([".html", "dir/.json", ".env", "dir/", ""])("H1 %j derives no artifact", (path) => {
    expect(artifactKind(path)).toBeNull();
  });
});

describe("产物卡 derivation on the chat page", () => {
  it("A2 derives one card per previewable change in summary order and fetches nothing", async () => {
    const steps = [
      toolStep(11, 0, "edit", [edit(APP, 2, 1), write("main.py")]),
      toolStep(12, 1, "write", [write(INDEX), write(CHART)]),
    ];
    const page = await openSession(turn("done", { content: "改好了", steps }));

    expect(rowTexts(cardNamed("文件变更（4 个）"))).toEqual([
      "+2-1zhangsan/proj/src/app.ts",
      "写入zhangsan/proj/main.py",
      "写入zhangsan/proj/out/index.html",
      "写入zhangsan/proj/assets/chart.PNG",
    ]);
    const derived = artifactCards();
    expect(replyParts().map(tagAndClass)).toEqual([
      "message-body",
      "tool-group-root",
      "file-changes-card",
      "artifact-card",
      "artifact-card",
      "artifact-card",
      "message-actions",
    ]);
    expect(replyParts().slice(3, 6)).toEqual(derived);
    expect(
      ["app.ts", "index.html", "chart.PNG"].map((name) =>
        within(reply()).getByRole("group", { name }),
      ),
    ).toEqual(derived);
    expect(cardTitles()).toEqual(["app.ts", "index.html", "chart.PNG"]);
    expect(derived.map((card) => slot(card, "label")?.textContent)).toEqual(["TS", "HTML", "PNG"]);
    expect(derived.map((card) => slot(card, "icon")?.dataset.kind)).toEqual([
      "code",
      "html",
      "image",
    ]);
    const glyphs = ["file-code", "globe", "image"];
    expect(
      derived.map((card, at) => hasLucideGlyph(slot(card, "icon") ?? card, glyphs[at] ?? "")),
    ).toEqual([true, true, true]);
    // 下载 is a link, the other three are buttons: every control of the three cards, in order.
    expect(
      derived
        .flatMap((card) => [...card.querySelectorAll("button, a")])
        .map((control) => [
          control.tagName,
          control.getAttribute("aria-label"),
          control.closest('[data-slot="artifact-card"]'),
        ]),
    ).toEqual([
      ["BUTTON", COPY_APP, derived[0]],
      ["BUTTON", OPEN_INDEX, derived[1]],
      ["BUTTON", OPEN_INDEX, derived[1]],
      ["A", DOWNLOAD_CHART, derived[2]],
    ]);
    expect(action(COPY_APP).getAttribute("title")).toBe(COPY_APP);
    expect(hasLucideGlyph(action(COPY_APP), "copy")).toBe(true);
    expect(link(DOWNLOAD_CHART).getAttribute("title")).toBe(DOWNLOAD_CHART);
    expect(hasLucideGlyph(link(DOWNLOAD_CHART), "download")).toBe(true);
    expect(derived.map((card) => slot(card, "foot") !== null)).toEqual([false, true, false]);

    expect(previewCalls(page.fetchMock)).toEqual([]);
    expect(blobs.createObjectURL).not.toHaveBeenCalled();
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);
    expect(document.documentElement.innerHTML).not.toContain("在编辑器中打开");
    expect(document.querySelectorAll("iframe, img")).toHaveLength(0);
    expect(derived.map((card) => /file-change/.test(card.innerHTML))).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("html 产物卡", () => {
  it("A3 打开网页预览 opens no dialog and asks the preview API nothing: the page shows in the workspace sidebar", async () => {
    const page = await openSession(changedTurn([write(INDEX)]), listed, siteRoutes());

    const [head, foot] = actions(OPEN_INDEX);
    expect(actions(OPEN_INDEX)).toHaveLength(2);
    expect(head?.closest('[data-slot="artifact-head"]')).not.toBeNull();
    expect(head?.getAttribute("title")).toBe(OPEN_INDEX);
    expect(foot?.closest('[data-slot="artifact-foot"]')?.textContent).toContain("可交互预览");
    expect(foot?.textContent).toBe("打开网页预览");
    expect(previewCalls(page.fetchMock)).toEqual([]);

    fireEvent.click(head as HTMLButtonElement);
    const sidebar = await screen.findByRole("complementary", { name: "工作空间侧边栏" });
    const row = await within(sidebar).findByRole("button", { name: "index.html" });
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
    const frame = await waitFor(() => {
      const shown = sidebar.querySelector("iframe");
      if (!shown) throw new Error("侧边栏的预览区里还没有 iframe");
      return shown;
    });
    await quiesce();

    expect(previewCalls(page.fetchMock)).toEqual([]);
    expect(frame.getAttribute("src")).toBe(`${BASE}out/index.html`);
    expect(frame.getAttribute("title")).toBe("index.html");
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.querySelector("iframe[srcdoc]")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "index.html", hidden: true })).toBeNull();
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    expect(artifactCards().map((card) => card.contains(frame))).toEqual([false]);
    // Nothing is in flight for the card, so neither button is ever disabled, and no failure line.
    expect(actions(OPEN_INDEX)).toEqual([head, foot]);
    expect(actions(OPEN_INDEX).map((button) => button.disabled)).toEqual([false, false]);
    expect(alerts()).toEqual([]);
    expect(blobs.createObjectURL).not.toHaveBeenCalled();
    expect(pageNotices()).toEqual(["status:已完成"]);
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);
  });
});

describe("图片与代码产物卡", () => {
  it("A5 下载 of an image card is a link to the download endpoint: no preview request, no Blob URL", async () => {
    const page = await openSession(changedTurn([write(CHART)]));

    const download = link(DOWNLOAD_CHART);
    expect(download.tagName).toBe("A");
    expect(download.getAttribute("href")).toBe(
      `/api/workspaces/${PROJ.id}/download?path=assets%2Fchart.PNG`,
    );
    expect(download.hasAttribute("download")).toBe(true);
    expect(download.closest('[data-slot="artifact-head"]')).not.toBeNull();
    expect(within(reply()).queryByRole("button", { name: DOWNLOAD_CHART })).toBeNull();

    // jsdom has no navigation: the default action is cancelled, the card's own handlers still run.
    download.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(download);
    await quiesce();

    expect(previewCalls(page.fetchMock)).toEqual([]);
    expect(blobs.createObjectURL).not.toHaveBeenCalled();
    expect(blobs.revokeObjectURL).not.toHaveBeenCalled();
    expect([...document.querySelectorAll("a[download]")]).toEqual([download]);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(alerts()).toEqual([]);
    expect(pageNotices()).toEqual(["status:已完成"]);
    expect(download.hasAttribute("aria-disabled")).toBe(false);
  });

  it("A6 copies exactly the fetched text and confirms with a hidden 已复制 status, not a toast", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const page = await openPreviewing([edit(APP, 2, 1)], () => textPreviewResponse(CODE_TEXT));

    fireEvent.click(action(COPY_APP));

    await waitFor(() => expect(copiedStatus()?.getAttribute("role")).toBe("status"));
    expect(pageNotices()).toEqual(["status:已完成", "status:已复制"]);
    expect(alerts()).toEqual([]);
    expect(writeText.mock.calls).toEqual([[CODE_TEXT]]);
    expect(previewCalls(page.fetchMock).map(([path]) => path)).toEqual([
      `/api/workspaces/${PROJ.id}/file?path=src%2Fapp.ts`,
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(action(COPY_APP).disabled).toBe(false);
  });

  const brokenClipboards: Array<[string, (() => void) | null]> = [
    ["there is no clipboard", null],
    [
      "writeText throws synchronously",
      () => {
        throw new Error("sync");
      },
    ],
    ["writeText rejects", () => Promise.reject(new DOMException("denied", "NotAllowedError"))],
  ];

  it.each(brokenClipboards)("A7 shows 复制失败 in the card when %s", async (_name, writeText) => {
    const spy = writeText === null ? null : stubClipboard(vi.fn(writeText as () => Promise<void>));
    expect("clipboard" in navigator).toBe(spy !== null);
    await openPreviewing([edit(APP, 2, 1)], () => textPreviewResponse(CODE_TEXT));

    await withoutUnhandledRejections(async () => {
      fireEvent.click(action(COPY_APP));
      await waitFor(() => expect(alerts()).toEqual(["复制失败"]));
    });
    expect(pageNotices()).toEqual(["alert:复制失败", "status:已完成"]);
    if (spy !== null) expect(spy.mock.calls).toEqual([[CODE_TEXT]]);
    expect(action(COPY_APP).disabled).toBe(false);
  });

  it("A7 refuses to copy a truncated preview", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    await openPreviewing([edit(APP, 2, 1)], () => truncatedPreview(CODE_TEXT));

    fireEvent.click(action(COPY_APP));

    await waitFor(() => expect(alerts()).toEqual(["文件过大，无法复制"]));
    await quiesce();
    expect(writeText).not.toHaveBeenCalled();
    expect(alerts()).toEqual(["文件过大，无法复制"]);
    expect(pageNotices()).toEqual(["alert:文件过大，无法复制", "status:已完成"]);
  });
});

describe("预览失败与类型不符", () => {
  it("A8 a deleted file shows the envelope message in its card, copies nothing and can be retried", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const page = await openPreviewing([write("main.py"), edit("gone.md", 1, 0)], () =>
      envelope(404, "not_found", "文件不存在或已被删除"),
    );
    expect(rowTexts(cardNamed("文件变更（2 个）"))).toEqual([
      "写入zhangsan/proj/main.py",
      "+1zhangsan/proj/gone.md",
    ]);
    expect(artifactCards()).toEqual([within(reply()).getByRole("group", { name: "gone.md" })]);

    await withoutUnhandledRejections(async () => {
      fireEvent.click(action("复制代码 gone.md"));
      await waitFor(() => expect(alerts()).toEqual(["文件不存在或已被删除"]));
    });
    expect(pageNotices()).toEqual(["alert:文件不存在或已被删除", "status:已完成"]);
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewCalls(page.fetchMock)).toHaveLength(1);
    expect(action("复制代码 gone.md").disabled).toBe(false);

    fireEvent.click(action("复制代码 gone.md"));

    await waitFor(() => expect(previewCalls(page.fetchMock)).toHaveLength(2));
    await waitFor(() => expect(action("复制代码 gone.md").disabled).toBe(false));
    expect(alerts()).toEqual(["文件不存在或已被删除"]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("A8 a network failure shows the request_failed text", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    await openPreviewing([edit(APP, 2, 1)], () => new TypeError("Failed to fetch"));

    await withoutUnhandledRejections(async () => {
      fireEvent.click(action(COPY_APP));
      await waitFor(() => expect(alerts()).toEqual([REQUEST_FAILED]));
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(action(COPY_APP).disabled).toBe(false);
  });

  const strayImages: Array<[string, Change, string]> = [["a code", edit(APP, 2, 1), COPY_APP]];

  it.each(strayImages)(
    "A9 %s card that receives an image revokes it and delivers nothing",
    async (_name, change, name) => {
      const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
      await openPreviewing([change], () => imagePreviewResponse());

      fireEvent.click(actions(name)[0] as HTMLButtonElement);

      await waitFor(() => expect(alerts()).toEqual([REQUEST_FAILED]));
      await quiesce();
      expect(blobs.revokeObjectURL.mock.calls).toEqual([[BLOB_URL]]);
      expect(writeText).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.querySelector("iframe")).toBeNull();
    },
  );
});

describe("拉取中、卸载与换账号", () => {
  // Beyond the design's A10: both clicks land in one React batch, before the button is disabled,
  // so only the card's in-flight gate can keep the second click from fetching.
  it("A10 two clicks dispatched before the disabled state commits send one request", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const pending = deferredResponse();
    const page = await openPreviewing([edit(APP, 2, 1)], () => pending.promise);
    const copy = action(COPY_APP);

    act(() => {
      fireEvent.click(copy);
      fireEvent.click(copy);
    });
    await quiesce();

    expect(previewCalls(page.fetchMock)).toHaveLength(1);
    expect(copy.disabled).toBe(true);

    await settleDeferredResponse(pending, textPreviewResponse(CODE_TEXT));

    await waitFor(() => expect(copiedStatus()?.getAttribute("role")).toBe("status"));
    expect(writeText.mock.calls).toEqual([[CODE_TEXT]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewCalls(page.fetchMock)).toHaveLength(1);
    expect(blobs.createObjectURL).not.toHaveBeenCalled();
  });

  it("A11 switching sessions aborts a pending preview and revokes the late Blob URL of an image the code card was sent", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const pending = deferredResponse();
    const page = await openPreviewing([edit(APP, 2, 1)], () => pending.promise, withOtherSession);

    fireEvent.click(action(COPY_APP));
    await quiesce();
    const signal = previewSignal(page.fetchMock);
    expect(signal.aborted).toBe(false);

    await switchSession();

    expect(signal.aborted).toBe(true);
    expect(artifactCards()).toEqual([]);

    await settleDeferredResponse(pending, imagePreviewResponse());
    await quiesce();

    expect(blobs.createObjectURL).toHaveBeenCalledTimes(1);
    expect(blobs.revokeObjectURL.mock.calls).toEqual([[BLOB_URL]]);
    expect(writeText).not.toHaveBeenCalled();
    expect(pageNotices()).toEqual(["status:已完成", "status:未开始"]);
    expect(previewCalls(page.fetchMock)).toHaveLength(1);
  });

  it("A11 a text preview that returns after the session switch is not copied", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const pending = deferredResponse();
    const page = await openPreviewing([edit(APP, 2, 1)], () => pending.promise, withOtherSession);

    fireEvent.click(action(COPY_APP));
    await quiesce();
    await switchSession();

    expect(previewSignal(page.fetchMock).aborted).toBe(true);

    await settleDeferredResponse(pending, textPreviewResponse(CODE_TEXT));
    await quiesce();

    expect(writeText).not.toHaveBeenCalled();
    expect(pageNotices()).toEqual(["status:已完成", "status:未开始"]);
    expect(blobs.createObjectURL).not.toHaveBeenCalled();
  });

  it("A11 a preview fetch rejected by the abort stays silent", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const page = await openPreviewing([edit(APP, 2, 1)], rejectOnAbort, withOtherSession);

    await withoutUnhandledRejections(async () => {
      fireEvent.click(action(COPY_APP));
      await quiesce();
      expect(previewCalls(page.fetchMock)).toHaveLength(1);

      await switchSession();
      await quiesce();
    });

    expect(previewSignal(page.fetchMock).aborted).toBe(true);
    expect(pageNotices()).toEqual(["status:已完成", "status:未开始"]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("A12 renewing the account aborts a pending preview without a toast or a copy", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const pending = deferredResponse();
    const snapshot = changedTurn([edit(APP, 2, 1)]);
    const { fetchMock, getProbe } = renderChatPageWithAuthProbe(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [WORKSPACES]: listed,
      [SESSION_MESSAGES]: () => jsonResponse(snapshot),
      [previewRoute(APP)]: () => pending.promise,
    });
    await waitFor(() => expect(artifactCards()).toHaveLength(1));

    fireEvent.click(action(COPY_APP));
    await quiesce();
    const signal = previewSignal(fetchMock);
    expect(signal.aborted).toBe(false);

    await renewAccount(getProbe);
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();

    expect(signal.aborted).toBe(true);

    await settleDeferredResponse(pending, textPreviewResponse(CODE_TEXT));
    await quiesce();

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(pageNotices()).toEqual(["status:已完成"]);
    expect(previewCalls(fetchMock)).toHaveLength(1);
  });

  it("A12 a 401 preview raises no toast of its own", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const page = await openPreviewing([edit(APP, 2, 1)], () =>
      envelope(401, "unauthorized", "登录已失效"),
    );

    await withoutUnhandledRejections(async () => {
      fireEvent.click(action(COPY_APP));
      await waitFor(() => expect(previewCalls(page.fetchMock)).toHaveLength(1));
      await quiesce();
    });

    expect(pageNotices()).toEqual([]);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("产物卡 placement", () => {
  it("A13 orders fold, body, step, approvals, file changes, artifact card, stopped badge and actions", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const settled: Message["approvals"][number] = {
      id: 9,
      tool: "write",
      title: "Allow tool: write",
      requestedAt: 1_760_000_000_000,
      stepId: null,
      expiresAt: 1_760_000_090_000,
      decision: "allow",
    };
    await openSession(
      turn("stopped", {
        thinking: "先想一想",
        approvals: [settled],
        content: "部分回答",
        steps: [toolStep(12, 0, "write", [write(INDEX)])],
      }),
    );

    const parts = replyParts();
    expect(parts.map(tagAndClass)).toEqual([
      "reasoning-root",
      "message-body",
      "tool-group-root",
      "approval-records",
      "file-changes-card",
      "artifact-card",
      "message-stopped",
      "message-actions",
    ]);
    expect(parts[4]).toBe(cardNamed("文件变更（1 个）"));
    expect(parts[5]).toBe(within(reply()).getByRole("group", { name: "index.html" }));
    expect(parts[6]).toBe(within(reply()).getByRole("status", { name: "助手消息 已停止" }));
    expect(artifactCards()).toEqual([parts[5]]);

    fireEvent.click(within(reply()).getByRole("button", { name: "复制" }));
    expect((await within(reply()).findByText("已复制")).getAttribute("role")).toBe("status");
    expect(pageNotices()).toEqual(["status:已停止", "status:已停止", "status:已复制"]);
    expect(writeText.mock.calls).toEqual([["部分回答"]]);
  });

  const unresolved: Array<[string, string | null]> = [
    ["the bound workspace is not listed", UNLISTED_ID],
    ["the session has no workspace", null],
  ];

  it.each(unresolved)(
    "A14 renders no artifact card when %s (guard)",
    async (_name, workspaceId) => {
      const snapshot = changedTurn([write(INDEX)], workspaceId);
      await openSession(snapshot, listed, withNeighbour(snapshot));

      expect(listedGroup()?.textContent).toContain("邻居会话");
      expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["写入out/index.html"]);
      expect(artifactCards()).toEqual([]);
    },
  );

  it("A14 renders no artifact card when the workspace list fails (guard)", async () => {
    await openSession(changedTurn([write(INDEX)]), () =>
      envelope(500, "internal", "工作空间不可用"),
    );

    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["写入out/index.html"]);
    expect(artifactCards()).toEqual([]);
  });

  it("A14 renders the artifact card only once the workspace list is installed", async () => {
    const gate = deferred<void>();
    const snapshot = changedTurn([write(INDEX)]);
    await openSession(snapshot, () => gate.promise.then(listed), withNeighbour(snapshot));

    expect(listedGroup()).toBeNull();
    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["写入out/index.html"]);
    expect(artifactCards()).toEqual([]);

    gate.resolve();
    await quiesce();

    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["写入zhangsan/proj/out/index.html"]);
    expect(artifactCards()).toEqual([within(reply()).getByRole("group", { name: "index.html" })]);
    expect(replyParts().indexOf(artifactCards()[0] as HTMLElement)).toBe(
      replyParts().indexOf(cards()[0] as Element) + 1,
    );
  });

  it("A14 renders no artifact card for a user message whose view holds a previewable change (guard)", async () => {
    const asker: Message = { ...historyUser, steps: [toolStep(31, 0, "write", [write("u.md")])] };
    const answer = assistantMessage("done", { content: "答" });
    await openSession({ ...turn("done"), messages: [asker, answer] });

    const question = screen.getByRole("article", { name: "用户" });
    expect(within(question).getAllByRole("button", { name: "新建 1 个文件" })).toHaveLength(1);
    expect(listedGroup()).not.toBeNull();
    expect(artifactCards()).toEqual([]);
    expect(screen.queryByRole("button", { name: /^复制代码/ })).toBeNull();
  });

  it("A14 shows the artifact card of a running step only after its step.end", async () => {
    const steps = [toolStep(21, 0, "edit", [edit("notes/todo.md", 3, 0)], "running")];
    await openSession(turn("running", { content: "正在改", steps }));
    const send = await goLive();

    expect(stepBadge("edit 运行中").textContent).toBe("运行中");
    expect(cards()).toEqual([]);
    expect(artifactCards()).toEqual([]);

    send("step.end", { stepId: 21, status: "done", output: "ok" });

    expect(stepBadge("edit 已完成").textContent).toBe("已完成");
    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["+3zhangsan/proj/notes/todo.md"]);
    expect(artifactCards()).toEqual([within(reply()).getByRole("group", { name: "todo.md" })]);
    expect(slot(artifactCards()[0] as HTMLElement, "label")?.textContent).toBe("MD");
  });

  it("A14 renders no artifact card for a message that only changed main.py (guard)", async () => {
    await openSession(changedTurn([write("main.py")]));

    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["写入zhangsan/proj/main.py"]);
    expect(artifactCards()).toEqual([]);
  });
});
