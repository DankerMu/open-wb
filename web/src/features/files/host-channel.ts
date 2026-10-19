/**
 * `WorkspaceBrowser` 与宿主之间 `path` / `onPathChange` 之外的两条通道（files-web「工作空间浏览器组件」，
 * issue 1380）。会话页侧边栏两条都用；文件页都不给——它的地址只由用户的选中改写（「地址定位到文件」），
 * 定位落空时地址保持原样。`usePathEcho` 是 `path` / `onPathChange` 本身的回声记账（issue 1542），与宿主
 * 无关，两个宿主都经过它。
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

/**
 * 浏览器经 `onPathChange` 的上报与宿主把它原样写回 `path`（回声）之间有一个窗口；回声晚于下一次上报
 * 到达时，它是一次已被取代的上报，不是宿主的新要求（files-web「浏览器不执行被取代的自身上报回声」）。
 * `report` 先按次序记下还没见回声的上报、再调 `onPathChange`；浏览器所有上报都经它。`takePath` 由 `path`
 * effect 每次调用，把 `path` 记为已套用（`applied`），返回它要不要按既有规则套用：与已套用的相同不要；
 * 之前的 `applied` 为 `undefined`（挂载、重挂、`pathSeq` 重新套用）一律要，并清空记账。否则取记账里与
 * `path` 相等的**首个**上报（回声按上报次序到达，可被宿主合并跳过，不会倒序；同值重复时取首个，后面那个
 * 若其实已被合并跳过，选中本就是它）：其后还有上报即为被取代的回声，丢掉它与它之前的，不要；其余（只等于
 * 最近一次上报，或浏览器没报过）清空记账，要。
 */
export function usePathEcho(
  applied: RefObject<string | null | undefined>,
  onPathChange: (path: string | null) => void,
) {
  const pending = useRef<(string | null)[]>([]);
  const report = useCallback(
    (path: string | null) => {
      pending.current.push(path);
      onPathChange(path);
    },
    [onPathChange],
  );
  const takePath = useCallback(
    (path: string | null) => {
      if (applied.current === path) return false;
      const reports = pending.current;
      const index = applied.current === undefined ? -1 : reports.indexOf(path);
      applied.current = path;
      if (index >= 0 && index < reports.length - 1) {
        reports.splice(0, index + 1);
        return false;
      }
      pending.current = [];
      return true;
    },
    [applied],
  );
  return { report, takePath };
}
