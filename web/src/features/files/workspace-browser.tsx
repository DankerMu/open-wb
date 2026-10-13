/**
 * `WorkspaceBrowser`: one workspace's directory tree, preview and the requests behind them. The
 * files page wraps it; nothing in here knows about the address or the router.
 *
 * - Current path: `path` is applied when it changes — the unloaded parent directories are listed
 *   one level at a time, each requested once whether or not the level above lists it, then a file
 *   is selected (one `file` request) and a directory only expanded. A selection made this way is
 *   not reported; a click and `reveal` report through `onPathChange` once the file is found.
 * - A walk started by `path` that does not end on a file leaves nothing selected. Ending on a
 *   directory shows the empty preview; a last name missing from its parent's listing shows
 *   `文件不存在`; a level whose request failed shows that failure's message (none for a 401, which
 *   belongs to the login layer). Before the walk `path` loses its empty and `.` segments
 *   (`normalizedPath`); nothing left is the same as no `path`, and a `..` segment ends it there
 *   with `文件不存在` and no request for it. The other segments go out as given: whether a level
 *   may be listed is the server's answer. A `path` equal to the selection as written is left
 *   alone before any of that, and `reveal` takes its path as given. A failed level without
 *   a row on the tree is kept out of the error rows and the expanded set, so `刷新` does not ask
 *   for it again. `reveal` reports no failure, and `刷新` does not repeat a failed walk.
 * - A web page (html / htm) is the exception to that one request: it opens in the rendered view,
 *   loaded by a frame from the preview origin, and `file` is requested only for its source view
 *   (`immediatePreview`). A PDF or office document (docx / xlsx / pptx) is loaded by a frame from
 *   the preview origin too, and `file` is never requested for it. The preview token is issued
 *   here, by the one `usePreviewToken` call, and handed down as a prop; it is not part of the
 *   selection, the address or anything stored.
 * - `onlyPaths`: the tree is built from those of the paths that still make a row (`listedPaths`,
 *   then `subtreeOf`) and the listing cache is not written, so it is back when `onlyPaths` is
 *   dropped. `loadDirectory` (`directory-loader.ts`) returns without a request while it is set:
 *   tests pin that for `refresh`, for a walk and for mounting. `新建` is disabled while it is set:
 *   the re-listing after creating a folder would go through the same gate. Dropping it requests
 *   the root if that was never loaded and replays nothing else.
 * - Rows under `onlyPaths` (issue 1372): every row can be selected, with or without a listing of its
 *   parent — one without has no size and no time, and whether the file exists is what `file` /
 *   `archive` answers. A path in `onlyPaths` makes no row once it is known to be gone
 *   (`path-records.ts`: it answered 404, or its parent's listing is loaded without it and no step
 *   reported it since — the host says so through `reported`). A `path` or `reveal` inside
 *   `onlyPaths` follows the same test instead of walking: a row is selected, no row clears the
 *   selection; a path outside `onlyPaths` walks as before and stops, untouched, at the first
 *   unloaded level.
 * - A 404 from `file` or `archive` for the current file, when `onlyPaths` or `clearMissing` is
 *   given: the path is recorded, the selection is cleared and `onPathChange(null)` is called once;
 *   the failed state is never shown. Any other failure stays the failed preview. With neither prop
 *   (the files page) a 404 is the envelope's message as before.
 * - `clearMissing` (the session sidebar gives it, always): a walk started by `path` that does not
 *   end on a file shows the empty preview whatever the reason (missing name, `..`, a failed
 *   level); the failed level keeps its error row on the tree. Rows of the ordinary tree are not
 *   removed by it: they come from the listings alone.
 * - Not claimed: a web page's rendered view, a PDF, an office document and audio / video are not
 *   read through `file` or `archive`, so the page never sees a 404 for them; such a row stays and
 *   shows what its previewer shows (read from the code, design D14-5).
 * - Entry operations: the row menu, its dialog and the request are `useEntryOperations`
 *   (`entry-ops.tsx`); after a rename or a move `useFollowEntry` (`follow-entry.ts`) moves the
 *   listings, the expanded set and the selection to the new path without walking again, and after a
 *   delete drops them (a deleted current file or ancestor: `onPathChange(null)`). A row dropped on a
 *   directory row moves the same way (`tree.tsx`). No row menu and no drag while `onlyPaths` is set.
 */
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ApiClient, fileUrl } from "../../lib/api.js";
import {
  type DirectoryCache,
  loadedDirectoryPaths,
  markedRows,
  normalizedPath,
  parentPath,
  refreshLayers,
  revealStep,
  subtreeOf,
  type TreeRow,
} from "./browser-paths.js";
import { type BrowserLayout, emptyNote, WorkspaceColumns } from "./columns.js";
import { DirectoryDialog } from "./dialogs.js";
import { useDirectoryLoader } from "./directory-loader.js";
import { useEntryOperations } from "./entry-ops.js";
import { isNotFound, isUnauthorized } from "./errors.js";
import { logicalPath } from "./file-meta.js";
import { useFolderDialog } from "./folder-dialog.js";
import { useFollowEntry } from "./follow-entry.js";
import { filteredRow, listedPaths, usePathRecords } from "./path-records.js";
import {
  failedPreview,
  immediatePreview,
  PreviewArea,
  type SelectedFile,
  withFetched,
} from "./preview-area.js";
import { DirectoryTree } from "./tree.js";
import { usePreviewToken } from "./use-preview-token.js";

