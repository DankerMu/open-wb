import { useState } from "react";
import { WORKSPACE_ACTION_LABEL } from "./topbar-actions.js";

const STORAGE_KEY = "workbuddy-workspace-sidebar";

/** 没有存过宽度时侧边栏占主区宽度的百分比。 */
const DEFAULT_SHARE = 40;

const DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * 存储里的占比：读取抛错、不是十进制数或不在 0 与 100 之间（不含两端）都回缺省。两栏各自的最小
 * 宽度由分栏按像素另行约束（workspace-sidebar.tsx），这里不管。
 */
function storedShare(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
    const share = DECIMAL.test(raw) ? Number(raw) : Number.NaN;
    return share > 0 && share < 100 ? share : DEFAULT_SHARE;
  } catch {
    return DEFAULT_SHARE;
  }
}

/**
 * 会话页的工作空间侧边栏状态（workspace-sidebar「布局与开合」）。`workspaceId` 是选中会话的空间，
 * 未绑定的会话为 `null`、欢迎态为 `undefined`。
 *
 * - 开合意图是页面内存状态，初值关、不写存储；它不随 `workspaceId` 变化，所以换到另一个绑定会话时
 *   保持，换到未绑定会话或欢迎态时 `open` 为假、`slot` 为 `undefined`，回来后恢复。
 * - `slot` 填进顶栏的 `workspace` 槽位：点击在开合之间切换。
 * - `restoreFocus` 在调用时到顶栏里找那个按钮，不记节点：换到未绑定会话再回来后按钮是新节点（槽位
 *   卸载又重建），记下的那个已不在文档里。按钮在外壳的顶栏里渲染，这里按 DOM 取而不传 ref。
 * - `share` 在挂载时读一次存储；`resize` 更新它并写回，写入抛错时只留在内存里。
 */
export function useWorkspaceSidebar(workspaceId: string | null | undefined) {
  const [wanted, setWanted] = useState(false);
  const [share, setShare] = useState(storedShare);
  const bound = workspaceId !== null && workspaceId !== undefined;
  return {
    open: wanted && bound,
    share,
    slot: bound
      ? {
          expanded: wanted,
          onSelect() {
            setWanted((current) => !current);
          },
        }
      : undefined,
    close() {
      setWanted(false);
    },
    /** 把焦点还给顶栏里的那个按钮，不滚动消息线程；顶栏里没有它时不动。 */
    restoreFocus() {
      document
        .querySelector<HTMLElement>(
          `[data-slot="topbar-actions"] button[aria-label="${WORKSPACE_ACTION_LABEL}"]`,
        )
        ?.focus({ preventScroll: true });
    },
    resize(next: number) {
      setShare(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // 存不进去（隐私模式、配额）不影响这一页的宽度。
      }
    },
  };
}
