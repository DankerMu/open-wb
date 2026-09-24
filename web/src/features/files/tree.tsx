import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../../lib/api.js";
import { CreationMenu, DirectoryDialog } from "./dialogs.js";
import { errorMessage, isUnauthorized } from "./errors.js";
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
  client: ApiClient;
  switcher: ReactNode;
  workspace: Workspace;
  onNewWorkspace(): void;
};

type DirectoryTreeProps = {
  cache: DirectoryCache;
  errors: Record<string, string>;
  expandedPaths: ReadonlySet<string>;
  loadingPaths: ReadonlySet<string>;
  selectedPath: string | null;
  onSelectFile(entry: TreeEntry, path: string): void;
  onToggleDirectory(path: string): void;
};

type DirectoryNodeProps = DirectoryTreeProps & {
  label: string;
  path: string;
};

type PreviewAreaProps = {
  loading: boolean;
  selectedFile: SelectedFile | null;
};

type WorkspaceColumnsProps = {
  directory: ReactNode;
  folderNotice?: string | null;
  onNewDirectory(): void;
  onNewWorkspace(): void;
  preview: ReactNode;
  switcher: ReactNode;
};

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
  label,
  loadingPaths,
  onSelectFile,
  onToggleDirectory,
  path,
  selectedPath,
}: DirectoryNodeProps) {
  const entries = cache[path]?.entries;
  const expanded = expandedPaths.has(path);
  const loading = loadingPaths.has(path);
  const error = errors[path];

  return (
    <li className="files-tree-item">
      <button
        aria-expanded={expanded}
        aria-label={`${expanded ? "折叠" : "展开"} ${label}`}
        className="files-tree-node"
        onClick={() => onToggleDirectory(path)}
        type="button"
      >
        <svg aria-hidden="true" className="files-tree-glyph files-tree-caret" viewBox="0 0 16 16">
          <path d="M4 6l4 5 4-5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <svg aria-hidden="true" className="files-tree-glyph" viewBox="0 0 16 16">
          <path d="M2 4.5h4l1.5 2H14V13H2z" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span className="files-tree-name">{label}</span>
      </button>
      {error ? (
        <p className="ui-alert" role="alert">
          {error}
        </p>
      ) : null}
      {expanded && loading && !entries ? (
        <p className="files-status ui-muted" role="status">
          正在读取目录
        </p>
      ) : null}
      {expanded && entries ? (
        <ul className="files-tree-list">
          {entries.length === 0 ? (
            <li className="files-tree-item">
              <p className="files-tree-folder-empty ui-muted">此文件夹为空</p>
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
                <li className="files-tree-item" key={entryPath}>
                  <button
                    aria-current={selectedPath === entryPath ? "true" : undefined}
                    className={
                      selectedPath === entryPath
                        ? "files-tree-file files-tree-file--selected"
                        : "files-tree-file"
                    }
                    onClick={() => onSelectFile(entry, entryPath)}
                    type="button"
                  >
                    <svg aria-hidden="true" className="files-tree-glyph" viewBox="0 0 16 16">
                      <path
                        d="M5 2h5l4 4v8H5z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                    </svg>
                    <span className="files-tree-name">{entry.name}</span>
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

function DirectoryTree(props: DirectoryTreeProps) {
  return (
    <nav aria-label="工作空间目录树">
      <ul className="files-tree-list">
        <DirectoryNode {...props} label="root" path="" />
      </ul>
    </nav>
  );
}

export function EmptyPreview() {
  return (
    <div className="files-preview-empty ui-empty">
      <p>未选择文件</p>
      <p className="ui-muted">在左侧目录树中选择一个文件进行预览</p>
    </div>
  );
}

export function WorkspaceColumns({
  directory,
  folderNotice,
  onNewDirectory,
  onNewWorkspace,
  preview,
  switcher,
}: WorkspaceColumnsProps) {
  return (
    <div className="files-layout">
      <aside aria-label="工作空间文件" className="files-tree">
        {switcher}
        <div className="files-tree-head">
          <h2>工作空间目录</h2>
          <CreationMenu onNewDirectory={onNewDirectory} onNewWorkspace={onNewWorkspace} />
        </div>
        {folderNotice ? (
          <p className="ui-alert files-notice" role="alert">
            {folderNotice}
          </p>
        ) : null}
        <div className="files-tree-scroll">{directory}</div>
      </aside>
      <section aria-label="文件预览" className="files-preview">
        {preview}
      </section>
    </div>
  );
}

function PreviewArea({ loading, selectedFile }: PreviewAreaProps) {
  if (!selectedFile) {
    return <EmptyPreview />;
  }

  return (
    <div className="files-preview-body">
      {selectedFile.preview ? (
        <PreviewPane
          mtime={selectedFile.entry.mtime}
          name={selectedFile.entry.name}
          path={selectedFile.path}
          preview={selectedFile.preview}
          size={selectedFile.entry.size}
        />
      ) : (
        <p className="files-status ui-muted" role="status">
          正在读取文件
        </p>
      )}
      {loading && selectedFile.preview ? (
        <p className="files-status ui-muted" role="status">
          正在读取文件
        </p>
      ) : null}
    </div>
  );
}

export function WorkspaceBrowser({
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

  const openFolderDialog = useCallback(() => {
    if (!cacheRef.current[""]) {
      setFolderNotice("当前工作空间没有可写目录");
      return;
    }

    folderMutationRef.current?.abort();
    folderMutationRef.current = null;
    folderSequenceRef.current += 1;
    folderDialogIdRef.current = folderSequenceRef.current;
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
            selectedPath={selectedFile?.path ?? null}
          />
        }
        folderNotice={folderNotice}
        onNewDirectory={openFolderDialog}
        onNewWorkspace={onNewWorkspace}
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
        />
      ) : null}
    </>
  );
}
