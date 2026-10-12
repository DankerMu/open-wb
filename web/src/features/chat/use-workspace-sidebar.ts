import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useRequestMainWidth } from "../../lib/shell-nav.js";
import type { WorkspaceBrowserHandle } from "../files/index.js";
import type { ChatState } from "./stream.js";
import { summarizeChanges } from "./stream-artifacts.js";
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
 * 「本会话改动」集合（workspace-sidebar「本会话改动标记与过滤」）：视图里全部消息的已结束步骤的
 * `changes` 的路径，同一路径只算一次；running 步骤的不算（`summarizeChanges` 的规则）。视图未就绪
 * （`null`）时是空集。集合只增不因文件被删而减：`changes` 没有删除这一类。
 */
export function sessionChangedPaths(view: ChatState | null): ReadonlySet<string> {
  const steps = view?.messages.flatMap((message) => message.steps) ?? [];
  return new Set(summarizeChanges(steps).map((change) => change.path));
}

/**
 * `view` 里「已结束且 `changes` 非空」而 `seen` 里还没有的步骤所改的路径；这些步骤同时记进 `seen`
 * （键是 `消息 id:步骤 id`）。
 */
function unseenChangedPaths(view: ChatState, seen: Set<string>): string[] {
  return view.messages.flatMap((message) =>
    message.steps.flatMap((step) => {
      const key = `${message.id}:${step.id}`;
      if (step.status === "running" || !step.changes?.length || seen.has(key)) return [];
      seen.add(key);
      return step.changes.map((change) => change.path);
    }),
  );
}

/** 步骤结束的局部刷新的合并窗口（毫秒）：从窗口里第一批改动起算，后到的批次不顺延。 */
const MERGE_MS = 300;

/**
 * 侧边栏随助手的改动刷新（workspace-sidebar「随助手改动刷新」）。由 `SidebarContent` 调用，随它挂载
 * 与卸载：侧边栏关闭、换会话、宽窄屏互换都是卸载，卸载时清掉待发的定时器。不轮询。
 *
 * - 局部刷新：`view` 里出现没见过的「已结束且 `changes` 非空」的步骤时，把它的路径排进待刷集合，
 *   `MERGE_MS` 后对集合调一次 `refresh(paths)`（浏览器只重列这些路径已加载的各级父目录，当前文件在
 *   其中才重取预览）。按步骤（`消息 id:步骤 id`）判新而不按路径：同一路径被后一个步骤再改时也要刷。
 *   `changes` 为空的已结束步骤不记，`files.changed` 晚于 `step.end` 到达时仍算新。
 * - 第一个非 `null` 的 `view` 只记下已有的步骤、不刷新：首屏历史与重开侧边栏时已有的改动不是新的
 *   （挂载时浏览器自己请求一次根）。
 * - 兜底：`view.status` 由 `running` 变为别的值时丢掉待刷集合与定时器，立即 `refresh()`（全部已加载
 *   的目录与当前文件）——`bash` 等途径改的文件没有 `changes`，靠这一次。`null` 的 `view` 不参与比较。
 * - 定时器到点时才读 `browser.current`（`refresh` 的身份会变）。处理 `view` 的 effect 没有清理函数：
 *   每个 `text.delta` 都换 `view`，在那里清定时器会把窗口一直推后。
 */
export function useAssistantRefresh(
  view: ChatState | null,
  browser: RefObject<WorkspaceBrowserHandle | null>,
) {
  const seen = useRef<Set<string> | null>(null);
  const running = useRef(false);
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (view === null) return;
    const seeding = seen.current === null;
    seen.current ??= new Set();
    const fresh = unseenChangedPaths(view, seen.current);
    const ended = running.current && view.status !== "running";
    running.current = view.status === "running";
    if (seeding) return;
    if (ended) {
      clearTimeout(timer.current);
      timer.current = undefined;
      pending.current.clear();
      browser.current?.refresh();
      return;
    }
    if (fresh.length === 0) return;
    for (const path of fresh) pending.current.add(path);
    timer.current ??= setTimeout(() => {
      timer.current = undefined;
      const paths = [...pending.current];
      pending.current.clear();
      browser.current?.refresh(paths);
    }, MERGE_MS);
  }, [view, browser]);

  useEffect(() => () => clearTimeout(timer.current), []);
}

