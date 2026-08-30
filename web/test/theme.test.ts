import { describe, expect, it, vi } from "vitest";
import { loadTheme, normalizeTheme, type ResolvedTheme, resolveTheme } from "../src/lib/theme.js";

describe("normalizeTheme", () => {
  it("保留 light、dark 和 system", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("system")).toBe("system");
  });

  it("将未知值和 null 回退为 system", () => {
    expect(normalizeTheme("blue")).toBe("system");
    expect(normalizeTheme(null)).toBe("system");
  });
});

describe("loadTheme", () => {
  it("读取三种有效主题", () => {
    expect(loadTheme(() => "light")).toBe("light");
    expect(loadTheme(() => "dark")).toBe("dark");
    expect(loadTheme(() => "system")).toBe("system");
  });

  it("将未知值和空存储值回退为 system", () => {
    expect(loadTheme(() => "blue")).toBe("system");
    expect(loadTheme(() => null)).toBe("system");
  });

  it("未提供读取器时回退为 system", () => {
    expect(loadTheme()).toBe("system");
  });

  it("读取器抛错时回退为 system", () => {
    expect(
      loadTheme(() => {
        throw new Error("storage unavailable");
      }),
    ).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("在 system 模式下用一次深色媒体查询解析 dark", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));

    const resolvedTheme: ResolvedTheme = resolveTheme("system", matchMedia);

    expect(resolvedTheme).toBe("dark");
    expect(matchMedia).toHaveBeenCalledTimes(1);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
  });

  it("在 system 模式下用一次深色媒体查询解析 light", () => {
    const matchMedia = vi.fn(() => ({ matches: false }));

    const resolvedTheme: ResolvedTheme = resolveTheme("system", matchMedia);

    expect(resolvedTheme).toBe("light");
    expect(matchMedia).toHaveBeenCalledTimes(1);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
  });

  it("固定主题不调用媒体查询", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));

    expect(resolveTheme("light", matchMedia)).toBe("light");
    expect(resolveTheme("dark", matchMedia)).toBe("dark");
    expect(matchMedia).not.toHaveBeenCalled();
  });
});
