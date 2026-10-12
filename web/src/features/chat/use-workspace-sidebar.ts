import { useState } from "react";
import { useRequestMainWidth } from "../../lib/shell-nav.js";
import { WORKSPACE_ACTION_LABEL } from "./topbar-actions.js";

const STORAGE_KEY = "workbuddy-workspace-sidebar";

/** 没有存过宽度时侧边栏占主区宽度的百分比。 */
const DEFAULT_SHARE = 40;

const DECIMAL = /^\d+(?:\.\d+)?$/;

/** 两栏各自的最小宽度（像素）：拖动与存储里的占比都收不到它以下。 */
export const MIN_WIDTH = { conversation: 320, sidebar: 240 } as const;

/** 并排时主区至少要有的宽度：两个最小宽度加一条分隔线（拷入层 resizable 的 `w-px`）。 */
const BESIDE_WIDTH = MIN_WIDTH.conversation + MIN_WIDTH.sidebar + 1;

/**
 * 存储里的占比：读取抛错、不是十进制数或不在 0 与 100 之间（不含两端）都回缺省。两栏各自的最小
 * 宽度（`MIN_WIDTH`）由分栏按像素另行约束（workspace-sidebar.tsx），这里不管。
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
 * - `slot` 填进顶栏的 `workspace` 槽位：点击在开合之间切换。从关到开的那一下先向外壳请求放得下
 *   两栏的主区宽度（放不下且外壳侧栏展开时外壳把它折叠，窄屏与已折叠时外壳不做任何事）。只在这一下
 *   请求：关闭、换会话、意图恢复、窗口缩窄都不请求，关闭也不恢复外壳侧栏。请求写在点击回调里而不是
 *   「并排侧边栏出现」的 effect 里——意图恢复时用户点的是外壳侧栏里的会话条目，折叠会卸掉它脚下的
 *   列表；也不放进 state updater（StrictMode 下双调）。
 * - `restoreFocus` 在调用时到顶栏里找那个按钮，不记节点：换到未绑定会话再回来后按钮是新节点（槽位
 *   卸载又重建），记下的那个已不在文档里。按钮在外壳的顶栏里渲染，这里按 DOM 取而不传 ref。
 * - `share` 在挂载时读一次存储；`resize` 更新它并写回，写入抛错时只留在内存里。
 */
export function useWorkspaceSidebar(workspaceId: string | null | undefined) {
  const [wanted, setWanted] = useState(false);
  const [share, setShare] = useState(storedShare);
  const requestMainWidth = useRequestMainWidth();
  const bound = workspaceId !== null && workspaceId !== undefined;
  return {
    open: wanted && bound,
    share,
    slot: bound
      ? {
          expanded: wanted,
          onSelect() {
            if (!wanted) requestMainWidth(BESIDE_WIDTH);
            setWanted(!wanted);
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
