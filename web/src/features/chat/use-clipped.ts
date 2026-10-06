// 「内容被限高裁掉」的测量（design D3）：滚动容器的内容高度超过可见高度时为 true。提问卡的 `title`
// 正文、任务清单的列表与项目配置对话框的滚动容器共用：被裁剪时它们带 `tabindex="0"`，可由键盘聚焦滚动。
import { useLayoutEffect, useState } from "react";

/**
 * `ref` 指向的元素是否被裁剪（`scrollHeight > clientHeight`）。挂载时量一次，`triggers` 里任何一项
 * 变了就重量并把观察器挂到当前元素上（元素可以随触发量出现或换掉），`ResizeObserver` 可用时随元素
 * 尺寸变化重量。元素不在时不量，保留上一次的结果。
 */
export function useClipped(
  ref: { readonly current: HTMLElement | null },
  triggers: readonly unknown[],
): boolean {
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(
    () => {
      const el = ref.current;
      if (!el) return;
      const measure = () => setClipped(el.scrollHeight > el.clientHeight);
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const resize = new ResizeObserver(measure);
      resize.observe(el);
      return () => resize.disconnect();
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: 触发量由调用方给出；ref 对象本身不换。
    triggers,
  );
  return clipped;
}
