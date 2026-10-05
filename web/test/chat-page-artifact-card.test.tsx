/**
 * Issue #536 产物卡 (parent tasks 7.5b): A1–A15 of openspec/changes/artifact-card/design.md.
 * Seams: the pure `artifactKind`, the jsdom chat page over a stubbed `fetch`, the two Blob URL
 * statics, `<a>.click()`, `navigator.clipboard`, and the static CSS text. Expected values are
 * literals from the spec deltas; cases marked (guard) already hold before the change. H1 is from
 * review round 1; H2–H6 live in chat-page-artifact-card-state.test.tsx.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { artifactKind } from "../src/features/chat/stream-artifacts.js";
import {
  APP,
  action,
  actions,
  artifactCardFixture,
  artifactCards,
  BLOB_URL,
  CHART,
  CODE_TEXT,
  COPY_APP,
  changedTurn,
  DOWNLOAD_CHART,
  frameOf,
  HTML_TEXT,
  INDEX,
  OPEN_INDEX,
  openPreviewing,
  previewCalls,
  previewDialog,
  previewRoute,
  previewSignal,
  REQUEST_FAILED,
  rejectOnAbort,
  spyDownloads,
  stubClipboard,
  switchSession,
  TRUNCATION_NOTE,
  toasts,
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
import { deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";
import { readRepoFile, ruleBody, stripComments } from "./ui-support.js";

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
      "fieldset.file-changes-card",
      "fieldset.artifact-card",
      "fieldset.artifact-card",
      "fieldset.artifact-card",
      "div.chat-msg-actions",
    ]);
    expect(replyParts().slice(3, 6)).toEqual(derived);
    expect(
      ["app.ts", "index.html", "chart.PNG"].map((name) =>
        within(reply()).getByRole("group", { name }),
      ),
    ).toEqual(derived);
    expect(derived.map((card) => card.querySelector(".artifact-title")?.textContent)).toEqual([
      "app.ts",
      "index.html",
      "chart.PNG",
    ]);
    expect(derived.map((card) => card.querySelector(".artifact-lang")?.textContent)).toEqual([
      "TS",
      "HTML",
      "PNG",
    ]);
    expect(derived.map((card) => card.querySelector(".artifact-file-icon")?.className)).toEqual([
      "artifact-file-icon artifact-file-icon--code",
      "artifact-file-icon artifact-file-icon--html",
      "artifact-file-icon artifact-file-icon--image",
    ]);
    const glyphs = ["file-code", "globe", "image"];
    expect(
      derived.map((card, at) =>
        hasLucideGlyph(card.querySelector(".artifact-file-icon") ?? card, glyphs[at] ?? ""),
      ),
    ).toEqual([true, true, true]);
    expect(
      within(reply())
        .getAllByRole("button", { name: /^(复制代码|打开网页预览|下载) / })
        .map((button) => [button.getAttribute("aria-label"), button.closest("fieldset")]),
    ).toEqual([
      [COPY_APP, derived[0]],
      [OPEN_INDEX, derived[1]],
      [OPEN_INDEX, derived[1]],
      [DOWNLOAD_CHART, derived[2]],
    ]);
    expect(action(COPY_APP).getAttribute("title")).toBe(COPY_APP);
    expect(hasLucideGlyph(action(COPY_APP), "copy")).toBe(true);
    expect(action(DOWNLOAD_CHART).getAttribute("title")).toBe(DOWNLOAD_CHART);
    expect(hasLucideGlyph(action(DOWNLOAD_CHART), "download")).toBe(true);
    expect(derived.map((card) => card.querySelectorAll(".artifact-foot").length)).toEqual([
      0, 1, 0,
    ]);

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
  it("A3 opens the fetched page in a dialog iframe sandboxed to exactly allow-scripts", async () => {
    const page = await openPreviewing([write(INDEX)], () => textPreviewResponse(HTML_TEXT));

    const [head, foot] = actions(OPEN_INDEX);
    expect(actions(OPEN_INDEX)).toHaveLength(2);
    expect(head?.closest(".artifact-head")).not.toBeNull();
    expect(head?.getAttribute("title")).toBe(OPEN_INDEX);
    expect(foot?.closest(".artifact-foot")?.textContent).toContain("可交互预览");
    expect(foot?.textContent).toBe("打开网页预览");
    expect(previewCalls(page.fetchMock)).toEqual([]);

    fireEvent.click(head as HTMLButtonElement);
    const dialog = await previewDialog();

    expect(previewCalls(page.fetchMock).map(([path, options]) => [path, options?.method])).toEqual([
      [`/api/workspaces/${PROJ.id}/file?path=out%2Findex.html`, "GET"],
    ]);
    const frame = frameOf(dialog);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toBe(HTML_TEXT);
    expect(frame.getAttribute("title")).toBe("index.html");
    expect(frame.hasAttribute("src")).toBe(false);
    expect(dialog.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(artifactCards().map((card) => card.contains(frame))).toEqual([false]);
    expect(within(dialog).queryByText(TRUNCATION_NOTE)).toBeNull();
    expect(screen.queryByRole("heading", { name: "hi", hidden: true })).toBeNull();
    expect(blobs.createObjectURL).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector("iframe")).toBeNull();
    expect(previewCalls(page.fetchMock)).toHaveLength(1);
  });

  it("A3 opens from the foot button without prior focus and hands focus back to that button", async () => {
    const page = await openPreviewing([write(INDEX)], () => textPreviewResponse(HTML_TEXT));
    const [head, foot] = actions(OPEN_INDEX);
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(foot as HTMLButtonElement);
    const dialog = await previewDialog();

    expect(frameOf(dialog).getAttribute("srcdoc")).toBe(HTML_TEXT);
    expect(previewCalls(page.fetchMock)).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));

    await waitFor(() => expect(document.activeElement).toBe(foot));
    expect(actions(OPEN_INDEX)).toEqual([head, foot]);
    expect(document.activeElement).not.toBe(head);
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("A4 shows the truncation note above the iframe when the preview was cut at 1 MiB", async () => {
    await openPreviewing([write(INDEX)], () => truncatedPreview(HTML_TEXT));

    fireEvent.click(actions(OPEN_INDEX)[0] as HTMLButtonElement);
    const dialog = await previewDialog();

    const note = within(dialog).getByText(TRUNCATION_NOTE);
    const frame = frameOf(dialog);
    expect(frame.getAttribute("srcdoc")).toBe(HTML_TEXT);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(note.compareDocumentPosition(frame)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe("图片与代码产物卡", () => {
  it("A5 downloads the image through a temporary link and revokes its Blob URL one task later", async () => {
    const page = await openPreviewing([write(CHART)], () => imagePreviewResponse());
    const clicks = spyDownloads(blobs.revokeObjectURL);

    fireEvent.click(action(DOWNLOAD_CHART));
    await waitFor(() => expect(clicks).toHaveLength(1));
    await quiesce();

    expect(previewCalls(page.fetchMock).map(([path]) => path)).toEqual([
      `/api/workspaces/${PROJ.id}/file?path=assets%2Fchart.PNG`,
    ]);
    expect(clicks).toEqual([
      { href: BLOB_URL, download: "chart.PNG", revokedAtClick: 0, revokedNextTimer: 0 },
    ]);
    expect(blobs.revokeObjectURL.mock.calls).toEqual([[BLOB_URL]]);
    expect(document.querySelector("a[download]")).toBeNull();
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(toasts()).toEqual([]);
    expect(action(DOWNLOAD_CHART).disabled).toBe(false);
  });

  it("A6 copies exactly the fetched text and confirms with a toast", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const page = await openPreviewing([edit(APP, 2, 1)], () => textPreviewResponse(CODE_TEXT));

    fireEvent.click(action(COPY_APP));

    await waitFor(() => expect(toasts()).toEqual([["success", "已复制到剪贴板"]]));
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

  it.each(brokenClipboards)("A7 toasts 复制失败 when %s", async (_name, writeText) => {
    const spy = writeText === null ? null : stubClipboard(vi.fn(writeText as () => Promise<void>));
    expect("clipboard" in navigator).toBe(spy !== null);
    await openPreviewing([edit(APP, 2, 1)], () => textPreviewResponse(CODE_TEXT));

    await withoutUnhandledRejections(async () => {
      fireEvent.click(action(COPY_APP));
      await waitFor(() => expect(toasts()).toEqual([["error", "复制失败"]]));
    });
    if (spy !== null) expect(spy.mock.calls).toEqual([[CODE_TEXT]]);
    expect(action(COPY_APP).disabled).toBe(false);
  });

  it("A7 refuses to copy a truncated preview", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    await openPreviewing([edit(APP, 2, 1)], () => truncatedPreview(CODE_TEXT));

    fireEvent.click(action(COPY_APP));

    await waitFor(() => expect(toasts()).toEqual([["error", "文件过大，无法复制"]]));
    await quiesce();
    expect(writeText).not.toHaveBeenCalled();
    expect(toasts()).toEqual([["error", "文件过大，无法复制"]]);
  });
});

describe("预览失败与类型不符", () => {
  it("A8 a deleted file toasts the envelope message, copies nothing and can be retried", async () => {
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
      await waitFor(() => expect(toasts()).toEqual([["error", "文件不存在或已被删除"]]));
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewCalls(page.fetchMock)).toHaveLength(1);
    expect(action("复制代码 gone.md").disabled).toBe(false);

    fireEvent.click(action("复制代码 gone.md"));

    await waitFor(() => expect(previewCalls(page.fetchMock)).toHaveLength(2));
    await waitFor(() => expect(toasts()).toHaveLength(2));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("A8 an unsupported html preview toasts the envelope message and opens no dialog", async () => {
    await openPreviewing([write(INDEX)], () =>
      envelope(415, "preview_unsupported", "该文件类型不支持预览"),
    );

    fireEvent.click(actions(OPEN_INDEX)[0] as HTMLButtonElement);

    await waitFor(() => expect(toasts()).toEqual([["error", "该文件类型不支持预览"]]));
    await quiesce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(actions(OPEN_INDEX).map((button) => button.disabled)).toEqual([false, false]);
  });

  it("A8 an oversized image toasts the envelope message and downloads nothing", async () => {
    await openPreviewing([write(CHART)], () =>
      envelope(413, "preview_too_large", "图片超过预览上限"),
    );
    const clicks = spyDownloads(blobs.revokeObjectURL);

    fireEvent.click(action(DOWNLOAD_CHART));

    await waitFor(() => expect(toasts()).toEqual([["error", "图片超过预览上限"]]));
    await quiesce();
    expect(clicks).toEqual([]);
    expect(blobs.createObjectURL).not.toHaveBeenCalled();
  });

  it("A8 a network failure toasts the request_failed text", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    await openPreviewing([edit(APP, 2, 1)], () => new TypeError("Failed to fetch"));

    await withoutUnhandledRejections(async () => {
      fireEvent.click(action(COPY_APP));
      await waitFor(() => expect(toasts()).toEqual([["error", REQUEST_FAILED]]));
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(action(COPY_APP).disabled).toBe(false);
  });

  const strayImages: Array<[string, Change, string]> = [
    ["a code", edit(APP, 2, 1), COPY_APP],
    ["an html", write(INDEX), OPEN_INDEX],
  ];

  it.each(strayImages)(
    "A9 %s card that receives an image revokes it and delivers nothing",
    async (_name, change, name) => {
      const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
      await openPreviewing([change], () => imagePreviewResponse());

      fireEvent.click(actions(name)[0] as HTMLButtonElement);

      await waitFor(() => expect(toasts()).toEqual([["error", REQUEST_FAILED]]));
      await quiesce();
      expect(blobs.revokeObjectURL.mock.calls).toEqual([[BLOB_URL]]);
      expect(writeText).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.querySelector("iframe")).toBeNull();
    },
  );

  it("A9 an image card that receives text downloads nothing", async () => {
    await openPreviewing([write(CHART)], () => textPreviewResponse("not an image"));
    const clicks = spyDownloads(blobs.revokeObjectURL);

    fireEvent.click(action(DOWNLOAD_CHART));

    await waitFor(() => expect(toasts()).toEqual([["error", REQUEST_FAILED]]));
    await quiesce();
    expect(clicks).toEqual([]);
    expect(blobs.revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe("拉取中、卸载与换账号", () => {
  const clicked: Array<[string, number]> = [
    ["head", 0],
    ["foot", 1],
  ];

  it.each(clicked)(
    "A10 disables both buttons of the html card while its preview is pending (%s button clicked)",
    async (_name, at) => {
      const pending = deferredResponse();
      const page = await openPreviewing([write(INDEX), edit(APP, 2, 1)], () => pending.promise);
      const buttons = actions(OPEN_INDEX);
      expect(buttons.map((button) => button.disabled)).toEqual([false, false]);

      fireEvent.click(buttons[at] as HTMLButtonElement);
      await quiesce();

      expect(actions(OPEN_INDEX)).toEqual(buttons);
      expect(buttons.map((button) => button.disabled)).toEqual([true, true]);
      expect(action(COPY_APP).disabled).toBe(false);
      expect(previewCalls(page.fetchMock)).toHaveLength(1);

      for (const button of buttons) fireEvent.click(button);
      await quiesce();

      expect(previewCalls(page.fetchMock)).toHaveLength(1);
      expect(screen.queryByRole("dialog")).toBeNull();

      await settleDeferredResponse(pending, textPreviewResponse(HTML_TEXT));
      const dialog = await previewDialog();

      expect(frameOf(dialog).getAttribute("srcdoc")).toBe(HTML_TEXT);
      expect(actions(OPEN_INDEX).map((button) => button.disabled)).toEqual([false, false]);
      expect(previewCalls(page.fetchMock)).toHaveLength(1);
    },
  );

  // Beyond the design's A10: both clicks land in one React batch, before the buttons are disabled,
  // so only the card's in-flight gate can keep the second click from fetching.
  it("A10 two clicks dispatched before the disabled state commits send one request", async () => {
    const pending = deferredResponse();
    const page = await openPreviewing([write(INDEX)], () => pending.promise);
    const buttons = actions(OPEN_INDEX);

    act(() => {
      for (const button of buttons) fireEvent.click(button);
    });
    await quiesce();

    expect(previewCalls(page.fetchMock)).toHaveLength(1);
    expect(buttons.map((button) => button.disabled)).toEqual([true, true]);

    await settleDeferredResponse(pending, textPreviewResponse(HTML_TEXT));

    expect(frameOf(await previewDialog()).getAttribute("srcdoc")).toBe(HTML_TEXT);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(previewCalls(page.fetchMock)).toHaveLength(1);
  });

  it("A11 switching sessions aborts a pending image preview and revokes the late Blob URL", async () => {
    const pending = deferredResponse();
    const page = await openPreviewing([write(CHART)], () => pending.promise, withOtherSession);
    const clicks = spyDownloads(blobs.revokeObjectURL);

    fireEvent.click(action(DOWNLOAD_CHART));
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
    expect(clicks).toEqual([]);
    expect(toasts()).toEqual([]);
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
    expect(toasts()).toEqual([]);
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
    expect(toasts()).toEqual([]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("A12 renewing the account aborts a pending preview without a toast or a dialog", async () => {
    const pending = deferredResponse();
    const snapshot = changedTurn([write(INDEX)]);
    const { fetchMock, getProbe } = renderChatPageWithAuthProbe(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [WORKSPACES]: listed,
      [SESSION_MESSAGES]: () => jsonResponse(snapshot),
      [previewRoute(INDEX)]: () => pending.promise,
    });
    await waitFor(() => expect(artifactCards()).toHaveLength(1));

    fireEvent.click(actions(OPEN_INDEX)[1] as HTMLButtonElement);
    await quiesce();
    const signal = previewSignal(fetchMock);
    expect(signal.aborted).toBe(false);

    await renewAccount(getProbe);
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();

    expect(signal.aborted).toBe(true);

    await settleDeferredResponse(pending, textPreviewResponse(HTML_TEXT));
    await quiesce();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(toasts()).toEqual([]);
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

    expect(toasts()).toEqual([]);
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
      "div.chat-approvals",
      "fieldset.file-changes-card",
      "fieldset.artifact-card",
      "message-stopped",
      "div.chat-msg-actions",
    ]);
    expect(parts[4]).toBe(cardNamed("文件变更（1 个）"));
    expect(parts[5]).toBe(within(reply()).getByRole("group", { name: "index.html" }));
    expect(parts[6]).toBe(within(reply()).getByRole("status", { name: "助手消息 已停止" }));
    expect(artifactCards()).toEqual([parts[5]]);

    fireEvent.click(within(reply()).getByRole("button", { name: "复制" }));

    await waitFor(() => expect(toasts()).toEqual([["success", "已复制到剪贴板"]]));
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
    expect(within(question).getAllByRole("button", { name: /个步骤 · write/ })).toHaveLength(1);
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
    expect(artifactCards()[0]?.querySelector(".artifact-lang")?.textContent).toBe("MD");
  });

  it("A14 renders no artifact card for a message that only changed main.py (guard)", async () => {
    await openSession(changedTurn([write("main.py")]));

    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["写入zhangsan/proj/main.py"]);
    expect(artifactCards()).toEqual([]);
  });
});

describe("artifact card static styles", () => {
  const css = () => stripComments(readRepoFile("web/src/features/chat/messages.css"));

  it("A15 gives the preview iframe no border and colours the three icon blocks with tokens", () => {
    expect(ruleBody(css(), ".artifact-preview-frame")).toContain("border: 0");
    const html = ruleBody(css(), ".artifact-file-icon--html");
    expect(html).toContain("background: var(--wb-status-warning-soft-bg)");
    expect(html).toContain("color: var(--wb-status-warning-text)");
    const code = ruleBody(css(), ".artifact-file-icon--code");
    expect(code).toContain("background: var(--wb-brand-primary-subtle)");
    expect(code).toContain("color: var(--wb-brand-primary)");
    const image = ruleBody(css(), ".artifact-file-icon--image");
    expect(image).toContain("background: var(--wb-bg-tertiary)");
    expect(image).toContain("color: var(--wb-text-secondary)");
  });

  it("A15 keeps artifact styles out of chat.css (guard)", () => {
    expect(readRepoFile("web/src/features/chat/chat.css")).not.toContain("artifact-");
  });
});