/** 进行中的定位：`asked` 是这一次已经请求过的目录，请求过仍没有列表即失败。 */
type Reveal = { asked: Set<string>; notify: boolean; path: string };

export type WorkspaceBrowserHandle = {
  /** 逐级展开到 `path` 并选中；`view` 目前没有消费方。 */
  reveal(path: string, options?: { view?: "rendered" }): void;
  /** 重取已加载的目录：给了 `paths` 只取它们的各级父目录，当前文件在其中才重取预览。 */
  refresh(paths?: string[]): void;
  /** 这些路径刚被一个结束的步骤报过：只记账（`path-records.ts`），不发请求。 */
  reported(paths: readonly string[]): void;
};

type WorkspaceBrowserProps = {
  account: string;
  client: ApiClient;
  workspaceId: string;
  /** 空间名；缺省时根行显示 `工作空间`。 */
  name?: string | undefined;
  /** 给了才渲染根行的逻辑路径 `<account>/<dir>`。 */
  dir?: string | undefined;
  path: string | null;
  onPathChange(path: string | null): void;
  layout?: BrowserLayout | undefined;
  markedPaths?: { label: string; paths: ReadonlySet<string> } | undefined;
  onlyPaths?: ReadonlySet<string> | undefined;
  /** 侧边栏专用（恒为真）：已不存在的文件一律清空，不放文案；文件页不给。见头注释。 */
  clearMissing?: boolean | undefined;
  /** 侧边栏用：`onlyPaths` 里一行不剩时树的位置上的文案；树栏收起（见 `WorkspaceColumns`）。 */
  onlyPathsEmpty?: string | undefined;
  treeCollapsed?: boolean | undefined;
  /** 侧边栏用：换成新值（非 `undefined`）时，`path` 所指的网页已选中且停在源码视图就翻回渲染视图。 */
  renderedSeq?: number | undefined;
  ref?: Ref<WorkspaceBrowserHandle> | undefined;
  /** 文件页专用：切换器与 `新建工作空间`。 */
  switcher?: ReactNode;
  onNewWorkspace?: ((trigger: HTMLElement | null) => void) | undefined;
};

const MISSING_FILE = "文件不存在";

/** 这一次定位请求过 `directory` 才读它的失败文案：`onlyPaths` 下没有请求，早先留下的文案不算数。 */
function failureOf(target: Reveal, failed: ReadonlyMap<string, string>, directory: string) {
  return target.asked.has(directory) ? failed.get(directory) : undefined;
}

const NO_PATHS: ReadonlySet<string> = new Set();
const NO_ERRORS: Record<string, string> = {};