/**
 * 一次待套用的定位：`seq` 每次 `reveal` 加一，同一路径再点一次也是新的一次。`view` 只有产物卡的
 * `打开网页预览` 带：这一次还要把该网页置为渲染视图。
 */
type Located = { path: string; seq: number; sessionId: string; view?: "rendered" | undefined };

/**
 * 会话页的工作空间侧边栏状态（workspace-sidebar「布局与开合」「从卡片定位到文件」）。`workspaceId` 是
 * 选中会话的空间，未绑定的会话为 `null`、欢迎态为 `undefined`；`sessionId` 是选中会话的 id，会话还没
 * 解析出来时为 `undefined`。
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
 *   `restoreFocus(true)`（只有窄屏模态层关闭时这样调）先试 `reveal` 记下的那个卡片按钮：它还在文档里
 *   就还给它，否则回顶栏按钮。两条路都带 `preventScroll`。
 * - `reveal(path, trigger, options?)` 是文件变更卡 `查看详情` 与 html 产物卡 `打开网页预览` 的落点（后者
 *   带 `{ view: "rendered" }`，记进这一次定位），会话没有工作空间时为 `undefined`（同 `slot`）。它记下
 *   `trigger` 与一次定位（`located`），侧边栏没开就打开——这也是一次打开动作，同样先向外壳请求主区
 *   宽度；已经开着时不请求。引用稳定（只随 `sessionId` 变）：它一路传进消息的渲染函数，
 *   换引用会让每条助手消息重渲染；所以「开着没有」读的是 `wantedRef` 而不是闭包里的 `wanted`。
 * - `located` 交给侧边栏内容去套用（`SidebarContent`）。它带着发起时的会话：换会话（含换到未绑定的
 *   会话）即丢弃，不会被定位进另一个会话的树，切回来也不重新套用（规格「切换到另一个绑定了工作空间
 *   的会话时…目录树、当前文件与预览重置」）。点顶栏按钮同样丢弃，并把记下的 `trigger` 清掉：关着的
 *   侧边栏只有它和 `reveal` 能打开，所以关闭之后用它再打开没有选中的文件，那次打开的焦点也归它；
 *   `close` 自己不用清。
 * - `share` 在挂载时读一次存储；`resize` 更新它并写回，写入抛错时只留在内存里。
 */
export function useWorkspaceSidebar(workspaceId: string | null | undefined, sessionId?: string) {
  const [wanted, setWanted] = useState(false);
  const [share, setShare] = useState(storedShare);
  const [pending, setPending] = useState<Located | null>(null);
  const wantedRef = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const seq = useRef(0);
  const requestMainWidth = useRequestMainWidth();
  const bound = workspaceId !== null && workspaceId !== undefined;
  const located = pending?.sessionId === sessionId ? pending : null;
  if (pending !== null && located === null) setPending(null);
  const want = (next: boolean) => {
    wantedRef.current = next;
    setWanted(next);
  };
  const reveal = useCallback(
    (path: string, opener: HTMLElement, options?: { view: "rendered" }) => {
      if (sessionId === undefined) return;
      trigger.current = opener;
      seq.current += 1;
      setPending({ path, seq: seq.current, sessionId, view: options?.view });
      if (wantedRef.current) return;
      requestMainWidth(BESIDE_WIDTH);
      wantedRef.current = true;
      setWanted(true);
    },
    [requestMainWidth, sessionId],
  );
  return {
    open: wanted && bound,
    share,
    located,
    reveal: bound && sessionId !== undefined ? reveal : undefined,
    slot: bound
      ? {
          expanded: wanted,
          onSelect() {
            if (!wanted) requestMainWidth(BESIDE_WIDTH);
            trigger.current = null;
            setPending(null);
            want(!wanted);
          },
        }
      : undefined,
    close() {
      want(false);
    },
    /**
     * 把焦点还给打开它的控件，不滚动消息线程：`toOpener` 且 `reveal` 记下的按钮还在文档里时是那个
     * 按钮，否则是顶栏里的那个按钮；顶栏里也没有它时不动。
     */
    restoreFocus(toOpener = false) {
      const opener = toOpener && trigger.current?.isConnected ? trigger.current : null;
      const target =
        opener ??
        document.querySelector<HTMLElement>(
          `[data-slot="topbar-actions"] button[aria-label="${WORKSPACE_ACTION_LABEL}"]`,
        );
      target?.focus({ preventScroll: true });
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
