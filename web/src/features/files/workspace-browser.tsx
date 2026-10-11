/**
 * `WorkspaceBrowser`: one workspace's directory tree, preview and the requests behind them. The
 * files page wraps it; nothing in here knows about the address or the router.
 *
 * - Current path: `path` is applied when it changes — the unloaded parent directories are listed
 *   one level at a time and expanded, then a file is selected (one `file` request) and a directory
 *   only expanded. A level that fails or lacks the next name ends the walk there. A selection made
 *   this way is not reported; a click and `reveal` report through `onPathChange` once the file is
 *   found.
 * - `onlyPaths`: the tree is built from those paths (`subtreeOf`) and neither the listing cache
 *   nor the expanded set is written, so both are back when it is dropped. `loadDirectory` returns
 *   without a request while it is set: tests pin that for `refresh`, for a walk (it ends at the
 *   first unloaded level) and for mounting; the re-listing after creating a folder goes through the
 *   same gate (read from the code, no test). Dropping it requests the root if that was never loaded
 *   and replays nothing else.
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
  refreshLayers,
  revealStep,
  subtreeOf,
} from "./browser-paths.js";
import { type BrowserLayout, WorkspaceColumns } from "./columns.js";
import { DirectoryDialog } from "./dialogs.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { logicalPath } from "./file-meta.js";
import { useFolderDialog } from "./folder-dialog.js";
import { failedPreview, immediatePreview, PreviewArea, type SelectedFile } from "./preview-area.js";
import { DirectoryTree } from "./tree.js";
import type { TreeEntry } from "./types.js";

/** 进行中的定位：`asked` 是这一次已经请求过的目录，请求过仍没有列表即失败。 */
type Reveal = { asked: Set<string>; notify: boolean; path: string };

export type WorkspaceBrowserHandle = {
  /** 逐级展开到 `path` 并选中；`view` 目前没有消费方。 */
  reveal(path: string, options?: { view?: "rendered" }): void;
  /** 重取已加载的目录：给了 `paths` 只取它们的各级父目录，当前文件在其中才重取预览。 */
  refresh(paths?: string[]): void;
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
  onPathChange(path: string): void;
  layout?: BrowserLayout | undefined;
  markedPaths?: { label: string; paths: ReadonlySet<string> } | undefined;
  onlyPaths?: ReadonlySet<string> | undefined;
  ref?: Ref<WorkspaceBrowserHandle> | undefined;
  /** 文件页专用：切换器与 `新建工作空间`。 */
  switcher?: ReactNode;
  onNewWorkspace?: ((trigger: HTMLElement | null) => void) | undefined;
};

const NO_PATHS: ReadonlySet<string> = new Set();
const NO_ERRORS: Record<string, string> = {};

