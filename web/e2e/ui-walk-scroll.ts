// UI walk scroll-follow step (W-scroll): the transcript is forced to overflow by lowering the
// viewport height only; a pinned transcript follows container and content size changes, a
// scrolled-up one keeps its position and shows `回到最新` by the distance rule.

import { expect, type Locator, type Page, test } from "@playwright/test";
import { type WalkProject, withViewport } from "./ui-walk-layout.js";

// W-scroll 的量纲：强制溢出的余量、Step 3 再压低的高度、断言可信所需的最小可视高度。
const SCROLL_OVERFLOW_PX = 80;
const SCROLL_STEP3_SHRINK_PX = 40;
const SCROLL_MIN_CLIENT_PX = 80;
const SCROLL_MIN_OVERFLOW_PX = 60;
const PIN_TOLERANCE_PX = 4;

interface TranscriptMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  distance: number;
  threadHeight: number;
  pageScrollHeight: number;
  innerHeight: number;
}

function transcriptMetrics(transcript: Locator): Promise<TranscriptMetrics> {
  return transcript.evaluate((el) => {
    const thread = el.firstElementChild;
    if (!(thread instanceof HTMLElement) || !thread.matches("section.chat-thread")) {
      throw new Error("transcript content root is not section.chat-thread");
    }
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      distance: el.scrollHeight - el.scrollTop - el.clientHeight,
      threadHeight: thread.offsetHeight,
      pageScrollHeight: document.scrollingElement?.scrollHeight ?? 0,
      innerHeight: window.innerHeight,
    };
  });
}

// 距底断言前的前提：转录确实溢出、可视区不至于过矮、页面自身不滚动。
function expectForcedOverflow(metrics: TranscriptMetrics, step: string): void {
  expect(
    metrics.scrollHeight - metrics.clientHeight,
    `${step}: transcript overflow`,
  ).toBeGreaterThanOrEqual(SCROLL_MIN_OVERFLOW_PX);
  expect(metrics.clientHeight, `${step}: transcript clientHeight`).toBeGreaterThanOrEqual(
    SCROLL_MIN_CLIENT_PX,
  );
  expect(metrics.pageScrollHeight, `${step}: page does not scroll`).toBeLessThanOrEqual(
    metrics.innerHeight + 1,
  );
}

async function expectClientHeight(transcript: Locator, height: number, step: string) {
  await expect
    .poll(async () => (await transcriptMetrics(transcript)).clientHeight, `${step}: clientHeight`)
    .toBe(height);
}

function expectPinnedDistance(transcript: Locator, step: string) {
  return expect
    .poll(async () => (await transcriptMetrics(transcript)).distance, `${step}: distance`)
    .toBeLessThanOrEqual(PIN_TOLERANCE_PX);
}

