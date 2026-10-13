/**
 * 搭台：覆盖层挂载的那一刻 Radix 还没把 Escape 的分派交给它（ADR-0013 增补「Escape 实测」）。
 *
 * 真实浏览器里的现象（实测，Chromium）：键盘聚焦顶栏按钮（它的 tooltip 随即出现）后按 Enter 打开覆盖层，
 * tooltip 转入退出动画、仍在 Radix 的层栈里；Radix 只在「最高层」上监听 Escape，而新挂载的覆盖层要等一次
 * 异步重渲染才被认作最高层——这之前到达的 Escape 分派给了 tooltip 那一层，覆盖层收不到，只有
 * `useEscapeFallback` 关得掉它。那个窗口只有几毫秒，jsdom 里靠时间碰不上，所以由下面两样把它钉住。
 */
import { vi } from "vitest";

const TOOLTIP = '[data-slot="tooltip-content"]';

/**
 * 让关闭中的 tooltip 留在页面上。真实样式表给它退出动画；jsdom 不加载样式表，计算样式里没有动画名，Radix
 * 的 Presence 会立刻卸载它。这里按 `data-state` 给出动画名；由调用方的 `vi.restoreAllMocks()` 还原。
 */
export function keepTooltipExitAnimation(): void {
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const styles = computed(element, pseudo);
    if (!element.matches(TOOLTIP)) return styles;
    return new Proxy(styles, {
      get: (target, key) =>
        key === "animationName"
          ? element.getAttribute("data-state") === "closed"
            ? "exit"
            : "enter"
          : Reflect.get(target, key, target),
    });
  });
}

/** 页面上每个 tooltip 的 `data-state`（`closed` 即关闭中、尚未卸载）。 */
export function tooltipStates(): (string | null)[] {
  return Array.from(document.querySelectorAll(TOOLTIP), (node) => node.getAttribute("data-state"));
}

/**
 * 执行 `open`（同步打开覆盖层的那次点击）；焦点第一次进入 `role="dialog"` 的元素时，就在那个任务里向焦点
 * 所在元素派发一次 Escape。返回派发次数、当时各 tooltip 的状态，以及 Radix 是否已经吃掉这次按键。
 */
export function escapeOnFocusEntry(open: () => void) {
  const seen = { fired: 0, prevented: false, tooltips: [] as (string | null)[] };
  const fire = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest('[role="dialog"]')) return;
    document.removeEventListener("focusin", fire, true);
    seen.fired += 1;
    seen.tooltips = tooltipStates();
    const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    target.dispatchEvent(key);
    seen.prevented = key.defaultPrevented;
  };
  document.addEventListener("focusin", fire, true);
  try {
    open();
  } finally {
    document.removeEventListener("focusin", fire, true);
  }
  return seen;
}
