// file-previewers「类别判定与预览器选择」的「判定表」场景：十九个名字逐个对 `previewKind` 与 `textView`。
// 期望值抄自规格的场景文本，不从 `kind.ts` 的表推出。两侧扩展名集合的相等另见 `preview-kind-contract.test.ts`。
import { describe, expect, it } from "vitest";
import { previewKind, textView } from "../src/features/files/previewers/kind.js";

const BY_KIND = [
  ["a.PNG", "image"],
  ["b.webp", "image"],
  ["c.pdf", "pdf"],
  ["d.DOCX", "office"],
  ["e.mp3", "audio"],
  ["f.webm", "video"],
  ["g.ipynb", "notebook"],
  ["h.zip", "archive"],
  ["i.tar.gz", "archive"],
  ["j.tgz", "archive"],
  ["k.gz", "archive"],
] as const;

// 其余八个都是 `text`，再由 `textView` 细分。
const BY_TEXT_VIEW = [
  ["readme.md", "markdown"],
  ["t.tsv", "table"],
  ["p.htm", "web"],
  ["logo.svg", "svg"],
  ["main.py", "code"],
  ["LICENSE", "code"],
  [".env", "code"],
  ["x.unknown", "code"],
] as const;

describe("预览类别判定表", () => {
  it.each(BY_KIND)("%s 的类别是 %s", (name, kind) => {
    expect(previewKind(name)).toBe(kind);
  });

  it.each(BY_TEXT_VIEW)("%s 是文本类，呈现为 %s", (name, view) => {
    expect(previewKind(name)).toBe("text");
    expect(textView(name)).toBe(view);
  });

  it("判定表恰有十九个名字", () => {
    expect(new Set([...BY_KIND, ...BY_TEXT_VIEW].map(([name]) => name)).size).toBe(19);
  });
});
