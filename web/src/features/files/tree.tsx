import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../../lib/api.js";
import { Icon, type IconName } from "../../ui/index.js";
import { ALERT_BOX, EmptyPreview, STATUS_TEXT, WorkspaceColumns } from "./columns.js";
import { DirectoryDialog } from "./dialogs.js";
import { EmptyState } from "./empty-state.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { fileIcon, formatSize, logicalPath } from "./file-meta.js";
import { PreviewPane } from "./preview.js";
import type { DirectoryListing, PreviewState, TreeEntry, Workspace } from "./types.js";

type DirectoryCache = Record<string, DirectoryListing>;

type SelectedFile = {
  entry: TreeEntry;
  path: string;
  preview: PreviewState | null;
};

type FolderDialogState = {
  id: number;
  error: string | null;
  pending: boolean;
};

type WorkspaceBrowserProps = {
  account: string;
  client: ApiClient;
  switcher: ReactNode;
  workspace: Workspace;
  onNewWorkspace(trigger: HTMLElement | null): void;
};

type DirectoryTreeState = {
  cache: DirectoryCache;
  errors: Record<string, string>;
  expandedPaths: ReadonlySet<string>;
  loadingPaths: ReadonlySet<string>;
  selectedPath: string | null;
  onSelectFile(entry: TreeEntry, path: string): void;
  onToggleDirectory(path: string): void;
};

type DirectoryTreeProps = DirectoryTreeState & {
  /** 根行副行：逻辑路径 `<account>/<dir>`。 */
  rootPath: string;
  workspaceName: string;
};

type DirectoryNodeProps = DirectoryTreeState & {
  icon: IconName;
  label: string;
  path: string;
  subline?: string;
};

type PreviewAreaProps = {
  loading: boolean;
  selectedFile: SelectedFile | null;
};

/** 树行（目录与文件同一写法）；选中的文件行由 `aria-current` 着色。 */
const ROW =
  "group/row flex w-full min-w-0 cursor-pointer items-center gap-[0.4rem] rounded-[6px] px-2 py-[0.32rem] text-left text-[0.8rem] leading-[1.35] text-(--wb-text-primary) hover:bg-(--wb-brand-primary-subtle) aria-[current=true]:bg-(--wb-brand-primary-subtle) aria-[current=true]:text-(--wb-brand-primary-deep)";
const GLYPH =
  "inline-flex size-[14px] shrink-0 text-(--wb-text-secondary) group-aria-[current=true]/row:text-(--wb-brand-primary-deep)";
const ROW_NAME = "min-w-0 flex-1 truncate";
/** 行下方的附注（错误、读取中、空目录、根的逻辑路径）与行内文字左对齐。 */
const ROW_NOTE = "mr-2 ml-7";

const previewableExtensions: Record<string, true> = {
  md: true,
  txt: true,
  log: true,
  csv: true,
  json: true,
  js: true,
  ts: true,
  tsx: true,
  html: true,
  png: true,
  jpg: true,
  jpeg: true,
};

function workspacePath(parent: string, name: string) {
  if (parent.length === 0) {
    return name;
  }

  return `${parent}/${name}`;
}

function supportsPreview(name: string) {
  const extensionStart = name.lastIndexOf(".");
  return (
    extensionStart >= 0 &&
    previewableExtensions[name.slice(extensionStart + 1).toLowerCase()] === true
  );
}

function loadedDirectoryPaths(cache: DirectoryCache) {
  if (!cache[""]) {
    return [];
  }

  const paths: string[] = [""];
  const visit = (parent: string) => {
    for (const entry of cache[parent]?.entries ?? []) {
      if (entry.type !== "dir") {
        continue;
      }

      const path = workspacePath(parent, entry.name);
      if (!cache[path]) {
        continue;
      }

      paths.push(path);
      visit(path);
    }
  };
  visit("");
  return paths;
}

