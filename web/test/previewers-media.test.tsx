import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaPreviewer } from "../src/features/files/previewers/media.js";
import { fileUrl } from "../src/lib/api.js";
import { ToastProvider } from "../src/ui/index.js";

/*
 * file-previewers「音视频」的模块级部分：元素、属性、地址原样落到 `src`、`error` 之后的呈现。
 * 「没有经 fetchPreview 的请求」与「下载链接仍在」在这里是空话（模块拿不到 client，预览头不在模块里），
 * 钉在 files-preview-states.test.tsx 的页面级用例里。
 * 媒体元素没有 ARIA role，一律用 `container.querySelector` 取。
 */

afterEach(cleanup);

const SRC = "/api/workspaces/w1/file?path=uploads%2Fa";

function renderMedia(name: string, content = SRC) {
  return render(<MediaPreviewer content={content} name={name} />).container;
}

function attributes(element: Element | null) {
  return {
    controls: element?.hasAttribute("controls"),
    preload: element?.getAttribute("preload"),
    autoplay: element?.hasAttribute("autoplay"),
    src: element?.getAttribute("src"),
  };
}

describe("音视频预览器：播放器与地址", () => {
  it.each([["voice.mp3"], ["a.WAV"]])(
    "%s 是恰一个 audio、没有 video，带 controls、preload 为 metadata、没有 autoplay",
    (name) => {
      const container = renderMedia(name);

      expect(container.querySelectorAll("audio")).toHaveLength(1);
      expect(container.querySelectorAll("video")).toHaveLength(0);
      expect(attributes(container.querySelector("audio"))).toStrictEqual({
        controls: true,
        preload: "metadata",
        autoplay: false,
        src: SRC,
      });
    },
  );

  it.each([["clip.mp4"], ["f.webm"]])(
    "%s 是恰一个 video、没有 audio，带 controls、preload 为 metadata、没有 autoplay",
    (name) => {
      const container = renderMedia(name);

      expect(container.querySelectorAll("video")).toHaveLength(1);
      expect(container.querySelectorAll("audio")).toHaveLength(0);
      expect(attributes(container.querySelector("video"))).toStrictEqual({
        controls: true,
        preload: "metadata",
        autoplay: false,
        src: SRC,
      });
    },
  );

  // 期望值是写死的字面量，不在测试里再编码一次。
  it.each([
    [
      "空间 id 与路径里的空格、中文、点点、井号与首尾空格",
      "clip.mp4",
      fileUrl("w 1", " 报告/../a b#é.mp4 "),
      "/api/workspaces/w%201/file?path=%20%E6%8A%A5%E5%91%8A%2F..%2Fa%20b%23%C3%A9.mp4%20",
    ],
    [
      "以斜杠开头的路径",
      "a.mp3",
      fileUrl("w1", "/etc/a.mp3"),
      "/api/workspaces/w1/file?path=%2Fetc%2Fa.mp3",
    ],
    [
      "分解形式的 é（e 加组合重音符）不被归一成合成形式",
      "café.webm",
      fileUrl("w1", "café.webm"),
      "/api/workspaces/w1/file?path=cafe%CC%81.webm",
    ],
  ])("src 与传入的地址逐字相等：%s", (_label, name, content, expected) => {
    const element = renderMedia(name, content).querySelector("audio, video");

    expect(content).toBe(expected);
    expect(element?.getAttribute("src")).toBe(expected);
  });
});

describe("音视频预览器：播放失败", () => {
  it.each([
    ["clip.mp4", "video"],
    ["voice.mp3", "audio"],
  ])(
    "%s 的 %s 触发 error 后只剩「无法播放该文件」，元素被移除，没有 Toast 也没有 alert",
    (name, tag) => {
      // 挂在 ToastProvider 之下：通知区在场，「没有 Toast」才不是空话。
      const { container } = render(
        <ToastProvider>
          <MediaPreviewer content={SRC} name={name} />
        </ToastProvider>,
      );
      const toasts = screen.getByRole("region", { name: "通知" });
      const element = container.querySelector(tag);
      expect(element).not.toBeNull();
      expect(screen.queryByText("无法播放该文件")).toBeNull();

      fireEvent.error(element as Element);

      expect(screen.getByText("无法播放该文件", { exact: true })).toBeTruthy();
      expect(container.querySelector("audio, video")).toBeNull();
      expect(within(toasts).queryByRole("listitem")).toBeNull();
      expect(document.querySelector(".ui-toast")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("失败之后换一个文件（新的 key 重挂）播放器恢复，文案消失", () => {
    const view = render(<MediaPreviewer content={`${SRC}1`} key="a/bad.mp4" name="bad.mp4" />);
    fireEvent.error(view.container.querySelector("video") as Element);
    expect(view.container.querySelector("video")).toBeNull();

    view.rerender(<MediaPreviewer content={`${SRC}2`} key="a/voice.mp3" name="voice.mp3" />);

    expect(screen.queryByText("无法播放该文件")).toBeNull();
    expect(view.container.querySelector("audio")?.getAttribute("src")).toBe(`${SRC}2`);
    expect(view.container.querySelector("video")).toBeNull();
  });
});
