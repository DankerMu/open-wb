// file-previewers「预览头、下载与不可预览的呈现」的场景「没有元数据的行」与「PDF 与办公文档」的场景
// 「大小未知的文档」（#1372）：`PreviewPane` 不给 `size` / `mtime`——会话页侧边栏过滤视图里父目录没
// 加载过的行就是这样。接缝是 `PreviewPane` 本身；预览器是懒加载的，正文与 iframe 一律 `findBy…` 取到
// 再断言。期望值是规格里的字面量。
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewPane } from "../src/features/files/preview.js";
import { BASE, PREVIEW_HOST, TOKEN } from "./files-site-fixture.js";

afterEach(cleanup);

type Props = ComponentProps<typeof PreviewPane>;

const READY = {
  status: "ready",
  base: BASE,
  officeBase: `https://${PREVIEW_HOST}/o/${TOKEN}/`,
  documentMaxBytes: 104_857_600,
  officeAvailable: true,
} satisfies Props["previewToken"];

/** 不给 `size` 与 `mtime` 的预览面板；`meta` 给了才带上。 */
function pane(path: string, preview: Props["preview"], meta: Partial<Props> = {}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return render(
    <PreviewPane
      name={name}
      path={path}
      preview={preview}
      previewToken={READY}
      workspaceId="w1"
      {...meta}
    />,
  );
}

function header() {
  const element = document.querySelector<HTMLElement>('[data-slot="preview-header"]');
  if (!element) throw new Error("预览头不在页面上");
  return element;
}

/** 预览头只有图标、路径与下载链接；页面上没有拼坏的大小或时间。 */
function expectBareHeader(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  expect(header().querySelector("svg")).not.toBeNull();
  expect(header().querySelector('[data-slot="preview-path"]')?.textContent).toBe(path);
  const link = within(header()).getByRole("link", { name: `下载 ${name}` });
  expect(link.getAttribute("href")).toBe(
    `/api/workspaces/w1/download?path=${encodeURIComponent(path)}`,
  );
  expect(link.hasAttribute("download")).toBe(true);
  expect(header().querySelector('[data-slot="preview-meta"]')).toBeNull();
  // 头部的文字恰为路径：没有大小、没有时间、没有占位符。
  expect(header().textContent).toBe(path);
  for (const broken of ["NaN", "undefined", "1970"]) {
    expect(document.body.textContent).not.toContain(broken);
  }
}

describe("没有元数据的行", () => {
  it("deep/x.md 没有大小与修改时间：预览头只有图标、路径与下载链接，正文照常，页面上没有 NaN / undefined / 1970", async () => {
    pane("deep/x.md", {
      status: "success",
      data: { kind: "text", text: "深处的正文", size: 15, truncated: false },
    });

    expect(await screen.findByText("深处的正文", { exact: true })).toBeTruthy();
    expectBareHeader("deep/x.md");
  });

  it("deep/blob.bin 答 415：显示 该类型不支持预览，副行恰为文件名；413 的副行同样恰为文件名", () => {
    pane("deep/blob.bin", { status: "unsupported" });

    expect(screen.getByText("该类型不支持预览", { exact: true })).toBeTruthy();
    expect(screen.getByText("blob.bin", { exact: true })).toBeTruthy();
    expectBareHeader("deep/blob.bin");
    cleanup();

    pane("deep/huge.png", { status: "too-large" });

    expect(screen.getByText("文件过大，无法预览", { exact: true })).toBeTruthy();
    expect(screen.getByText("huge.png", { exact: true })).toBeTruthy();
    expectBareHeader("deep/huge.png");
  });

  it("对照：给了大小与修改时间时预览头照常带那一段，415 的副行带大小", () => {
    pane("deep/blob.bin", { status: "unsupported" }, { mtime: 1_726_000_000_000, size: 2048 });

    expect(header().querySelector('[data-slot="preview-meta"]')?.textContent).toMatch(
      /^2\.0 KB · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
    expect(screen.getByText("blob.bin · 2.0 KB", { exact: true })).toBeTruthy();
  });
});

describe("大小未知的文档", () => {
  it("没有大小的 deep/doc.pdf：照常建 iframe，src 为 base 加 deep/doc.pdf，没有 文件过大，无法预览，预览头有下载链接", async () => {
    pane("deep/doc.pdf", { status: "document", reload: 0 });

    const frame = await screen.findByTitle("doc.pdf");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(`${BASE}deep/doc.pdf`);
    expect(screen.queryByText("文件过大，无法预览")).toBeNull();
    expectBareHeader("deep/doc.pdf");
  });

  it("对照：给了超过上限的大小时仍不建 iframe，副行带大小", async () => {
    pane("deep/doc.pdf", { status: "document", reload: 0 }, { mtime: 1, size: 157_286_400 });

    expect(await screen.findByText("文件过大，无法预览", { exact: true })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("doc.pdf · 150.0 MB", { exact: true })).toBeTruthy();
  });

  it("没有大小的办公文档在转换未启用时：副行恰为文件名", async () => {
    pane(
      "deep/plan.docx",
      { status: "document", reload: 0 },
      {
        previewToken: { ...READY, officeAvailable: false },
      },
    );

    expect(
      await screen.findByText("服务器未启用文档转换，请下载后查看", { exact: true }),
    ).toBeTruthy();
    expect(screen.getByText("plan.docx", { exact: true })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });
});
