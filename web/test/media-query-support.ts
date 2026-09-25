import { vi } from "vitest";

type MediaChangeListener = (event: { matches: boolean }) => void;

export type FakeMediaQuery = {
  addEventListener: ReturnType<typeof vi.fn>;
  emit(matches: boolean): void;
  removeEventListener: ReturnType<typeof vi.fn>;
  matches: boolean;
};

export function createMediaQuery(initialMatches: boolean): FakeMediaQuery {
  const listeners = new Set<MediaChangeListener>();
  return {
    addEventListener: vi.fn((type: string, listener: MediaChangeListener) => {
      if (type === "change") {
        listeners.add(listener);
      }
    }),
    emit(matches: boolean) {
      this.matches = matches;
      for (const listener of listeners) {
        listener({ matches });
      }
    },
    removeEventListener: vi.fn((type: string, listener: MediaChangeListener) => {
      if (type === "change") {
        listeners.delete(listener);
      }
    }),
    matches: initialMatches,
  };
}

/** 安装 `window.matchMedia`：按 query 字符串交给 `resolve` 分派（主题与外壳断点各自查询）。 */
export function installMatchMedia(resolve: (query: string) => FakeMediaQuery) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(resolve),
    writable: true,
  });
}

/** 还原为 jsdom 默认的无 `matchMedia`（`delete` 在 strict TS 下不可用）。 */
export function uninstallMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: undefined,
    writable: true,
  });
}
