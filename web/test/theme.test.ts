import { describe, expect, it } from "vitest";
import { normalizeTheme } from "../src/lib/theme.js";

describe("normalizeTheme", () => {
  it("识别 dark", () => {
    expect(normalizeTheme("dark")).toBe("dark");
  });
  it("未知值与 null 回退 light", () => {
    expect(normalizeTheme("blue")).toBe("light");
    expect(normalizeTheme(null)).toBe("light");
  });
});
