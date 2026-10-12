/* 工作空间侧边栏的外壳（workspace-sidebar「顶栏入口与可用性」「布局与开合」）：会话页自己的一块，主体是文件页的 `WorkspaceBrowser`。宽屏下与对话区并排，中间是拷入层 resizable 的分隔线；视口不超过外壳的窄屏断点时改为拷入层 sheet 的全屏模态层。 */
import { type ReactNode, type Ref, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { ApiClient } from "../../lib/api.js";
import { SHELL_NARROW_QUERY, useMediaQuery } from "../../lib/viewport.js";
import { Icon, useEscapeFallback } from "../../ui/index.js";
import { useAuth } from "../auth/index.js";
import { logicalPath, WorkspaceBrowser, type WorkspaceBrowserHandle } from "../files/index.js";
import type { ChatState } from "./stream.js";
import {
  MIN_WIDTH,
  sessionChangedPaths,
  useAssistantRefresh,
  type useWorkspaceSidebar,
} from "./use-workspace-sidebar.js";
import type { Workspace } from "./workspace-list.js";

const NAME = "工作空间侧边栏";
const ONLY_CHANGES = "只看本会话改动";
const CONVERSATION = "conversation";
const SIDEBAR = "workspace";
const COLUMN = "flex min-h-0 min-w-0 flex-col";

type SidebarTarget = {
  client: ApiClient;
  sessionId: string;
  /** 这个会话已就绪的视图（改动集合的来源）；未就绪时为 `null`，改动集合即空集。 */
  view: ChatState | null;
  /** 列表里的那一项；不在已读取的列表里（临时空间、列表读取中或失败）时为 `undefined`。 */
  workspace: Workspace | undefined;
  workspaceId: string;
};

/**
 * 头部与浏览器。当前文件只在这里的内存里（不进会话页的地址），调用方按「会话 + 空间」给 `key`，
 * 所以换会话时它与目录树、预览一起重置。空间不在列表里时标题是 `工作空间`，没有逻辑路径，也没有
 * `在文件页打开`。`刷新` 是浏览器树栏自带的那一个，头部不另放。
 *
 * - 本会话改动（workspace-sidebar「本会话改动标记与过滤」）：`view` 的改动集合作为 `markedPaths` 交给
 *   浏览器，父目录的标记由它补。`只看本会话改动` 打开时同一个集合另作 `onlyPaths`——浏览器只用它拼
 *   树、不列目录，也不动自己的展开集合与选中，所以关掉后原样回来；打开期间浏览器把 `新建` 禁用。
 * - `只看本会话改动` 与树区的折叠都是这里的状态，初值关：与当前文件一样随 `key` 重置（规格「开关
 *   状态在切换会话时重置为关闭」）。关闭再打开侧边栏、宽窄屏互换时这个组件重挂，两者同样回到初值
 *   （读代码推出，没有测试；规格没有写这两种情况）。
 * - 折叠只给浏览器的树栏加 `hidden`，不卸载：展开状态、选中与预览都在浏览器的状态里。折叠按钮是同
 *   一个节点换名字与图标，焦点留在它上面。
 * - 随助手的改动刷新（workspace-sidebar「随助手改动刷新」）：`useAssistantRefresh` 拿 `view` 与浏览器
 *   的句柄去调它的 `refresh`。树区折叠、`只看本会话改动` 打开时照常调：前者预览仍可见；后者浏览器
 *   自己不发 `tree`、只重取预览，关掉开关后期间没重列的层不补（读代码推出，没有测试）。
 */
function SidebarContent({
  client,
  closeRef,
  onClose,
  view,
  workspace,
  workspaceId,
}: SidebarTarget & { closeRef?: Ref<HTMLButtonElement>; onClose(): void }) {
  const account = useAuth().principal?.account;
  const [path, setPath] = useState<string | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const changes = useMemo(
    () => ({ label: "本会话已改动", paths: sessionChangedPaths(view) }),
    [view],
  );
  const browser = useRef<WorkspaceBrowserHandle | null>(null);
  useAssistantRefresh(view, browser);
  const treeToggle = treeCollapsed ? "展开文件树" : "折叠文件树";
  const listed = workspace !== undefined && account !== undefined;
  return (
    <>
      <div
        className="flex shrink-0 items-center gap-1 border-b border-(--wb-border-default) py-2 pr-2 pl-3"
        data-slot="workspace-sidebar-head"
      >
        <div className="mr-auto min-w-0">
          <h2 className="m-0 truncate text-[13px] font-semibold text-(--wb-text-primary)">
            {workspace?.name ?? "工作空间"}
          </h2>
          {listed ? (
            <p className="m-0 truncate font-(family-name:--wb-mono) text-[11px] text-(--wb-text-tertiary)">
              {logicalPath(account, workspace.dir)}
            </p>
          ) : null}
        </div>
        {workspace ? (
          <Button asChild className="shrink-0" size="sm" variant="ghost">
            <Link
              to={`/files?${new URLSearchParams(path === null ? { ws: workspaceId } : { ws: workspaceId, path })}`}
            >
              在文件页打开
            </Link>
          </Button>
        ) : null}
        <Button
          aria-label={ONLY_CHANGES}
          aria-pressed={onlyChanges}
          className="shrink-0"
          onClick={() => setOnlyChanges(!onlyChanges)}
          size="icon-sm"
          title={ONLY_CHANGES}
          type="button"
          variant={onlyChanges ? "secondary" : "ghost"}
        >
          <Icon name="filter" size={14} />
        </Button>
        <Button
          aria-label={treeToggle}
          className="shrink-0"
          onClick={() => setTreeCollapsed(!treeCollapsed)}
          size="icon-sm"
          title={treeToggle}
          type="button"
          variant="ghost"
        >
          <Icon name={treeCollapsed ? "chevron-down" : "chevron-up"} size={14} />
        </Button>
        <Button
          aria-label={`关闭${NAME}`}
          className="shrink-0"
          onClick={onClose}
          ref={closeRef}
          size="icon-sm"
          title={`关闭${NAME}`}
          type="button"
          variant="ghost"
        >
          <Icon name="x" size={14} />
        </Button>
      </div>
      <WorkspaceBrowser
        account={account ?? ""}
        client={client}
        dir={listed ? workspace.dir : undefined}
        layout="stacked"
        markedPaths={changes}
        name={workspace?.name}
        onlyPaths={onlyChanges ? changes.paths : undefined}
        onlyPathsEmpty="本会话暂无文件改动"
        onPathChange={setPath}
        path={path}
        ref={browser}
        treeCollapsed={treeCollapsed}
        workspaceId={workspaceId}
      />
    </>
  );
}

type WorkspaceSplitProps = {
  /** 对话区；侧边栏开合不重挂它。 */
  children: ReactNode;
  sidebar: ReturnType<typeof useWorkspaceSidebar>;
  /** `sidebar.open` 时的会话与空间；没有可显示的侧边栏时为 `null`。 */
  target: SidebarTarget | null;
};

/**
 * 会话页主区的两栏：对话区，以及 `target` 非空时的侧边栏。
 *
 * - 宽屏：`complementary` 地标与分隔线并排在对话区右侧，不是模态；拖动或方向键结束后把侧边栏的占比
 *   交给 `sidebar.resize`。两栏各有像素最小宽度（`MIN_WIDTH`），拖不到它以下。主区放不下两者之和时，
 *   用户打开的那一下由 `useWorkspaceSidebar` 请外壳折叠外壳侧栏；分栏在主区还窄的那一帧就挂上第二
 *   栏，随外壳侧栏的宽度过渡长宽后两栏各自回到最小宽度以上（实测，Chromium：`make ui-walk` 的 800
 *   一档）。不判断的那些时刻（开着缩窄窗口、用户自己展开外壳侧栏等）两栏会低于最小宽度、分隔线
 *   拖不动（实测，Chromium：1200 打开后缩到 800 为 292 / 219，方向键不动）。头部 `关闭` 之后焦点回到
 *   打开它的按钮。
 * - 窄屏：全屏模态层，没有分隔线；打开时焦点进 `关闭`，Escape 与 `关闭` 关闭后焦点同样归还。屏上有
 *   Toast 时 Radix 收不到 Escape，由 `useEscapeFallback` 兜底。
 * - 拷入层的分栏在挂载时无条件 `new ResizeObserver`；没有它的运行环境退回普通的横向 flex，没有分隔线。
 */
export function WorkspaceSplit({ children, sidebar, target }: WorkspaceSplitProps) {
  const narrow = useMediaQuery(SHELL_NARROW_QUERY);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onOpenChange = (open: boolean) => {
    if (!open) sidebar.close();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });
  const key = target ? `${target.sessionId}:${target.workspaceId}` : "";
  const beside =
    target !== null && !narrow ? (
      <aside
        aria-label={NAME}
        className={`${COLUMN} h-full border-l border-(--wb-border-default) bg-(--wb-bg-primary)`}
      >
        <SidebarContent
          {...target}
          key={key}
          onClose={() => {
            sidebar.close();
            sidebar.restoreFocus();
          }}
        />
      </aside>
    ) : null;
  return (
    <>
      {typeof ResizeObserver === "undefined" ? (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className={`${COLUMN} flex-1`}>{children}</div>
          {beside ? (
            <div
              className="flex-none"
              style={{
                maxWidth: `calc(100% - ${MIN_WIDTH.conversation}px)`,
                minWidth: MIN_WIDTH.sidebar,
                width: `${sidebar.share}%`,
              }}
            >
              {beside}
            </div>
          ) : null}
        </div>
      ) : (
        <ResizablePanelGroup
          className="min-h-0 flex-1"
          onLayoutChanged={(layout, meta) => {
            const share = layout[SIDEBAR];
            if (meta.isUserInteraction && share !== undefined) sidebar.resize(share);
          }}
        >
          <ResizablePanel
            className={COLUMN}
            id={CONVERSATION}
            minSize={MIN_WIDTH.conversation}
            style={{ overflow: "hidden" }}
          >
            {children}
          </ResizablePanel>
          {beside ? (
            <>
              <ResizableHandle aria-label={`调整${NAME}宽度`} />
              <ResizablePanel
                defaultSize={`${sidebar.share}%`}
                id={SIDEBAR}
                minSize={MIN_WIDTH.sidebar}
                style={{ overflow: "hidden" }}
              >
                {beside}
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      )}
      <Sheet onOpenChange={onOpenChange} open={target !== null && narrow}>
        <SheetContent
          aria-describedby={undefined}
          aria-modal="true"
          className="gap-0 data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:border-l-0 data-[side=right]:sm:max-w-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            sidebar.restoreFocus();
          }}
          onEscapeKeyDown={fallback.onEscapeKeyDown}
          onKeyDown={fallback.onKeyDown}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeRef.current?.focus();
          }}
          ref={fallback.ref}
          showCloseButton={false}
        >
          <SheetTitle className="sr-only">{NAME}</SheetTitle>
          {target !== null && narrow ? (
            <SidebarContent {...target} closeRef={closeRef} key={key} onClose={sidebar.close} />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
