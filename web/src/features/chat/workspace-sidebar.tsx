/* 工作空间侧边栏的外壳（workspace-sidebar「顶栏入口与可用性」「布局与开合」）：会话页自己的一块，主体是文件页的 `WorkspaceBrowser`。宽屏下与对话区并排，中间是拷入层 resizable 的分隔线；视口不超过外壳的窄屏断点时改为拷入层 sheet 的全屏模态层。 */
import { type ReactNode, type Ref, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { ApiClient } from "../../lib/api.js";
import { SHELL_NARROW_QUERY, useMediaQuery } from "../../lib/viewport.js";
import { Icon, useEscapeFallback } from "../../ui/index.js";
import { useAuth } from "../auth/index.js";
import { logicalPath, WorkspaceBrowser } from "../files/index.js";
import type { useWorkspaceSidebar } from "./use-workspace-sidebar.js";
import type { Workspace } from "./workspace-list.js";

const NAME = "工作空间侧边栏";
const CONVERSATION = "conversation";
const SIDEBAR = "workspace";
const COLUMN = "flex min-h-0 min-w-0 flex-col";
/** 两栏各自的最小宽度（像素）：拖动与存储里的占比都收不到它以下。 */
const MIN_WIDTH = { conversation: 320, sidebar: 240 } as const;

type SidebarTarget = {
  client: ApiClient;
  sessionId: string;
  /** 列表里的那一项；不在已读取的列表里（临时空间、列表读取中或失败）时为 `undefined`。 */
  workspace: Workspace | undefined;
  workspaceId: string;
};

/**
 * 头部与浏览器。当前文件只在这里的内存里（不进会话页的地址），调用方按「会话 + 空间」给 `key`，
 * 所以换会话时它与目录树、预览一起重置。空间不在列表里时标题是 `工作空间`，没有逻辑路径，也没有
 * `在文件页打开`。`刷新` 是浏览器树栏自带的那一个，头部不另放。
 */
function SidebarContent({
  client,
  closeRef,
  onClose,
  workspace,
  workspaceId,
}: SidebarTarget & { closeRef?: Ref<HTMLButtonElement>; onClose(): void }) {
  const account = useAuth().principal?.account;
  const [path, setPath] = useState<string | null>(null);
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
        name={workspace?.name}
        onPathChange={setPath}
        path={path}
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
 *   交给 `sidebar.resize`。两栏各有像素最小宽度，拖不到它以下；主区窄到两者之和都放不下时分隔线
 *   拖不动。头部 `关闭` 之后焦点回到打开它的按钮。
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
