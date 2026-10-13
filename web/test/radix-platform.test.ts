import "./radix-platform.js";
import { describe, expect, it, vi } from "vitest";
import { readRepoFile } from "./ui-support.js";

// ui-primitives「手写对话框迁移不回归」：`radix-platform.ts` 只在 jsdom 缺失时补四项平台 API，
// 不覆盖已有实现、不补 `PointerEvent`。

describe("radix-platform.ts", () => {
  it("radix-platform.ts 只在缺失时定义四项 shim，且不补 PointerEvent", () => {
    const shim = readRepoFile("web/test/radix-platform.ts");
    expect(shim).toContain('!("ResizeObserver" in globalThis)');
    for (const name of [
      "hasPointerCapture",
      "setPointerCapture",
      "releasePointerCapture",
      "scrollIntoView",
    ]) {
      expect(shim).toContain(`.${name} ??= `);
      expect(shim).not.toContain(`.${name} = `);
    }
    expect(shim).not.toContain("PointerEvent");
  });

  it("radix-platform.ts 重新执行时不覆盖已有实现", async () => {
    const prototype = Element.prototype;
    const saved = {
      resizeObserver: globalThis.ResizeObserver,
      hasPointerCapture: prototype.hasPointerCapture,
      setPointerCapture: prototype.setPointerCapture,
      releasePointerCapture: prototype.releasePointerCapture,
      scrollIntoView: prototype.scrollIntoView,
    };
    class ExistingResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const existing = {
      hasPointerCapture: () => true,
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      scrollIntoView: () => {},
    };
    globalThis.ResizeObserver = ExistingResizeObserver;
    Object.assign(prototype, existing);
    try {
      vi.resetModules();
      await import("./radix-platform.js");
      expect(globalThis.ResizeObserver).toBe(ExistingResizeObserver);
      expect(prototype.hasPointerCapture).toBe(existing.hasPointerCapture);
      expect(prototype.setPointerCapture).toBe(existing.setPointerCapture);
      expect(prototype.releasePointerCapture).toBe(existing.releasePointerCapture);
      expect(prototype.scrollIntoView).toBe(existing.scrollIntoView);
    } finally {
      globalThis.ResizeObserver = saved.resizeObserver;
      Object.assign(prototype, {
        hasPointerCapture: saved.hasPointerCapture,
        setPointerCapture: saved.setPointerCapture,
        releasePointerCapture: saved.releasePointerCapture,
        scrollIntoView: saved.scrollIntoView,
      });
    }
  });
});
