/**
 * Files page frame: the tree column (switcher, heading, 刷新, 新建, directory) beside the preview,
 * stacked at the shell's narrow breakpoint. Neither `files-layout` nor `files-preview` paints a
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
import { Icon } from "../../ui/index.js";
import { EmptyState } from "./empty-state.js";

/** Error box (the former global alert rule); callers add the font size. */
export const ALERT_BOX =
  "rounded-lg bg-(--wb-status-error-soft-bg) px-2.5 py-2 text-(--wb-status-error-text)";
export const STATUS_TEXT = "shrink-0 text-[13px] text-muted-foreground";

type CreationMenuProps = {
  /** 回调带上菜单触发器，供对话框在取消类关闭后把焦点还给它。 */
  onNewDirectory(trigger: HTMLElement | null): void;
  onNewWorkspace(trigger: HTMLElement | null): void;
};

type WorkspaceColumnsProps = CreationMenuProps & {
  directory: ReactNode;
  folderNotice?: string | null;
  /** 缺省（没有工作空间）时 `刷新` 渲染为禁用。 */
  onRefresh?: () => void;
  preview: ReactNode;
  switcher: ReactNode;
};

export function EmptyPreview() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState description="在左侧目录树中选择一个文件进行预览" title="未选择文件" />
    </div>
  );
}

/** `modal={false}`：菜单不锁 body 的指针事件，随后打开的对话框自己管模态。 */
function CreationMenu({ onNewDirectory, onNewWorkspace }: CreationMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button aria-label="新建" ref={triggerRef} size="sm" type="button" variant="secondary">
          ＋
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36" collisionPadding={8} loop>
        <DropdownMenuItem onSelect={() => onNewDirectory(triggerRef.current)}>
          新建文件夹
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onNewWorkspace(triggerRef.current)}>
          新建工作空间
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceColumns({
  directory,
  folderNotice,
  onNewDirectory,
  onNewWorkspace,
  onRefresh,
  preview,
  switcher,
}: WorkspaceColumnsProps) {
  return (
    <div
      className="grid min-h-0 min-w-0 flex-1 grid-cols-[280px_minmax(0,1fr)] overflow-hidden border border-(--wb-border-default) max-[900px]:grid-cols-[210px_minmax(0,1fr)] narrow:flex narrow:flex-col narrow:overflow-auto"
      data-slot="files-layout"
    >
      <aside
        aria-label="工作空间文件"
        className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-(--wb-border-default) bg-(--wb-bg-secondary) narrow:w-full narrow:flex-none narrow:border-r-0 narrow:border-b"
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
          <CreationMenu onNewDirectory={onNewDirectory} onNewWorkspace={onNewWorkspace} />
        </div>
        {folderNotice ? (
          <p className={`${ALERT_BOX} shrink-0 text-[12px]`} role="alert">
            {folderNotice}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto px-[0.4rem] pt-[0.15rem] pb-3 narrow:max-h-[16rem]">
          {directory}
        </div>
      </aside>
      <section
        aria-label="文件预览"
        className="flex min-h-0 min-w-0 flex-col overflow-hidden narrow:min-h-[16rem] narrow:flex-auto"
        data-slot="files-preview"
      >
        {preview}
      </section>
    </div>
  );
}
