/**
 * Issue 536 产物卡, review round 1: H2–H6 (H1 extends the `artifactKind` tables in
 * chat-page-artifact-card.test.tsx). Page-level cases about what a card shares with the 文件变更
 * card and what state it keeps: the summary's dedupe, the busy state of the code card, state that
 * follows the path when cards are inserted, and a clipboard write outliving the card. Seams as in
 * that file: the jsdom chat page over a stubbed `fetch`, the live event source, the two Blob URL
 * statics, `<a>.click()` and `navigator.clipboard`. Issue #1110 removed the html preview dialog and
 * the image fetch: H3, the open-preview H5 and H4's image row went with them, the pending H5 is now
 * about the code card.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  APP,
  action,
  artifactCardFixture,
  artifactCards,
  CODE_TEXT,
  COPY_APP,
  cardTitles,
  copiedStatus,
  openPreviewing,
  previewCalls,
  previewRoute,
  spyDownloads,
  stubClipboard,
  switchSession,
  toasts,
  withOtherSession,
  withoutUnhandledRejections,
} from "./chat-page-artifact-card-support.js";
import {
  type Change,
  cardNamed,
  edit,
  goLive,
  listed,
  openSession,
  quiesce,
  reply,
  rowTexts,
  toolStep,
  turn,
  write,
} from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { deferred, settle } from "./chat-stream-support.js";
import { deferredResponse, textPreviewResponse } from "./support.js";

const NOTES = "notes/a.md";

const blobs = artifactCardFixture();

describe("产物卡 and the file-change summary", () => {
  it("H2 derives one card per summary row when a later step changes a path again", async () => {
    const steps = [
      toolStep(11, 0, "write", [write(NOTES)]),
      toolStep(12, 1, "write", [write("src/b.ts")]),
      toolStep(13, 2, "edit", [edit(NOTES, 4, 1)]),
    ];
    await openSession(turn("done", { content: "改好了", steps }));

    expect(rowTexts(cardNamed("文件变更（2 个）"))).toEqual([
      "+4-1zhangsan/proj/notes/a.md",
      "写入zhangsan/proj/src/b.ts",
    ]);
    expect(artifactCards()).toHaveLength(2);
    expect(cardTitles()).toEqual(["a.md", "b.ts"]);
    expect(["a.md", "b.ts"].map((name) => within(reply()).getAllByRole("group", { name }))).toEqual(
      artifactCards().map((card) => [card]),
    );
  });
});

describe("产物卡 state", () => {
  const pendingKinds: Array<[string, Change, string, () => Response, boolean, number]> = [
    ["code", edit(APP, 2, 1), COPY_APP, () => textPreviewResponse(CODE_TEXT), true, 0],
  ];

  it.each(pendingKinds)(
    "H4 disables the action of the %s card while its preview is pending",
    async (_kind, change, name, response, copied, expectedDownloads) => {
      stubClipboard(vi.fn((_text: string) => Promise.resolve()));
      const pending = deferredResponse();
      const page = await openPreviewing([change], () => pending.promise);
      const clicks = spyDownloads(blobs.revokeObjectURL);
      const button = action(name);
      expect(button.disabled).toBe(false);

      fireEvent.click(button);
      await quiesce();

      expect(action(name)).toBe(button);
      expect(button.disabled).toBe(true);
      expect(previewCalls(page.fetchMock)).toHaveLength(1);
      expect(toasts()).toEqual([]);
      expect(copiedStatus()).toBeNull();
      expect(clicks).toEqual([]);

      await settleDeferredResponse(pending, response());
      await waitFor(() => expect(button.disabled).toBe(false));
      await quiesce();

      expect(action(name)).toBe(button);
      expect(toasts()).toEqual([]);
      expect(copiedStatus() !== null).toBe(copied);
      expect(clicks).toHaveLength(expectedDownloads);
      expect(previewCalls(page.fetchMock)).toHaveLength(1);
    },
  );

  /** A running turn: step 21 (ordinal 0) still runs on notes/a.md, step 22 has edited app.ts. */
  const codeBeforeNotes = () =>
    turn("running", {
      content: "正在改",
      steps: [
        toolStep(21, 0, "write", [write(NOTES)], "running"),
        toolStep(22, 1, "edit", [edit(APP, 2, 1)]),
      ],
    });
  const endNotes = { stepId: 21, status: "done", output: "ok" };

  it("H5 a pending copy stays with its card when an earlier step's card is inserted before it", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const pending = deferredResponse();
    const page = await openSession(codeBeforeNotes(), listed, {
      [previewRoute(APP)]: () => pending.promise,
    });
    const send = await goLive();
    expect(cardTitles()).toEqual(["app.ts"]);

    fireEvent.click(action(COPY_APP));
    await quiesce();
    expect(previewCalls(page.fetchMock)).toHaveLength(1);

    send("step.end", endNotes);
    await quiesce();

    expect(cardTitles()).toEqual(["a.md", "app.ts"]);
    expect(action(COPY_APP).disabled).toBe(true);
    expect(action("复制代码 a.md").disabled).toBe(false);
    expect(copiedStatus()).toBeNull();

    await settleDeferredResponse(pending, textPreviewResponse(CODE_TEXT));

    await waitFor(() => expect(copiedStatus()?.getAttribute("role")).toBe("status"));
    expect(copiedStatus()?.closest('[data-slot="artifact-card"]')).toBe(artifactCards()[1]);
    expect(writeText.mock.calls).toEqual([[CODE_TEXT]]);
    expect(action(COPY_APP).disabled).toBe(false);
    expect(action("复制代码 a.md").disabled).toBe(false);
    expect(previewCalls(page.fetchMock)).toHaveLength(1);
    expect(toasts()).toEqual([]);
  });

  it("H6 a clipboard write still pending at the session switch completes without a toast or a rejection", async () => {
    const written = deferred<void>();
    const writeText = stubClipboard(vi.fn((_text: string) => written.promise));
    const page = await openPreviewing(
      [edit(APP, 2, 1)],
      () => textPreviewResponse(CODE_TEXT),
      withOtherSession,
    );

    await withoutUnhandledRejections(async () => {
      fireEvent.click(action(COPY_APP));
      await waitFor(() => expect(writeText.mock.calls).toEqual([[CODE_TEXT]]));
      await quiesce();
      expect(toasts()).toEqual([]);

      await switchSession();

      expect(artifactCards()).toEqual([]);
      expect(toasts()).toEqual([]);

      await act(async () => {
        written.resolve();
        await settle();
      });

      await quiesce();
      expect(toasts()).toEqual([]);
      expect(screen.queryByText("已复制")).toBeNull();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(previewCalls(page.fetchMock)).toHaveLength(1);
  });
});