export function WorkspaceBrowser({
  account,
  clearMissing = false,
  client,
  dir,
  layout,
  markedPaths,
  name = "工作空间",
  onNewWorkspace,
  onPathChange,
  onlyPaths,
  onlyPathsEmpty,
  path,
  ref,
  renderedSeq,
  switcher,
  treeCollapsed,
  workspaceId,
}: WorkspaceBrowserProps) {
  const [directories, setDirectories] = useState<DirectoryCache>({});
  const [directoryErrors, setDirectoryErrors] = useState<Record<string, string>>({});
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set([""]));
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set());
  // `path` 属性的定位没有落在文件上时预览区显示的失败文案。
  const [pathNotice, setPathNotice] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const appliedPathRef = useRef<string | null | undefined>(undefined);
  const cacheRef = useRef<DirectoryCache>({});
  const directoryRequestsRef = useRef(new Map<string, AbortController>());
  const expandedPathsRef = useRef<ReadonlySet<string>>(new Set([""]));
  // 最近一次请求失败的目录与文案：定位从这里读（它的 effect 不随 `directoryErrors` 重跑）。
  const failedDirectoriesRef = useRef(new Map<string, string>());
  // 行操作成功后该拿到焦点的行（`MenuFocus`）；它所在的那一层重列失败就作废，不留给以后才出现的行。
  const focusMenuPath = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const ownedImageUrlRef = useRef<string | null>(null);
  const previewRequestRef = useRef(0);
  const previewControllerRef = useRef<AbortController | null>(null);
  const revealRef = useRef<Reveal | null>(null);
  const selectedFileRef = useRef<SelectedFile | null>(null);
  const subtreeOnly = onlyPaths !== undefined;
  const pathRecords = usePathRecords();
  const { missing: recordMissing, records, ref: recordsRef } = pathRecords;
  // 这一页唯一的一次调用：选中的是网页（渲染或源码视图）、PDF 或办公文档时才签发与续期。第四参是
  // 该预览的 `reload`：刷新或再点同一行使它变化（网页限渲染视图），令牌由此按需重新签发；其余情况给 0。
  const framed =
    selectedFile?.preview?.status === "web" || selectedFile?.preview?.status === "document"
      ? selectedFile.preview
      : null;
  const previewToken = usePreviewToken(client, workspaceId, framed !== null, framed?.reload ?? 0);

  const releaseOwnedImage = useCallback(() => {
    const url = ownedImageUrlRef.current;
    if (!url) {
      return;
    }

    ownedImageUrlRef.current = null;
    URL.revokeObjectURL(url);
  }, []);

  const publishSelectedFile = useCallback((next: SelectedFile | null) => {
    selectedFileRef.current = next;
    setSelectedFile(next);
  }, []);

  const loadDirectory = useDirectoryLoader({
    cacheRef,
    client,
    directoryRequestsRef,
    failedDirectoriesRef,
    focusMenuPath,
    mountedRef,
    onListed: pathRecords.listed,
    setDirectories,
    setDirectoryErrors,
    setLoadingPaths,
    subtreeOnly,
    workspaceId,
  });

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      for (const controller of directoryRequestsRef.current.values()) {
        controller.abort();
      }
      directoryRequestsRef.current.clear();
      previewRequestRef.current += 1;
      previewControllerRef.current?.abort();
      previewControllerRef.current = null;
      // 重挂（StrictMode）后 `path` 重新生效一次：上面中止的请求不会再推进旧的定位。
      appliedPathRef.current = undefined;
      revealRef.current = null;
      releaseOwnedImage();
    };
  }, [releaseOwnedImage]);

  // `onlyPaths` 撤掉时 `loadDirectory` 换新，根若还没加载过在这里补上。
  useEffect(() => {
    loadDirectory("");
  }, [loadDirectory]);

  const expandDirectories = useCallback((paths: readonly string[]) => {
    if (paths.every((path) => expandedPathsRef.current.has(path))) {
      return;
    }

    expandedPathsRef.current = new Set([...expandedPathsRef.current, ...paths]);
    setExpandedPaths(expandedPathsRef.current);
  }, []);

  const toggleDirectory = useCallback(
    (path: string) => {
      const expanded = expandedPathsRef.current.has(path);
      const next = new Set(expandedPathsRef.current);
      if (expanded) {
        next.delete(path);
      } else {
        next.add(path);
        loadDirectory(path);
      }
      expandedPathsRef.current = next;
      setExpandedPaths(next);
    },
    [loadDirectory],
  );

  /** 放弃进行中的 `file` 请求：它的应答此后不再交付。 */
  const cancelPreviewRequest = useCallback(() => {
    previewRequestRef.current += 1;
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
  }, []);

  const clearSelection = useCallback(() => {
    if (!selectedFileRef.current) {
      return;
    }

    cancelPreviewRequest();
    releaseOwnedImage();
    publishSelectedFile(null);
    setPreviewLoading(false);
  }, [cancelPreviewRequest, publishSelectedFile, releaseOwnedImage]);

  /**
   * `file` / `archive` 对 `path` 的失败是不是「它已不存在」：给了 `onlyPaths` 或 `clearMissing`、应答是
   * 404、它仍是当前文件——记下它，清掉选中并上报 `null`，返回真（调用方不再进失败态）。其余返回假。
   */
  const dropMissing = useCallback(
    (path: string, error: unknown) => {
      const tracked = subtreeOnly || clearMissing;
      if (!tracked || !isNotFound(error) || selectedFileRef.current?.path !== path) {
        return false;
      }

      recordMissing(path);
      clearSelection();
      onPathChange(null);
      return true;
    },
    [clearMissing, clearSelection, onPathChange, recordMissing, subtreeOnly],
  );

  /**
   * 为已发布的选中项 `path` 发一次 `file` 请求；调用方先 `cancelPreviewRequest`。结局经
   * `withFetched` 放进那时的预览：网页收进它的 `source`，其余类别就是预览本身。
   */
  const requestPreview = useCallback(
    (path: string) => {
      const request = previewRequestRef.current;
      setPreviewLoading(true);
      const controller = new AbortController();
      previewControllerRef.current = controller;
      void client
        .fetchPreview(workspaceId, path, { signal: controller.signal })
        .then((preview) => {
          const current = selectedFileRef.current;
          const stale =
            !mountedRef.current ||
            controller.signal.aborted ||
            request !== previewRequestRef.current ||
            current?.path !== path;
          if (stale || !current) {
            if (preview.kind === "image") {
              URL.revokeObjectURL(preview.url);
            }
            return;
          }

          if (preview.kind === "image") {
            releaseOwnedImage();
            ownedImageUrlRef.current = preview.url;
          } else {
            releaseOwnedImage();
          }
          publishSelectedFile({
            ...current,
            preview: withFetched(current.preview, { status: "success", data: preview }),
          });
          setPreviewLoading(false);
        })
        .catch((error: unknown) => {
          const current = selectedFileRef.current;
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            request !== previewRequestRef.current ||
            current?.path !== path ||
            !current ||
            isUnauthorized(error)
          ) {
            return;
          }

          if (dropMissing(path, error)) {
            return;
          }

          releaseOwnedImage();
          publishSelectedFile({
            ...current,
            preview: withFetched(current.preview, failedPreview(error)),
          });
          setPreviewLoading(false);
        })
        .finally(() => {
          // 结果已在上面交付或丢弃；中止是为了放掉没读正文就判失败的应答（如内容类型不被接受的 200）。
          controller.abort();
          if (previewControllerRef.current === controller) {
            previewControllerRef.current = null;
          }
        });
    },
    [client, dropMissing, publishSelectedFile, releaseOwnedImage, workspaceId],
  );

  const selectFile = useCallback(
    (entry: TreeRow, path: string) => {
      cancelPreviewRequest();
      setPathNotice(null);
      const previous = selectedFileRef.current;
      const sameFile = previous?.path === path;
      const next: SelectedFile =
        sameFile && previous ? { ...previous, entry, path } : { entry, path, preview: null };

      if (!sameFile) {
        releaseOwnedImage();
      }

      // 不发 `file` 请求的类别在这里交付：上一个请求已中止，换了文件时旧图片也已释放，没有新请求要管。
      // 压缩包的成员列表请求由它的预览器发起并中止；这里每次给一个新函数，刷新与再点同一行因此重新列出。
      // 它不经 `requestPreview`：404 在这个闭包里交给 `dropMissing`，再照旧抛给预览器。
      // 网页也在这里：渲染视图不请求；同一路径停在源码视图时得到 `null`，走下面那一次请求。
      const immediate = immediatePreview(
        entry,
        fileUrl(workspaceId, path),
        (signal) =>
          client.listArchive(workspaceId, path, { signal }).catch((error: unknown) => {
            dropMissing(path, error);
            throw error;
          }),
        sameFile && previous ? previous.preview : null,
      );
      if (immediate) {
        publishSelectedFile({ entry, path, preview: immediate });
        setPreviewLoading(false);
        return;
      }

      publishSelectedFile(next);
      requestPreview(path);
    },
    [
      cancelPreviewRequest,
      client,
      dropMissing,
      publishSelectedFile,
      releaseOwnedImage,
      requestPreview,
      workspaceId,
    ],
  );

  /**
   * 网页预览的视图切换。切到源码而源码没有取过：发一次 `file` 请求；取过就不再发。切回渲染：放弃
   * 还在途的那一次——它的结局不知道，取过的源码一并丢掉，下次看源码重新取。
   */
  const showWebView = useCallback(
    (view: "rendered" | "source") => {
      const current = selectedFileRef.current;
      const web = current?.preview;
      if (!current || web?.status !== "web" || web.view === view) {
        return;
      }

      const source = previewControllerRef.current ? null : web.source;
      cancelPreviewRequest();
      publishSelectedFile({ ...current, preview: { ...web, view, source } });
      if (view === "source" && source === null) {
        requestPreview(current.path);
      } else {
        setPreviewLoading(false);
      }
    },
    [cancelPreviewRequest, publishSelectedFile, requestPreview],
  );

  /** 点击文件行：放弃进行中的定位，选中并上报。点已选中的文件照样重取预览。 */
  const chooseFile = useCallback(
    (entry: TreeRow, path: string) => {
      revealRef.current = null;
      selectFile(entry, path);
      onPathChange(path);
    },
    [onPathChange, selectFile],
  );

  /**
   * 定位遇到未加载的层：请求进行中就等；这一次还没请求过就请求并等；否则（失败过，或 `onlyPaths` 下）
   * 不等。`onTree` 为假即这一层在树上没有行。
   */
  const awaitDirectory = useCallback(
    (target: Reveal, directory: string, onTree: boolean) => {
      if (directoryRequestsRef.current.has(directory)) {
        return true;
      }
      if (subtreeOnly || target.asked.has(directory)) {
        return false;
      }

      target.asked.add(directory);
      loadDirectory(directory, false, onTree);
      return true;
    },
    [loadDirectory, subtreeOnly],
  );

  /**
   * 定位结束而没有落在文件上。`path` 属性发起的：清掉选中，预览区显示 `notice`（`null` 即空态；
   * `clearMissing` 下文案不交给预览区，一律空态）；没有文案可给（`undefined`：401，或 `onlyPaths` 下
   * 没有请求）时什么都不动。`reveal` 发起的不报。
   */
  const endWithoutFile = useCallback(
    (target: Reveal, notice: string | null | undefined) => {
      if (target.notify || notice === undefined) {
        return;
      }

      clearSelection();
      setPathNotice(notice);
    },
    [clearSelection],
  );

  /**
   * 定位落在目录 `path` 上：展开并请求它。它的父目录不在 `rows`（树上有行的各级）里时——上一级的
   * 列表没列出、却能列的目录——它自己也没有行：不展开、不请求。
   */
  const openDirectory = useCallback(
    (path: string, rows: readonly string[]) => {
      if (!rows.includes(parentPath(path))) {
        return;
      }

      expandDirectories([path]);
      loadDirectory(path);
    },
    [expandDirectories, loadDirectory],
  );

  /** 定位落在文件上：选中，`reveal` 发起的另上报一次。 */
  const land = useCallback(
    (row: TreeRow, target: Reveal) => {
      selectFile(row, target.path);
      if (target.notify) {
        onPathChange(target.path);
      }
    },
    [onPathChange, selectFile],
  );

  /**
   * `onlyPaths` 之内的路径不逐级走、不等目录：它在过滤视图里成行（`filteredRow`）就选中并取预览；不
   * 成行即已不存在，清掉选中——`path` 属性发起的经 `endWithoutFile`，`reveal` 发起的上报 `null`。
   */
  const landFiltered = useCallback(
    (target: Reveal) => {
      const row = filteredRow(target.path, cacheRef.current, recordsRef.current);
      if (row) {
        land(row, target);
      } else if (!target.notify) {
        endWithoutFile(target, MISSING_FILE);
      } else if (selectedFileRef.current) {
        clearSelection();
        onPathChange(null);
      }
    },
    [clearSelection, endWithoutFile, land, onPathChange, recordsRef],
  );

  /**
   * 把进行中的定位推进到不能再推为止：已加载的层直接走过，树上有行的并展开；遇到未加载的层请求一次
   * 后返回，等列表或失败落地（下面的 effect）再进来，等不到就停在这一级，文案是这一次请求的失败。
   * 走到末级：文件则选中（`reveal` 发起的另上报一次），目录只展开，列表里没有就是 `文件不存在`。
   */
  const continueReveal = useCallback(() => {
    const target = revealRef.current;
    if (!target) {
      return;
    }

    const { entry, expand, unloaded } = revealStep(target.path, cacheRef.current);
    if (onlyPaths?.has(target.path)) {
      revealRef.current = null;
      // 只展开已加载的层：没加载的那一层不请求，展开了它，撤掉 `onlyPaths` 后是一个没有内容的展开行。
      expandDirectories(expand.filter((path) => path !== unloaded));
      landFiltered(target);
      return;
    }
    expandDirectories(expand);
    if (unloaded !== null) {
      if (!awaitDirectory(target, unloaded, expand.includes(unloaded))) {
        revealRef.current = null;
        endWithoutFile(target, failureOf(target, failedDirectoriesRef.current, unloaded));
      }
      return;
    }

    revealRef.current = null;
    if (entry?.type === "file") {
      land(entry, target);
    } else if (entry) {
      openDirectory(target.path, expand);
      endWithoutFile(target, null);
    } else {
      endWithoutFile(target, MISSING_FILE);
    }
  }, [
    awaitDirectory,
    endWithoutFile,
    expandDirectories,
    land,
    landFiltered,
    onlyPaths,
    openDirectory,
  ]);

  // `path` 属性只在变化时生效一次，每次都顶掉进行中的定位。与当前选中逐字相同（点击后宿主送回来的
  // 就是这样）只是放弃它，不看它的写法。其余先过 `normalizedPath`，比的、走的都是之后的写法：与当前
  // 选中相同同样只是放弃；`null` 与去掉空段、点段后什么都不剩的清掉选中；含 `..` 段的同样清掉选中并
  // 显示 `文件不存在`，不定位（因此不为它发请求）；其余换成对它的定位。其后每当目录列表或进行中的
  // 目录请求有变化，推进定位。
  // biome-ignore lint/correctness/useExhaustiveDependencies: `directories` 与 `loadingPaths` 是推进定位的触发条件。
  useEffect(() => {
    if (appliedPathRef.current !== path) {
      appliedPathRef.current = path;
      revealRef.current = null;
      const selected = selectedFileRef.current?.path;
      const target = path === selected ? path : normalizedPath(path ?? "");
      setPathNotice(target === null ? MISSING_FILE : null);
      if (!target) {
        clearSelection();
      } else if (target !== selected) {
        revealRef.current = { asked: new Set(), notify: false, path: target };
      }
    }
    continueReveal();
  }, [clearSelection, continueReveal, directories, loadingPaths, path]);

  // `renderedSeq` 换成新值才生效（挂载时的值不算），排在 `path` 的 effect 之后。选中的不是 `path`（定位
  // 还在走，或没落在文件上）时不动。不经 `selectFile`：源码视图下它会再发一次 `file`。
  const appliedRenderedRef = useRef(renderedSeq);
  useEffect(() => {
    if (appliedRenderedRef.current === renderedSeq) return;
    appliedRenderedRef.current = renderedSeq;
    if (renderedSeq !== undefined && selectedFileRef.current?.path === path) {
      showWebView("rendered");
    }
  }, [path, renderedSeq, showWebView]);

  const folder = useFolderDialog(client, workspaceId, cacheRef, loadDirectory);

  // 刷新。不带参数（`刷新` 按钮）：重取已加载的每一层目录、正显示读取错误的目录（根始终在内，首载
  // 失败后可由此重试）与当前文件。带 `paths`：只重取这些路径的已加载的各级父目录，当前文件在其中
  // 才重取。展开状态、选中与预览模式不动，失败沿用各目录的错误行、旧列表保留。
  const refresh = useCallback(
    (paths?: string[]) => {
      const loaded = loadedDirectoryPaths(cacheRef.current);
      const layers = paths
        ? refreshLayers(cacheRef.current, paths)
        : new Set(["", ...loaded, ...Object.keys(directoryErrors)]);
      for (const path of layers) {
        loadDirectory(path, true);
      }
      const selected = selectedFileRef.current;
      if (selected && (!paths || paths.includes(selected.path))) {
        selectFile(selected.entry, selected.path);
      }
    },
    [directoryErrors, loadDirectory, selectFile],
  );

  const followEntry = useFollowEntry({
    cacheRef,
    clearSelection,
    directoryRequestsRef,
    expandedPathsRef,
    failedDirectoriesRef,
    loadDirectory,
    onPathChange,
    revealRef,
    selectFile,
    selectedFileRef,
    setDirectories,
    setDirectoryErrors,
    setExpandedPaths,
    setLoadingPaths,
  });
  const operations = useEntryOperations(client, workspaceId, followEntry, {
    cacheRef,
    expandedPathsRef,
    focusMenuPath,
    name,
  });

  useImperativeHandle(
    ref,
    () => ({
      refresh,
      reported: pathRecords.reported,
      reveal(path) {
        revealRef.current = { asked: new Set(), notify: true, path };
        continueReveal();
      },
    }),
    [continueReveal, pathRecords.reported, refresh],
  );

  const directoriesForDialog = useMemo(() => loadedDirectoryPaths(directories), [directories]);
  const marks = useMemo(
    () => markedPaths && { label: markedPaths.label, paths: markedRows(markedPaths.paths) },
    [markedPaths],
  );
  // 过滤视图里还成行的路径：已不存在的（`path-records.ts`）不在其中，目录行只由剩下的拼出来。
  const listed = useMemo(
    () => listedPaths(onlyPaths, directories, records),
    [directories, onlyPaths, records],
  );
  const subtree = useMemo(
    () => (listed ? subtreeOf(listed, directories) : null),
    [directories, listed],
  );

  return (
    <>
      <WorkspaceColumns
        creationDisabled={subtreeOnly}
        directory={
          emptyNote(listed, onlyPathsEmpty) ?? (
            <DirectoryTree
              // `onlyPaths` 下没有行菜单：不列目录，改名、移动之后既不能重列也跟不过去。
              actions={subtree ? undefined : operations.actions}
              cache={subtree ? subtree.tree : directories}
              errors={subtree ? NO_ERRORS : directoryErrors}
              expandedPaths={subtree ? subtree.expandedPaths : expandedPaths}
              focusMenuPath={focusMenuPath}
              loadingPaths={subtree ? NO_PATHS : loadingPaths}
              marks={marks}
              onSelectFile={chooseFile}
              // `onlyPaths` 下各级目录恒为展开：不改真实的展开集合，也不列目录。
              onToggleDirectory={subtree ? ignoreToggle : toggleDirectory}
              rootPath={dir === undefined ? undefined : logicalPath(account, dir)}
              selectedPath={selectedFile?.path ?? null}
              workspaceName={name}
            />
          )
        }
        folderNotice={folder.notice ?? operations.notice}
        layout={layout}
        onNewDirectory={folder.open}
        onNewWorkspace={onNewWorkspace}
        onRefresh={() => refresh()}
        preview={
          <PreviewArea
            loading={previewLoading}
            notice={clearMissing ? null : pathNotice}
            onWebViewChange={showWebView}
            previewToken={previewToken}
            selectedFile={selectedFile}
            workspaceId={workspaceId}
          />
        }
        switcher={switcher}
        treeCollapsed={treeCollapsed}
      />
      {folder.dialog ? (
        <DirectoryDialog
          directories={directoriesForDialog}
          error={folder.dialog.error}
          onCancel={folder.close}
          onCreate={folder.create}
          pending={folder.dialog.pending}
          returnFocus={folder.returnFocus}
          workspaceName={name}
        />
      ) : null}
      {operations.dialog}
    </>
  );
}

function ignoreToggle() {}