function DirectoryNode({
  cache,
  errors,
  expandedPaths,
  icon,
  label,
  loadingPaths,
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

  return (
    <li className="min-w-0">
      <button
        aria-expanded={expanded}
        aria-label={`${expanded ? "折叠" : "展开"} ${label}`}
        className={ROW}
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
                    cache={cache}
                    errors={errors}
                    expandedPaths={expandedPaths}
                    icon="folder"
                    key={entryPath}
                    label={entry.name}
                    loadingPaths={loadingPaths}
                    onSelectFile={onSelectFile}
                    onToggleDirectory={onToggleDirectory}
                    path={entryPath}
                    selectedPath={selectedPath}
                  />
                );
              }

              return (
                <li className="min-w-0" key={entryPath}>
                  <button
                    aria-current={selectedPath === entryPath ? "true" : undefined}
                    className={ROW}
                    onClick={() => onSelectFile(entry, entryPath)}
                    title={entry.name}
                    type="button"
                  >
                    <span className={GLYPH}>
                      <Icon name={fileIcon(entry.name)} size={14} />
                    </span>
                    <span className={ROW_NAME} data-slot="tree-name">
                      {entry.name}
                    </span>
                    <span
                      aria-hidden="true"
                      className="ml-auto flex-none text-[10.5px] whitespace-nowrap text-(--wb-text-tertiary)"
                      data-slot="tree-size"
                    >
                      {formatSize(entry.size)}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </li>
  );
}

function DirectoryTree({ rootPath, workspaceName, ...state }: DirectoryTreeProps) {
  return (
    <nav aria-label="工作空间目录树">
      <ul>
        <DirectoryNode {...state} icon="shield" label={workspaceName} path="" subline={rootPath} />
      </ul>
    </nav>
  );
}

function PreviewArea({ loading, selectedFile }: PreviewAreaProps) {
  if (!selectedFile) {
    return <EmptyPreview />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {selectedFile.preview ? (
        <PreviewPane
          mtime={selectedFile.entry.mtime}
          name={selectedFile.entry.name}
          path={selectedFile.path}
          preview={selectedFile.preview}
          size={selectedFile.entry.size}
        />
      ) : (
        <p className={STATUS_TEXT} role="status">
          正在读取文件
        </p>
      )}
      {loading && selectedFile.preview ? (
        <p className={STATUS_TEXT} role="status">
          正在读取文件
        </p>
      ) : null}
    </div>
  );
}

