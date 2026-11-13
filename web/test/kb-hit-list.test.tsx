// 共享命中列表（change s2c-kb-session 组 6 第二刀，#1969）：中心「检索测试」与会话「知识库检索」卡共用的一份
// 命中呈现。seam：组件 `KbHitList`；期望值取自规格字面量——相似度保留两位小数（knowledge-bases「检索测试」、
// chat-web「会话知识库检索卡」），切片原文按纯文本呈现，`#n` 徽标只在 `numbered` 时出现。
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KbHitList } from "../src/components/kb-hit-list.js";

const HITS = [
  { name: "spec.md", similarity: 0.5, content: "第一行\n第二行" },
  { name: "spec.md", similarity: 1, content: "<b>x</b>" },
];

afterEach(() => {
  cleanup();
});

function items() {
  return within(screen.getByRole("list")).getAllByRole("listitem");
}

describe("KbHitList", () => {
  it("numbered：每条带 #n 徽标、文档名与两位小数的相似度，次序同输入（同一文档两条各占一行）", () => {
    render(<KbHitList hits={HITS} numbered />);

    expect(items().map((item) => item.textContent)).toEqual([
      "#1spec.md相似度 0.50第一行\n第二行",
      "#2spec.md相似度 1.00<b>x</b>",
    ]);
  });

  it("不 numbered：没有 #n 徽标，其余相同", () => {
    render(<KbHitList hits={HITS} numbered={false} />);

    expect(items().map((item) => item.textContent)).toEqual([
      "spec.md相似度 0.50第一行\n第二行",
      "spec.md相似度 1.00<b>x</b>",
    ]);
    expect(screen.queryByText(/^#\d/u)).toBeNull();
  });

  it("切片原文是保留换行的纯文本：<b>x</b> 原样为文本，不生成元素", () => {
    render(<KbHitList hits={HITS} numbered={false} />);

    const raw = screen.getByText("<b>x</b>");
    expect(raw.className).toContain("whitespace-pre-wrap");
    expect(raw.querySelector("b")).toBeNull();
    expect(screen.getByRole("list").querySelector("b")).toBeNull();
  });
});
