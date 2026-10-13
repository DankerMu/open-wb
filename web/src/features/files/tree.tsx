import { type DragEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon, type IconName } from "../../ui/index.js";
import { ownValue, type TreeRow, type TreeRows, workspacePath } from "./browser-paths.js";
import { ALERT_BOX } from "./columns.js";
import { EmptyState } from "./empty-state.js";
import type { EntryActions, MenuFocus } from "./entry-ops.js";
import { fileIcon, formatSize } from "./file-meta.js";

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
  onSelectFile(entry: TreeRow, path: string): void;
  onToggleDirectory(path: string): void;
};

type DirectoryTreeProps = DirectoryTreeState & {
  /** 根行副行：逻辑路径 `<account>/<dir>`；不可解析时不渲染。 */
  rootPath: string | undefined;
  workspaceName: string;
};

/** 可拖的行的行按钮上的属性。 */
type DragSource = {
  draggable: true;
  onDragEnd(): void;
  onDragStart(event: DragEvent<HTMLElement>): void;
};

/** 能放下的行（目录行与根行）的行按钮上的属性；`data-drop-target` 是经过时的高亮。 */
type DropTarget = {
  "data-drop-target": "true" | undefined;
  onDragEnter(event: DragEvent<HTMLElement>): void;
  onDragLeave(): void;
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
};

/** 拖放给行按钮的属性：文件行只能被拖走；目录行可拖走也可放下；根行（`""`）只能放下。 */
type RowDrag = {
  directory(path: string): DropTarget & Partial<DragSource>;
  file(path: string): DragSource;
};

type DirectoryNodeProps = DirectoryTreeState & {
  drag: RowDrag | undefined;
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
  drag: RowDrag | undefined;
  entry: TreeRow;
  path: string;
  selected: boolean;
};

/**
 * 树行（目录与文件同一写法）；选中的文件行由 `aria-current` 着色，拖动经过的可放下的目录行由
 * `data-drop-target` 着色加框。
 */
const ROW =
  "group/row peer/row flex w-full min-w-0 cursor-pointer items-center gap-[0.4rem] rounded-[6px] px-2 py-[0.32rem] text-left text-[0.8rem] leading-[1.35] text-(--wb-text-primary) hover:bg-(--wb-brand-primary-subtle) aria-[current=true]:bg-(--wb-brand-primary-subtle) aria-[current=true]:text-(--wb-brand-primary-deep) data-[drop-target=true]:bg-(--wb-brand-primary-subtle) data-[drop-target=true]:ring-1 data-[drop-target=true]:ring-(--wb-brand-primary) data-[drop-target=true]:ring-inset";
/**
 * 拖动一行时写进 `dataTransfer` 的类型，值是该行的路径。只当记号用：经过时看 `types` 里有没有它，放下
 * 时把它的值与本树记下的路径比一次是否相等——发给服务端的路径不从这里取。不用 `text/plain`：文字类型
 * 的拖动放进输入框会把路径插进去。
 */
const ENTRY_DRAG = "application/x-workbuddy-entry";
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
 * 树的拖放（原生拖放）。被拖的行的路径记在 `dragged` 里：`dragstart` 写入，`drop` 与 `dragend` 清掉，
 * 下一次 `dragstart` 覆写；`from` 只从它取。经过一行时可放下的条件是三条同时成立：`dragged` 非空（拖动
 * 是从本树起的）、`types` 里有 `ENTRY_DRAG`、`actions.accepts`（不是自身、后代、当前父目录，且没有在途
 * 的放下）——成立才拦缺省动作，浏览器因此才会在这一行上发 `drop`。操作系统的文件、别的页面拖来的东西
 * 没有经过本树的 `dragstart`，或不带这个类型，不被接受。放下时另要求 `getData(ENTRY_DRAG)` 与 `dragged`
 * 逐字相同：源行在拖动途中被重列卸掉时它的 `dragend` 到不了这里，`dragged` 会留着旧值（读代码推出），
 * 这时别处拖来的同类型数据对不上就不发请求。能不能移由 `actions.moveInto` 再判一次。
 * 高亮用进入计数：指针移到行内的子元素上也会触发 `dragleave`。`dragstart` 里不写状态：只写引用。
 * 没给 `actions`（`onlyPaths` 下）就没有拖放。
 */
