import { useCallback, useSyncExternalStore } from "react";

/** 外壳唯一断点：窄屏时侧栏改由顶栏 `打开导航` 打开的覆盖层承载。 */
export const SHELL_NARROW_QUERY = "(max-width: 760px)";

function queryList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(query);
  } catch {
    return null;
  }
}

/** 订阅媒体查询；无 matchMedia（jsdom/SSR）或抛错时恒为 false（宽屏）。 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = queryList(query);
      if (!list) return () => {};
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const read = useCallback(() => queryList(query)?.matches ?? false, [query]);
  return useSyncExternalStore(subscribe, read, () => false);
}
