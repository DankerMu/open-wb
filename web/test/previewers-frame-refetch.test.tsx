// file-previewers「隔离来源的嵌入与令牌」的场景「签发失败后刷新」与「过期的 base 不建首帧」，页面级：
// 经文件页与假 fetch。jsdom 不为 iframe 导航，这里钉的是签发请求的次数、iframe 节点有没有被建出来
// 与它的 `src` 属性；浏览器拿到过期地址时实际显示什么不在这个文件里。
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFilesFixture } from "./files-fixture.js";
import {
  BASE,
  fileRequests,
  ISSUE,
  issued,
  issueRequests,
  openSite,
  PREVIEW_HOST,
  previewRegion,
  renderSite,
  select,
  shownFrame,
} from "./files-site-fixture.js";
import { deferredResponse, jsonResponse } from "./support.js";

afterEach(() => {
  vi.useRealTimers();
  cleanupFilesFixture();
  vi.restoreAllMocks();
});

/** 第二次签发给出的地址前缀：与 `BASE` 不同，`src` 用了哪一次的结果由此可辨。 */
const NEXT_BASE = `https://${PREVIEW_HOST}/w/${"u".repeat(64)}/`;

describe("文件页的网页预览（页面级）：签发失败后重新签发", () => {
  it.each([
    ["点「刷新」", () => fireEvent.click(screen.getByRole("button", { name: "刷新" }))],
    ["再点同一行", () => fireEvent.click(screen.getByRole("button", { name: "index.html" }))],
  ])(
    "第一次签发答 500、第二次成功：先是失败文案、没有 iframe；%s后签发请求恰两次，iframe 的 src 是新 base 加路径，全程零 file 请求",
    async (_label, again) => {
      const { fetchMock } = renderSite({
        [ISSUE]: [
          jsonResponse({ error: { code: "internal_error", message: "签发失败" } }, 500),
          issued(NEXT_BASE),
        ],
      });
      await openSite();
      await select("index.html");

      expect((await previewRegion().findByRole("alert")).textContent).toBe("签发失败");
      expect(document.querySelector("iframe")).toBeNull();
      expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);

      again();
      const rendered = await shownFrame("index.html");
      expect(rendered.getAttribute("src")).toBe(`${NEXT_BASE}site/index.html`);
      expect(previewRegion().queryByRole("alert")).toBeNull();
      expect(issueRequests(fetchMock)).toStrictEqual([ISSUE, ISSUE]);
      expect(fileRequests(fetchMock)).toStrictEqual([]);
    },
  );
});

describe("文件页的网页预览（页面级）：过期的 base", () => {
  // 假时钟随真实时间走（`findBy…` 照常轮询），离开的那六分钟由 `advanceTimersByTimeAsync` 一次跨过。
  it("选中 index.html 后改选 readme.md，六分钟后再选回：第二次签发落定之前没有建过 iframe、显示「正在加载预览…」；落定后 src 以新 base 开头，签发请求合计两次", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const second = deferredResponse();
    const answers = [issued(), second.promise];
    const { fetchMock } = renderSite({ [ISSUE]: () => answers.shift() ?? new Error("第三次签发") });
    const createElement = vi.spyOn(document, "createElement");
    const framesBuilt = () =>
      createElement.mock.calls.filter(([tag]) => tag.toLowerCase() === "iframe").length;

    await openSite();
    await select("index.html");
    expect((await shownFrame("index.html")).getAttribute("src")).toBe(`${BASE}site/index.html`);
    // 这个计数看得见 iframe 的建立：第一次选中恰建了一个。
    expect(framesBuilt()).toBe(1);

    await select("readme.md");
    expect(await screen.findByRole("heading", { level: 1, name: "说明" })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(360_000));
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);

    await select("index.html");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE, ISSUE]);
    expect(framesBuilt()).toBe(1);
    expect(document.querySelector("iframe")).toBeNull();
    expect(previewRegion().getByRole("status").textContent).toBe("正在加载预览…");

    second.resolve(issued(NEXT_BASE));
    expect((await shownFrame("index.html")).getAttribute("src")).toBe(
      `${NEXT_BASE}site/index.html`,
    );
    expect(framesBuilt()).toBe(2);
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE, ISSUE]);
  });
});
