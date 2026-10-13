/**
 * Issue #1257: the code points refused in a prompt attachment path and in an uploaded file name
 * (message-attachments「prompt 携带附件」condition 1, workspaces「文件上传」step 5). The list is the
 * specification's, and so is what it leaves out: every neighbour of a listed code point or range
 * that is not itself listed passes.
 */
import { describe, expect, it } from "vitest";
import { hasRefusedCharacter } from "../src/core/refused-characters.js";

const REFUSED = [
  ...Array.from({ length: 0x20 }, (_, codePoint) => codePoint),
  0x007f,
  0x0085,
  0x2028,
  0x2029,
  0x061c,
  0x200e,
  0x200f,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
];
const NEIGHBOURS = [
  0x0020, 0x007e, 0x0080, 0x0084, 0x0086, 0x061b, 0x061d, 0x200d, 0x2010, 0x2027, 0x202f, 0x2065,
  0x206a,
];

describe("hasRefusedCharacter (#1257)", () => {
  it("refuses each of the 48 listed code points wherever it stands", () => {
    expect(REFUSED).toHaveLength(48);
    for (const codePoint of REFUSED) {
      const char = String.fromCodePoint(codePoint);
      const label = `U+${codePoint.toString(16)}`;
      expect(hasRefusedCharacter(char), label).toBe(true);
      expect(hasRefusedCharacter(`a${char}`), label).toBe(true);
      expect(hasRefusedCharacter(`${char}a`), label).toBe(true);
      expect(hasRefusedCharacter(`报${char}😀`), label).toBe(true);
    }
  });

  it("lets every unlisted neighbour of a listed code point through", () => {
    for (const codePoint of NEIGHBOURS) {
      expect(
        hasRefusedCharacter(`a${String.fromCodePoint(codePoint)}b`),
        codePoint.toString(16),
      ).toBe(false);
    }
  });

  it("lets ordinary text through, the empty string included", () => {
    for (const text of ["", "uploads/a.pdf", "报告 v2.pdf", "a😀", "\ud800", "é\u0301", "\ufeff"]) {
      expect(hasRefusedCharacter(text), JSON.stringify(text)).toBe(false);
    }
  });
});