function useRowDrag(actions: EntryActions | undefined): RowDrag | undefined {
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<{ depth: number; path: string } | null>(null);
  const handlers = useMemo(() => {
    if (!actions) {
      return undefined;
    }

    const end = () => {
      dragged.current = null;
      setOver(null);
    };
    const accepted = (event: DragEvent<HTMLElement>, directory: string) => {
      const from = dragged.current;
      return (
        from !== null &&
        event.dataTransfer.types.includes(ENTRY_DRAG) &&
        actions.accepts(from, directory)
      );
    };
    const source = (path: string): DragSource => ({
      draggable: true,
      onDragEnd: end,
      onDragStart(event) {
        event.dataTransfer.setData(ENTRY_DRAG, path);
        event.dataTransfer.effectAllowed = "move";
        dragged.current = path;
      },
    });
    const target = (directory: string): Omit<DropTarget, "data-drop-target"> => ({
      onDragEnter(event) {
        if (accepted(event, directory)) {
          event.preventDefault();
          setOver((current) => ({
            depth: current?.path === directory ? current.depth + 1 : 1,
            path: directory,
          }));
        }
      },
      onDragLeave() {
        setOver((current) => {
          if (current?.path !== directory) {
            return current;
          }
          return current.depth > 1 ? { depth: current.depth - 1, path: directory } : null;
        });
      },
      onDragOver(event) {
        if (accepted(event, directory)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      },
      onDrop(event) {
        const from = dragged.current;
        end();
        if (from !== null && event.dataTransfer.getData(ENTRY_DRAG) === from) {
          event.preventDefault();
          actions.moveInto(from, directory);
        }
      },
    });
    return { source, target };
  }, [actions]);
  const overPath = over?.path ?? null;
  return useMemo(
    () =>
      handlers && {
        directory: (path: string) => ({
          ...(path === "" ? undefined : handlers.source(path)),
          ...handlers.target(path),
          "data-drop-target": overPath === path ? ("true" as const) : undefined,
        }),
        file: handlers.source,
      },
    [handlers, overPath],
  );
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
  drag,
  entry,
  focusMenuPath,
  marks,
  onSelectFile,
  path,
  selected,
}: FileRowProps) {
  const mark = useRowMark(marks, path);
  // 没有 `size` / `mtime` 的行（`onlyPaths` 下父目录没加载过）照样可选，只是行上不显示大小（issue 1372）。
  const frame = rowFrame(actions, mark.item);

  return (
    <li className={frame.item}>
      <button
        aria-current={selected ? "true" : undefined}
        aria-describedby={mark.describedBy}
        className={frame.row}
        onClick={() => onSelectFile(entry, path)}
        title={entry.name}
        type="button"
        {...drag?.file(path)}
      >
        <span className={GLYPH}>
          <Icon name={fileIcon(entry.name)} size={14} />
        </span>
        <span className={ROW_NAME} data-slot="tree-name">
          {entry.name}
        </span>
        {entry.size === undefined ? null : (
          <span
            aria-hidden="true"
            className="ml-auto flex-none text-[10.5px] whitespace-nowrap text-(--wb-text-tertiary)"
            data-slot="tree-size"
          >
            {formatSize(entry.size)}
          </span>
        )}
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
  drag,
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
  const entries = ownValue(cache, path)?.entries;
  const expanded = expandedPaths.has(path);
  const loading = loadingPaths.has(path);
  const error = ownValue(errors, path);
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
        {...drag?.directory(path)}
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
                    drag={drag}
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
                  drag={drag}
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
  const drag = useRowDrag(state.actions);
  return (
    <nav aria-label="工作空间目录树">
      <ul>
        <DirectoryNode
          {...state}
          drag={drag}
          icon="shield"
          label={workspaceName}
          path=""
          subline={rootPath}
        />
      </ul>
    </nav>
  );
}