// #373：转录区尺寸变化（视口变矮、展开 `原始输出`）也要重算贴底；只改高度，不跨 760px 断点。
export async function walkScrollFollow(page: Page, project: WalkProject): Promise<void> {
  const original = page.viewportSize();
  if (!original) throw new Error("ui-walk requires a fixed viewport");
  const transcript = page.locator(".chat-transcript");
  const initial = await transcriptMetrics(transcript);
  expect(initial.distance, "W-scroll: pinned before resizing").toBeLessThanOrEqual(
    PIN_TOLERANCE_PX,
  );
  const target = Math.min(
    initial.threadHeight - SCROLL_OVERFLOW_PX,
    initial.clientHeight - SCROLL_STEP3_SHRINK_PX,
  );
  expect(target, "W-scroll: content tall enough for steps 1–3").toBeGreaterThanOrEqual(
    SCROLL_MIN_CLIENT_PX + SCROLL_STEP3_SHRINK_PX,
  );
  const step1Height = original.height - (initial.clientHeight - target);
  const step3Height = step1Height - SCROLL_STEP3_SHRINK_PX;
  console.log(
    `ui-walk W-scroll ${project}: viewport ${original.width}x${original.height}, ` +
      `clientHeight ${initial.clientHeight}, thread ${initial.threadHeight} -> ` +
      `step1 viewport height ${step1Height} (clientHeight ${target}), ` +
      `step3 viewport height ${step3Height} (clientHeight ${target - SCROLL_STEP3_SHRINK_PX})`,
  );
  await withViewport(page, { width: original.width, height: step1Height }, async () => {
    await test.step("W-scroll 1: pinned transcript re-sticks when its container shrinks", async () => {
      await expectClientHeight(transcript, target, "W-scroll 1");
      expectForcedOverflow(await transcriptMetrics(transcript), "W-scroll 1");
      await expectPinnedDistance(transcript, "W-scroll 1");
    });

    await test.step("W-scroll 2: expanding 原始输出 while pinned keeps following", async () => {
      const summary = page
        .getByRole("article", { name: "助手" })
        .getByRole("region", { name: "bash" })
        .locator("summary.chat-step-summary");
      await expect(summary).toHaveText("原始输出");
      const before = await transcriptMetrics(transcript);
      expectForcedOverflow(before, "W-scroll 2");
      expect(before.distance, "W-scroll 2: pinned before expanding").toBeLessThanOrEqual(
        PIN_TOLERANCE_PX,
      );
      const [summaryBox, transcriptBox] = await boxesOf(summary, transcript);
      const fullyVisible =
        summaryBox.y >= transcriptBox.y &&
        summaryBox.y + summaryBox.height <= transcriptBox.y + transcriptBox.height;
      // 点击前的 scroll-into-view 会触发 scroll 并解除贴底；不完全可见时改为直接展开。
      if (fullyVisible) await summary.click();
      else {
        await summary.evaluate((el) => {
          if (el.parentElement instanceof HTMLDetailsElement) el.parentElement.open = true;
        });
      }
      await expect(summary.locator("xpath=..")).toHaveAttribute("open", "");
      await expect(summary.locator("xpath=..").locator("pre.chat-step-output")).toBeVisible();
      await expect
        .poll(async () => (await transcriptMetrics(transcript)).threadHeight, "W-scroll 2: grew")
        .toBeGreaterThan(before.threadHeight);
      expectForcedOverflow(await transcriptMetrics(transcript), "W-scroll 2");
      await expectPinnedDistance(transcript, "W-scroll 2");
      console.log(
        `ui-walk W-scroll ${project}: 原始输出 ${fullyVisible ? "clicked" : "opened via evaluate"}, ` +
          `thread ${before.threadHeight} -> ${(await transcriptMetrics(transcript)).threadHeight}`,
      );
    });

    await test.step("W-scroll 3: a scrolled-up transcript is not yanked by a resize", async () => {
      await transcript.evaluate(
        (el) =>
          new Promise<void>((resolve) => {
            el.addEventListener("scroll", () => resolve(), { once: true });
            el.scrollTop = 0;
          }),
      );
      const unpinned = await transcriptMetrics(transcript);
      expect(unpinned.scrollTop, "W-scroll 3: scrolled to top").toBe(0);
      expect(unpinned.distance, "W-scroll 3: unpinned").toBeGreaterThan(PIN_TOLERANCE_PX);
      await page.setViewportSize({ width: original.width, height: step3Height });
      const shrunk = target - SCROLL_STEP3_SHRINK_PX;
      await expectClientHeight(transcript, shrunk, "W-scroll 3");
      // 两帧后读取：保证本次尺寸变化的 ResizeObserver 回调已投递。
      await transcript.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const after = await transcriptMetrics(transcript);
      expectForcedOverflow(after, "W-scroll 3");
      expect(after.scrollTop, "W-scroll 3: position kept").toBe(unpinned.scrollTop);
      const jump = page.getByRole("button", { name: "回到最新" });
      if (after.distance > after.clientHeight) await expect(jump).toBeVisible();
      else await expect(jump).toHaveCount(0);
      console.log(
        `ui-walk W-scroll ${project}: step3 distance ${after.distance}, ` +
          `clientHeight ${after.clientHeight}, 回到最新 ${after.distance > after.clientHeight ? "visible" : "absent"}`,
      );
    });

    await test.step("W-scroll 4: a taller viewport that reaches the bottom hides 回到最新", async () => {
      const jump = page.getByRole("button", { name: "回到最新" });
      let height = step3Height;
      const start = await transcriptMetrics(transcript);
      expect(start.scrollTop, "W-scroll 4: still scrolled to top").toBe(0);
      if (start.distance <= start.clientHeight) {
        // 距底 > clientHeight 需要 clientHeight < scrollHeight / 2（scrollTop 为 0）。
        const client = Math.ceil(start.scrollHeight / 2) - 1;
        expect(client, "W-scroll 4: shrunk clientHeight").toBeGreaterThanOrEqual(
          SCROLL_MIN_CLIENT_PX,
        );
        height -= start.clientHeight - client;
        await page.setViewportSize({ width: original.width, height });
        await expect
          .poll(async () => {
            const m = await transcriptMetrics(transcript);
            return m.distance > m.clientHeight;
          }, "W-scroll 4: scrolled up more than a viewport")
          .toBe(true);
      }
      await expect(jump).toBeVisible();
      const before = await transcriptMetrics(transcript);
      const grown = height + before.scrollHeight - before.clientHeight;
      expect(grown, "W-scroll 4: taller viewport height").toBeLessThanOrEqual(2000);
      await transcript.evaluate((el) => {
        const counter = globalThis as unknown as { walkScrollEvents?: number };
        counter.walkScrollEvents = 0;
        el.addEventListener("scroll", () => {
          counter.walkScrollEvents = (counter.walkScrollEvents ?? 0) + 1;
        });
      });
      await page.setViewportSize({ width: original.width, height: grown });
      await expect
        .poll(async () => {
          const m = await transcriptMetrics(transcript);
          return m.scrollHeight <= m.clientHeight;
        }, "W-scroll 4: transcript no longer overflows")
        .toBe(true);
      // 两帧后读取：保证本次尺寸变化的 ResizeObserver 回调已投递。
      await transcript.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const after = await transcriptMetrics(transcript);
      const scrolls = await page.evaluate(
        () => (globalThis as unknown as { walkScrollEvents?: number }).walkScrollEvents ?? 0,
      );
      expect(after.scrollTop, "W-scroll 4: position kept").toBe(0);
      expect(scrolls, "W-scroll 4: no scroll event").toBe(0);
      await expect(jump).toHaveCount(0);
      console.log(
        `ui-walk W-scroll ${project}: step4 viewport height ${step3Height} -> ${height} ` +
          `(clientHeight ${before.clientHeight}, scrollHeight ${before.scrollHeight}, ` +
          `distance ${before.distance}) -> ${grown} (clientHeight ${after.clientHeight}, ` +
          `scrollHeight ${after.scrollHeight}), 回到最新 absent`,
      );
    });
  });
}

async function boxesOf(first: Locator, second: Locator) {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  if (!a || !b) throw new Error("expected both elements to have a bounding box");
  return [a, b] as const;
}
