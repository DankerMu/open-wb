import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon, type IconName } from "../../ui/index.js";
import { type TreeRow, type TreeRows, workspacePath } from "./browser-paths.js";
import { ALERT_BOX } from "./columns.js";
import { EmptyState } from "./empty-state.js";
import type { EntryActions, MenuFocus } from "./entry-ops.js";
import { fileIcon, formatSize } from "./file-meta.js";
import type { TreeEntry } from "./types.js";

/** 带标记的行（路径与其各级父目录）与标记的可访问文本。 */
type TreeMarks = { label: string; paths: ReadonlySet<string> };

type DirectoryTreeState = {
  cache: TreeRows;
  errors: Record<string, string>;
  expandedPaths: ReadonlySet<string>;
  loadingPaths: ReadonlySet<string>;
  marks: TreeMarks | undefined;
  selectedPath: string | null;
  /** 给了才有行菜单（根行始终没有）；`onlyPaths` 下浏览器不给。 */
  actions?: EntryActions | undefined;
  focusMenuPath?: MenuFocus | undefined;
  onSelectFile(entry: TreeEntry, path: string): void;
  onToggleDirectory(path: string): void;
};

type DirectoryTreeProps = DirectoryTreeState & {
  /** 根行副行：逻辑路径 `<account>/<dir>`；不可解析时不渲染。 */
  rootPath: string | undefined;
  workspaceName: string;
};

type DirectoryNodeProps = DirectoryTreeState & {
  icon: IconName;
  label: string;
  path: string;
  subline?: string | undefined;
};

type RowMenuProps = Pick<DirectoryTreeState, "actions" | "focusMenuPath"> & {
  name: string;
  path: string;
  type: "dir" | "file";
};

type FileRowProps = Pick<
  DirectoryTreeState,
  "actions" | "focusMenuPath" | "marks" | "onSelectFile"
> & {
  entry: TreeRow;
  path: string;
  selected: boolean;
};

/** 树行（目录与文件同一写法）；选中的文件行由 `aria-current` 着色。 */
const ROW =
  "group/row peer/row flex w-full min-w-0 cursor-pointer items-center gap-[0.4rem] rounded-[6px] px-2 py-[0.32rem] text-left text-[0.8rem] leading-[1.35] text-(--wb-text-primary) hover:bg-(--wb-brand-primary-subtle) aria-[current=true]:bg-(--wb-brand-primary-subtle) aria-[current=true]:text-(--wb-brand-primary-deep)";
const GLYPH =
  "inline-flex size-[14px] shrink-0 text-(--wb-text-secondary) group-aria-[current=true]/row:text-(--wb-brand-primary-deep)";
const ROW_NAME = "min-w-0 flex-1 truncate";
/** 行下方的附注（错误、读取中、空目录、根的逻辑路径）与行内文字左对齐。 */
const ROW_NOTE = "mr-2 ml-7";
const UNMARKED = { describedBy: undefined, item: "min-w-0", mark: null };

/** `<li>` 与行按钮的类。带行菜单的行：`<li>` 给菜单按钮定位，行按钮在右端给它让出位置。 */
function rowFrame(menu: EntryActions | undefined, item: string) {
  return menu ? { item: "relative min-w-0", row: `${ROW} pr-8` } : { item, row: ROW };
}

/**
 * 行的标记：行按钮的兄弟元素，经 `aria-describedby` 关联——放进按钮会改掉行的可访问名（恰为文件名）。
 * 圆点画在行的左内边距里；文本只给辅助技术。没有标记的行，`<li>` 与按钮同没有这个属性时一样。
 */
function useRowMark(marks: TreeMarks | undefined, path: string) {
  const id = useId();
  if (!marks?.paths.has(path)) {
    return UNMARKED;
  }

  return {
    describedBy: id,
    item: "relative min-w-0",
    mark: (
      <span
        className="pointer-events-none absolute top-[0.62rem] left-[1px] size-[5px] rounded-full bg-(--wb-brand-primary)"
        data-slot="tree-mark"
        id={id}
      >
        <span className="sr-only">{marks.label}</span>
      </span>
    ),
  };
}

