/**
 * Files page frame: the tree column (switcher, heading, 刷新, 新建, directory) beside the preview,
 * stacked at the shell's narrow breakpoint; `layout="stacked"` is that narrow arrangement at every
 * width. Neither `files-layout` nor `files-preview` paints a
 * background (issue 420): the page colour comes from `body` alone.
 */
import { type ReactNode, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "../../components/icon.js";
import { EmptyState } from "./empty-state.js";

/** Error box (the former global alert rule); callers add the font size. */
export const ALERT_BOX =
  "rounded-lg bg-(--wb-status-error-soft-bg) px-2.5 py-2 text-(--wb-status-error-text)";
export const STATUS_TEXT = "shrink-0 text-[13px] text-muted-foreground";

type CreationMenuProps = {
  /** 真值时 `新建` 渲染为禁用（浏览器在 `onlyPaths` 下给：过滤视图不列目录，新建的条目无从显示）。 */
  creationDisabled?: boolean | undefined;
  /** 回调带上菜单触发器，供对话框在取消类关闭后把焦点还给它。 */
  onNewDirectory(trigger: HTMLElement | null): void;
  /** 给了才有 `挂载目录`（在 `新建文件夹` 之后）：文件页、挂载启用时（workspace-mounts「挂载对话框」）。 */
  onMountDirectory?: ((trigger: HTMLElement | null) => void) | undefined;
  /** 缺省时菜单没有 `新建工作空间` 一项。 */
  onNewWorkspace?: ((trigger: HTMLElement | null) => void) | undefined;
};

export type BrowserLayout = "columns" | "stacked";

/** 外框、树栏、树的滚动区、预览区的布局类；`stacked` 即 `columns` 在窄断点下的那一组，不带断点前缀。 */
const LAYOUT: Record<BrowserLayout, readonly [string, string, string, string]> = {
  columns: [
    "grid grid-cols-[280px_minmax(0,1fr)] overflow-hidden max-[900px]:grid-cols-[210px_minmax(0,1fr)] narrow:flex narrow:flex-col narrow:overflow-auto",
    "overflow-hidden border-r narrow:w-full narrow:flex-none narrow:border-r-0 narrow:border-b",
    "narrow:max-h-[16rem]",
    "overflow-hidden narrow:min-h-[16rem] narrow:flex-auto",
  ],
  stacked: [
    "flex flex-col overflow-auto",
    "w-full flex-none overflow-hidden border-b",
    "max-h-[16rem]",
    "min-h-[16rem] flex-auto overflow-hidden",
  ],
};

type WorkspaceColumnsProps = CreationMenuProps & {
  directory: ReactNode;
  folderNotice?: string | null;
  layout?: BrowserLayout | undefined;
  /** 缺省（没有工作空间）时 `刷新` 渲染为禁用。 */
  onRefresh?: () => void;
  preview: ReactNode;
  switcher?: ReactNode;
  /**
   * 树栏（连同 `刷新` 与 `新建`）带 `hidden` 属性收起，不卸载。实测（Chromium 151，构建产物的样式表）：
   * 带同一组类的 `aside` 加上 `hidden` 后 `display` 为 `none`、高度为 0——Tailwind preflight 的
   * `[hidden]` 规则带 `!important`，压过 `flex` 类。
   */
  treeCollapsed?: boolean | undefined;
};

/**
 * `onlyPaths` 是空集且给了文案时树的位置上的那段文案，否则 `null`（照常是树）。浏览器给的是其中还
 * 成行的那些路径：集合本来就空，或其中的文件都已不存在（issue 1372），都是这段文案。
 */
export function emptyNote(onlyPaths: ReadonlySet<string> | undefined, text: string | undefined) {
  return onlyPaths?.size === 0 && text ? (
    <p className={`${STATUS_TEXT} px-2 py-1`}>{text}</p>
  ) : null;
}

export function EmptyPreview() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState description="在左侧目录树中选择一个文件进行预览" title="未选择文件" />
    </div>
  );
}

/** `modal={false}`：菜单不锁 body 的指针事件，随后打开的对话框自己管模态。 */
function CreationMenu({
  creationDisabled,
  onMountDirectory,
  onNewDirectory,
  onNewWorkspace,
}: CreationMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={creationDisabled}>
        <Button aria-label="新建" ref={triggerRef} size="sm" type="button" variant="secondary">
          ＋
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36" collisionPadding={8} loop>
        <DropdownMenuItem onSelect={() => onNewDirectory(triggerRef.current)}>
          新建文件夹
        </DropdownMenuItem>
        {onMountDirectory ? (
          <DropdownMenuItem onSelect={() => onMountDirectory(triggerRef.current)}>
            挂载目录
          </DropdownMenuItem>
        ) : null}
        {onNewWorkspace ? (
          <DropdownMenuItem onSelect={() => onNewWorkspace(triggerRef.current)}>
            新建工作空间
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceColumns({
  creationDisabled,
  directory,
  folderNotice,
  layout = "columns",
  onMountDirectory,
  onNewDirectory,
  onNewWorkspace,
  onRefresh,
  preview,
  switcher,
  treeCollapsed,
}: WorkspaceColumnsProps) {
  const [frame, column, scroller, pane] = LAYOUT[layout];
  return (
    <div
      className={`min-h-0 min-w-0 flex-1 border border-(--wb-border-default) ${frame}`}
      data-slot="files-layout"
    >
      <aside
        aria-label="工作空间文件"
        className={`flex min-h-0 min-w-0 flex-col border-(--wb-border-default) bg-(--wb-bg-secondary) ${column}`}
        hidden={treeCollapsed}
      >
        {switcher}
        <div className="flex shrink-0 items-center gap-1 px-3 pt-[0.65rem] pb-[0.4rem]">
          <h2 className="mr-auto text-[0.72rem] font-semibold tracking-[0.02em] text-(--wb-text-tertiary)">
            工作空间目录
          </h2>
          <Button
            aria-label="刷新"
            disabled={!onRefresh}
            onClick={onRefresh}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Icon name="refresh-cw" size={14} />
          </Button>
          <CreationMenu
            creationDisabled={creationDisabled}
            onMountDirectory={onMountDirectory}
            onNewDirectory={onNewDirectory}
            onNewWorkspace={onNewWorkspace}
          />
        </div>
        {folderNotice ? (
          <p className={`${ALERT_BOX} shrink-0 text-[12px]`} role="alert">
            {folderNotice}
          </p>
        ) : null}
        <div className={`min-h-0 flex-1 overflow-auto px-[0.4rem] pt-[0.15rem] pb-3 ${scroller}`}>
          {directory}
        </div>
      </aside>
      <section
        aria-label="文件预览"
        className={`flex min-h-0 min-w-0 flex-col ${pane}`}
        data-slot="files-preview"
      >
        {preview}
      </section>
    </div>
  );
}