export function WorkspaceBrowser({
  account,
  client,
  onNewWorkspace,
  switcher,
  workspace,
}: WorkspaceBrowserProps) {
  const [directories, setDirectories] = useState<DirectoryCache>({});
  const [directoryErrors, setDirectoryErrors] = useState<Record<string, string>>({});
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set([""]));
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set());
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const cacheRef = useRef<DirectoryCache>({});
  const directoryRequestsRef = useRef(new Map<string, AbortController>());
  const expandedPathsRef = useRef<ReadonlySet<string>>(new Set([""]));
  const folderDialogIdRef = useRef<number | null>(null);
  const folderMutationRef = useRef<AbortController | null>(null);
  const folderReturnFocusRef = useRef<HTMLElement | null>(null);
  const folderSequenceRef = useRef(0);
  const mountedRef = useRef(false);
  const ownedImageUrlRef = useRef<string | null>(null);
  const previewRequestRef = useRef(0);
  const previewControllerRef = useRef<AbortController | null>(null);
  const selectedFileRef = useRef<SelectedFile | null>(null);

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
      if (!refresh && cacheRef.current[path]) {
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
        .listTree(workspace.id, path, { signal: controller.signal })
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
    [client, workspace.id],
  );

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      for (const controller of directoryRequestsRef.current.values()) {
        controller.abort();
      }
      directoryRequestsRef.current.clear();
      folderDialogIdRef.current = null;
      folderMutationRef.current?.abort();
      folderMutationRef.current = null;
      previewRequestRef.current += 1;
      previewControllerRef.current?.abort();
      previewControllerRef.current = null;
      releaseOwnedImage();
    };
  }, [releaseOwnedImage]);

  useEffect(() => {
    loadDirectory("");
  }, [loadDirectory]);

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
      if (!supportsPreview(entry.name)) {
        publishSelectedFile({ ...next, preview: { status: "unsupported" } });
        setPreviewLoading(false);
        return;
      }

      publishSelectedFile(next);
      setPreviewLoading(true);
      const controller = new AbortController();
      previewControllerRef.current = controller;
      void client
        .fetchPreview(workspace.id, path, { signal: controller.signal })
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
          publishSelectedFile({
            ...current,
            preview: { status: "error", message: errorMessage(error) },
          });
          setPreviewLoading(false);
        })
        .finally(() => {
          if (previewControllerRef.current === controller) {
            previewControllerRef.current = null;
          }
        });
    },
    [client, publishSelectedFile, releaseOwnedImage, workspace.id],
  );

  const closeFolderDialog = useCallback(() => {
    folderDialogIdRef.current = null;
    folderMutationRef.current?.abort();
    folderMutationRef.current = null;
    setFolderDialog(null);
  }, []);

  const openFolderDialog = useCallback((trigger: HTMLElement | null) => {
    if (!cacheRef.current[""]) {
      setFolderNotice("当前工作空间没有可写目录");
      return;
    }

    folderMutationRef.current?.abort();
    folderMutationRef.current = null;
    folderSequenceRef.current += 1;
    folderDialogIdRef.current = folderSequenceRef.current;
    folderReturnFocusRef.current = trigger;
    setFolderNotice(null);
    setFolderDialog({ id: folderSequenceRef.current, error: null, pending: false });
  }, []);

  const createDirectory = useCallback(
    (parent: string, name: string) => {
      const dialogId = folderDialogIdRef.current;
      if (dialogId === null || folderMutationRef.current) {
        return;
      }

      const controller = new AbortController();
      folderMutationRef.current = controller;
      setFolderDialog((current) =>
        current?.id === dialogId ? { ...current, error: null, pending: true } : current,
      );
      void client
        .createDir(workspace.id, workspacePath(parent, name), { signal: controller.signal })
        .then(() => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            folderDialogIdRef.current !== dialogId
          ) {
            return;
          }

          folderDialogIdRef.current = null;
          folderMutationRef.current = null;
          setFolderDialog(null);
          loadDirectory(parent, true);
        })
        .catch((error: unknown) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            folderDialogIdRef.current !== dialogId ||
            isUnauthorized(error)
          ) {
            return;
          }

          folderMutationRef.current = null;
          const message =
            error instanceof ApiError && error.status === 409
              ? "该目录下已存在同名条目"
              : errorMessage(error);
          setFolderDialog((current) =>
            current?.id === dialogId ? { ...current, error: message, pending: false } : current,
          );
        });
    },
    [client, loadDirectory, workspace.id],
  );

  // 手动刷新：重取已加载的每一层目录、正显示读取错误的目录（根始终在内，首载失败后可由此重试）
  // 与当前文件；展开状态、选中与预览模式不动，失败沿用各目录的错误行、旧列表保留。
  const refresh = useCallback(() => {
    const loaded = loadedDirectoryPaths(cacheRef.current);
    for (const path of new Set(["", ...loaded, ...Object.keys(directoryErrors)])) {
      loadDirectory(path, true);
    }
    const selected = selectedFileRef.current;
    if (selected) {
      selectFile(selected.entry, selected.path);
    }
  }, [directoryErrors, loadDirectory, selectFile]);

  const directoriesForDialog = useMemo(() => loadedDirectoryPaths(directories), [directories]);

  return (
    <>
      <WorkspaceColumns
        directory={
          <DirectoryTree
            cache={directories}
            errors={directoryErrors}
            expandedPaths={expandedPaths}
            loadingPaths={loadingPaths}
            onSelectFile={selectFile}
            onToggleDirectory={toggleDirectory}
            rootPath={logicalPath(account, workspace.dir)}
            selectedPath={selectedFile?.path ?? null}
            workspaceName={workspace.name}
          />
        }
        folderNotice={folderNotice}
        onNewDirectory={openFolderDialog}
        onNewWorkspace={onNewWorkspace}
        onRefresh={refresh}
        preview={<PreviewArea loading={previewLoading} selectedFile={selectedFile} />}
        switcher={switcher}
      />
      {folderDialog ? (
        <DirectoryDialog
          directories={directoriesForDialog}
          error={folderDialog.error}
          onCancel={closeFolderDialog}
          onCreate={createDirectory}
          pending={folderDialog.pending}
          returnFocus={folderReturnFocusRef}
          workspaceName={workspace.name}
        />
      ) : null}
    </>
  );
}