/**
 * 行菜单 `更多操作 <名>`：行按钮的兄弟元素，画在行的右端——放进行按钮会改掉行的可访问名，按钮里也
 * 不能再套按钮。始终在 DOM 里且可聚焦；只在可悬停的宽屏上以透明度弱化，行悬停、行或它自己有焦点、
 * 菜单打开时显现。`modal={false}`：不锁 body 的指针事件，随后打开的对话框自己管模态。
 * 各项送出的都是这一行自己的 `path`（父目录接上列表里的名字，`workspacePath`）与 `name`，不是选中项的。
 * `下载` 是链接：浏览器直接导航，文件名由服务端的 Content-Disposition 给。没给 `actions` 就不渲染。
 */
function RowMenu({ actions, focusMenuPath, name, path, type }: RowMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 这一行是刚被重命名或移动出来的：把焦点接过来（旧行连同它的按钮已卸载）。删除不经这里：被删的行没有新行。
  useEffect(() => {
    if (focusMenuPath && focusMenuPath.current === path) {
      focusMenuPath.current = null;
      triggerRef.current?.focus();
    }
  }, [focusMenuPath, path]);

  if (!actions) {
    return null;
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`更多操作 ${name}`}
          className="absolute top-[0.1rem] right-1 text-muted-foreground peer-hover/row:opacity-100 peer-focus-visible/row:opacity-100 hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:hover)_and_(min-width:761px)]:opacity-0"
          ref={triggerRef}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Icon name="more-horizontal" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32" collisionPadding={8} loop>
        <DropdownMenuItem onSelect={() => actions.rename({ name, path, type }, triggerRef.current)}>
          <Icon name="pencil" size={14} />
          重命名
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.moveTo({ name, path, type }, triggerRef.current)}>
          <Icon name="folder" size={14} />
          移动到…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => actions.remove({ name, path, type }, triggerRef.current)}
          variant="destructive"
        >
          <Icon name="trash" size={14} />
          删除
        </DropdownMenuItem>
        {type === "file" ? (
          <DropdownMenuItem asChild>
            <a download href={actions.downloadHref(path)}>
              <Icon name="download" size={14} />
              下载
            </a>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FileRow({
  actions,
  entry,
  focusMenuPath,
  marks,
  onSelectFile,
  path,
  selected,
}: FileRowProps) {
  const mark = useRowMark(marks, path);
  // 没有 `size` / `mtime` 的行（`onlyPaths` 下父目录没加载过）选不了：预览头要这两项。
  const stat = entry.size === undefined ? null : entry;
  const frame = rowFrame(actions, mark.item);

  return (
    <li className={frame.item}>
      <button
        aria-current={selected ? "true" : undefined}
        aria-describedby={mark.describedBy}
        className={frame.row}
        disabled={stat === null}
        onClick={stat ? () => onSelectFile(stat, path) : undefined}
        title={entry.name}
        type="button"
      >
        <span className={GLYPH}>
          <Icon name={fileIcon(entry.name)} size={14} />
        </span>
        <span className={ROW_NAME} data-slot="tree-name">
          {entry.name}
        </span>
        {stat ? (
          <span
            aria-hidden="true"
            className="ml-auto flex-none text-[10.5px] whitespace-nowrap text-(--wb-text-tertiary)"
            data-slot="tree-size"
          >
            {formatSize(stat.size)}
          </span>
        ) : null}
      </button>
      <RowMenu
        actions={actions}
        focusMenuPath={focusMenuPath}
        name={entry.name}
        path={path}
        type="file"
      />
      {mark.mark}
    </li>
  );
}

function DirectoryNode({
  actions,
  cache,
  errors,
  expandedPaths,
  focusMenuPath,
  icon,
  label,
  loadingPaths,
  marks,
  onSelectFile,
  onToggleDirectory,
  path,
  selectedPath,
  subline,
}: DirectoryNodeProps) {
  const entries = cache[path]?.entries;
  const expanded = expandedPaths.has(path);
  const loading = loadingPaths.has(path);
  const error = errors[path];
  const mark = useRowMark(marks, path);
  // 根行没有菜单。
  const menu = path === "" ? undefined : actions;
  const frame = rowFrame(menu, mark.item);

  return (
    <li className={frame.item}>
      <button
        aria-describedby={mark.describedBy}
        aria-expanded={expanded}
        aria-label={`${expanded ? "折叠" : "展开"} ${label}`}
        className={frame.row}
        onClick={() => onToggleDirectory(path)}
        title={label}
        type="button"
      >
        <svg
          aria-hidden="true"
          className={`${GLYPH} transition-transform duration-120 ${expanded ? "rotate-0" : "-rotate-90"}`}
          viewBox="0 0 16 16"
        >
          <path d="M4 6l4 5 4-5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className={GLYPH}>
          <Icon name={icon} size={14} />
        </span>
        <span className={ROW_NAME} data-slot="tree-name">
          {label}
        </span>
      </button>
      <RowMenu actions={menu} focusMenuPath={focusMenuPath} name={label} path={path} type="dir" />
      {mark.mark}
      {subline ? (
        <p
          className={`${ROW_NOTE} mb-[0.35rem] truncate font-(family-name:--wb-mono) text-[0.65rem] leading-[1.3] text-(--wb-text-tertiary)`}
          data-slot="tree-root-path"
        >
          {subline}
        </p>
      ) : null}
      {error ? (
        <p
          className={`${ROW_NOTE} ${ALERT_BOX} mt-[0.2rem] mb-[0.35rem] text-[0.75rem]`}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {expanded && loading && !entries ? (
        <p
          className={`${ROW_NOTE} mt-[0.2rem] mb-[0.35rem] text-[0.75rem] text-muted-foreground`}
          role="status"
        >
          正在读取目录
        </p>
      ) : null}
      {expanded && entries ? (
        <ul className="pl-[0.85rem]">
          {entries.length === 0 ? (
            <li className="min-w-0">
              {path === "" ? (
                <EmptyState description="点击左上角 ＋ 新建文件夹" title="该工作空间暂无目录" />
              ) : (
                <p
                  className={`${ROW_NOTE} mt-[0.15rem] mb-[0.4rem] text-[0.75rem] text-muted-foreground`}
                >
                  空目录
                </p>
              )}
            </li>
          ) : (
            entries.map((entry) => {
              const entryPath = workspacePath(path, entry.name);
              if (entry.type === "dir") {
                return (
                  <DirectoryNode
                    actions={actions}
                    cache={cache}
                    errors={errors}
                    expandedPaths={expandedPaths}
                    focusMenuPath={focusMenuPath}
                    icon="folder"
                    key={entryPath}
                    label={entry.name}
                    loadingPaths={loadingPaths}
                    marks={marks}
                    onSelectFile={onSelectFile}
                    onToggleDirectory={onToggleDirectory}
                    path={entryPath}
                    selectedPath={selectedPath}
                  />
                );
              }

              return (
                <FileRow
                  actions={actions}
                  entry={entry}
                  focusMenuPath={focusMenuPath}
                  key={entryPath}
                  marks={marks}
                  onSelectFile={onSelectFile}
                  path={entryPath}
                  selected={selectedPath === entryPath}
                />
              );
            })
          )}
        </ul>
      ) : null}
    </li>
  );
}

export function DirectoryTree({ rootPath, workspaceName, ...state }: DirectoryTreeProps) {
  return (
    <nav aria-label="工作空间目录树">
      <ul>
        <DirectoryNode {...state} icon="shield" label={workspaceName} path="" subline={rootPath} />
      </ul>
    </nav>
  );
}