export function WorkspaceBrowser({
  account,
  client,
  dir,
  layout,
  markedPaths,
  name = "工作空间",
  onNewWorkspace,
  onPathChange,
  onlyPaths,
  path,
  ref,
  switcher,
  workspaceId,
}: WorkspaceBrowserProps) {
  const [directories, setDirectories] = useState<DirectoryCache>({});
  const [directoryErrors, setDirectoryErrors] = useState<Record<string, string>>({});
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set([""]));
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set());
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const appliedPathRef = useRef<string | null | undefined>(undefined);
  const cacheRef = useRef<DirectoryCache>({});
  const directoryRequestsRef = useRef(new Map<string, AbortController>());
  const expandedPathsRef = useRef<ReadonlySet<string>>(new Set([""]));
  const mountedRef = useRef(false);
  const ownedImageUrlRef = useRef<string | null>(null);
  const previewRequestRef = useRef(0);
  const previewControllerRef = useRef<AbortController | null>(null);
  const revealRef = useRef<Reveal | null>(null);
  const selectedFileRef = useRef<SelectedFile | null>(null);
  const subtreeOnly = onlyPaths !== undefined;

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

  const loadDirectory = useCallback(
    (path: string, refresh = false) => {
      if (subtreeOnly || (!refresh && cacheRef.current[path])) {
        return;
      }

      const inFlight = directoryRequestsRef.current.get(path);
      if (inFlight) {
        if (!refresh) {
          return;
        }
        inFlight.abort();
        directoryRequestsRef.current.delete(path);
      }

      const controller = new AbortController();
      directoryRequestsRef.current.set(path, controller);
      setLoadingPaths((current) => new Set(current).add(path));
      setDirectoryErrors((current) => {
        if (!current[path]) {
          return current;
        }

        const next = { ...current };
        delete next[path];
        return next;
      });

      void client
        .listTree(workspaceId, path, { signal: controller.signal })
        .then((listing) => {
          if (!mountedRef.current || controller.signal.aborted) {
            return;
          }

          cacheRef.current = { ...cacheRef.current, [path]: listing };
          setDirectories(cacheRef.current);
        })
        .catch((error: unknown) => {
          if (!mountedRef.current || controller.signal.aborted || isUnauthorized(error)) {
            return;
          }

          setDirectoryErrors((current) => ({ ...current, [path]: errorMessage(error) }));
        })
        .finally(() => {
          if (directoryRequestsRef.current.get(path) !== controller) {
            return;
          }

          directoryRequestsRef.current.delete(path);
          if (mountedRef.current) {
            setLoadingPaths((current) => {
              const next = new Set(current);
              next.delete(path);
              return next;
            });
          }
        });
    },
    [client, subtreeOnly, workspaceId],
  );

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

  const selectFile = useCallback(
    (entry: TreeEntry, path: string) => {
      previewRequestRef.current += 1;
      previewControllerRef.current?.abort();
      previewControllerRef.current = null;
      const request = previewRequestRef.current;
      const previous = selectedFileRef.current;
      const sameFile = previous?.path === path;
      const next: SelectedFile =
        sameFile && previous ? { ...previous, entry, path } : { entry, path, preview: null };

      if (!sameFile) {
        releaseOwnedImage();
      }

      // 不发 `file` 请求的类别在这里交付：上一个请求已中止，换了文件时旧图片也已释放，没有新请求要管。
      const immediate = immediatePreview(entry, fileUrl(workspaceId, path));
      if (immediate) {
        publishSelectedFile({ entry, path, preview: immediate });
        setPreviewLoading(false);
        return;
      }

      publishSelectedFile(next);
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
          publishSelectedFile({ ...current, preview: { status: "success", data: preview } });
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

          releaseOwnedImage();
          publishSelectedFile({ ...current, preview: failedPreview(error) });
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
    [client, publishSelectedFile, releaseOwnedImage, workspaceId],
  );

  /** 点击文件行：放弃进行中的定位，选中并上报。点已选中的文件照样重取预览。 */
  const chooseFile = useCallback(
    (entry: TreeEntry, path: string) => {
      revealRef.current = null;
      selectFile(entry, path);
      onPathChange(path);
    },
    [onPathChange, selectFile],
  );

  /** 定位遇到未加载的层：请求进行中就等；这一次还没请求过就请求并等；否则（失败过，或 `onlyPaths` 下）不等。 */
  const awaitDirectory = useCallback(
    (target: Reveal, directory: string) => {
      if (directoryRequestsRef.current.has(directory)) {
        return true;
      }
      if (subtreeOnly || target.asked.has(directory)) {
        return false;
      }

      target.asked.add(directory);
      loadDirectory(directory);
      return true;
    },
    [loadDirectory, subtreeOnly],
  );

  /**
   * 把进行中的定位推进到不能再推为止：已加载的层直接走过并展开；遇到未加载的层请求一次后返回，
   * 等列表或失败落地（下面的 effect）再进来，等不到就停在这一级。
   * 走到末级：文件则选中（`reveal` 发起的另上报一次），目录只展开，列表里没有就什么都不做。
   */
  const continueReveal = useCallback(() => {
    const target = revealRef.current;
    if (!target) {
      return;
    }

    const { entry, expand, unloaded } = revealStep(target.path, cacheRef.current);
    expandDirectories(expand);
    if (unloaded !== null) {
      if (awaitDirectory(target, unloaded)) {
        return;
      }
    } else if (entry?.type === "file") {
      selectFile(entry, target.path);
      if (target.notify) {
        onPathChange(target.path);
      }
    } else if (entry) {
      expandDirectories([target.path]);
      loadDirectory(target.path);
    }
    revealRef.current = null;
  }, [awaitDirectory, expandDirectories, loadDirectory, onPathChange, selectFile]);

  // `path` 属性只在变化时生效一次，每次都顶掉进行中的定位：与当前选中相同就只是放弃它，`null` 另清掉
  // 选中，其余换成对 `path` 的定位。其后每当目录列表或进行中的目录请求有变化，推进定位。
  // biome-ignore lint/correctness/useExhaustiveDependencies: `directories` 与 `loadingPaths` 是推进定位的触发条件。
  useEffect(() => {
    if (appliedPathRef.current !== path) {
      appliedPathRef.current = path;
      if (path === null) {
        revealRef.current = null;
        if (selectedFileRef.current) {
          previewRequestRef.current += 1;
          previewControllerRef.current?.abort();
          previewControllerRef.current = null;
          releaseOwnedImage();
          publishSelectedFile(null);
          setPreviewLoading(false);
        }
      } else {
        revealRef.current =
          selectedFileRef.current?.path === path ? null : { asked: new Set(), notify: false, path };
      }
    }
    continueReveal();
  }, [continueReveal, directories, loadingPaths, path, publishSelectedFile, releaseOwnedImage]);

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

  useImperativeHandle(
    ref,
    () => ({
      refresh,
      reveal(path) {
        revealRef.current = { asked: new Set(), notify: true, path };
        continueReveal();
      },
    }),
    [continueReveal, refresh],
  );

  const directoriesForDialog = useMemo(() => loadedDirectoryPaths(directories), [directories]);
  const marks = useMemo(
    () => markedPaths && { label: markedPaths.label, paths: markedRows(markedPaths.paths) },
    [markedPaths],
  );
  const subtree = useMemo(
    () => (onlyPaths ? subtreeOf(onlyPaths, directories) : null),
    [directories, onlyPaths],
  );

  return (
    <>
      <WorkspaceColumns
        directory={
          <DirectoryTree
            cache={subtree ? subtree.tree : directories}
            errors={subtree ? NO_ERRORS : directoryErrors}
            expandedPaths={subtree ? subtree.expandedPaths : expandedPaths}
            loadingPaths={subtree ? NO_PATHS : loadingPaths}
            marks={marks}
            onSelectFile={chooseFile}
            // `onlyPaths` 下各级目录恒为展开：不改真实的展开集合，也不列目录。
            onToggleDirectory={subtree ? ignoreToggle : toggleDirectory}
            rootPath={dir === undefined ? undefined : logicalPath(account, dir)}
            selectedPath={selectedFile?.path ?? null}
            workspaceName={name}
          />
        }
        folderNotice={folder.notice}
        layout={layout}
        onNewDirectory={folder.open}
        onNewWorkspace={onNewWorkspace}
        onRefresh={() => refresh()}
        preview={
          <PreviewArea
            loading={previewLoading}
            selectedFile={selectedFile}
            workspaceId={workspaceId}
          />
        }
        switcher={switcher}
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
    </>
  );
}

function ignoreToggle() {}
