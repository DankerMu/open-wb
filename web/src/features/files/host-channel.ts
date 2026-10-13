/**
 * `WorkspaceBrowser` 与宿主之间 `path` / `onPathChange` 之外的两条通道（files-web「工作空间浏览器组件」，
 * issue 1380）。会话页侧边栏两条都用；文件页都不给——它的地址只由用户的选中改写（「地址定位到文件」），
 * 定位落空时地址保持原样。
 */
import { type RefObject, useCallback, useEffect, useRef } from "react";

/**
 * 上报树里实际选中的文件。返回的函数由浏览器在每次写选中的地方调用（`publishSelectedFile`）：路径（没有
 * 选中时为 `null`）与上一次报的不同才调 `report`，所以实际选中每变化一次恰报一次，不管它是怎么变的
 * （点击、定位落地或落空、404 清除、改名跟随、删除），同一个文件换预览不报。它在写选中的那一处同步
 * 调用，不等 effect。挂载本身不报——那时没有选中，也没有变化。
 */
export function useSelectionReport(report: ((path: string | null) => void) | undefined) {
  const reported = useRef<string | null>(null);
  return useCallback(
    (selectedFile: { path: string } | null) => {
      const selected = selectedFile?.path ?? null;
      if (reported.current === selected) return;
      reported.current = selected;
      report?.(selected);
    },
    [report],
  );
}

/**
 * 「重新套用 `path`」的触发：`seq` 换成新值（非 `undefined`）时把 `applied`——浏览器记下的「已套用的
 * `path`」——作废，于是它的 `path` effect 在同一次提交里把 `path` 当作新值再走一遍，值没变也一样。挂载时
 * 的那一次没有效果：那时还什么都没套用过。调用方须把这个 hook 写在那个 effect 之前（同一次提交里 effect
 * 按声明次序跑），并把 `seq` 列进那个 effect 的依赖。
 */
export function usePathReapply(
  applied: RefObject<string | null | undefined>,
  seq: number | undefined,
) {
  useEffect(() => {
    if (seq !== undefined) applied.current = undefined;
  }, [applied, seq]);
}
