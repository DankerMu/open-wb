import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { type ApiClient, ApiError } from "../../lib/api.js";
import { EmptyState, Popover } from "../../ui/index.js";
import { useAuth } from "../auth/index.js";
import { WorkspaceDialog } from "./dialogs.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { EmptyPreview, WorkspaceBrowser, WorkspaceColumns } from "./tree.js";
import type { Workspace } from "./types.js";

type WorkspaceListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; client: ApiClient; workspaces: Workspace[] };

type WorkspaceDialogState = {
  id: number;
  error: string | null;
  location: string;
  pending: boolean;
};

type WorkspaceSwitcherProps = {
  currentWorkspace: Workspace | null;
  workspaces: readonly Workspace[];
  /** 回调带上切换器触发器，供对话框在取消类关闭后把焦点还给它。 */
  onCreateWorkspace(trigger: HTMLElement | null): void;
  onSelectWorkspace(id: string): void;
};

function workspaceNavigation(
  pathname: string,
  search: string,
  hash: string,
  workspaceId: string | null,
) {
  const parameters = new URLSearchParams(search);
  if (workspaceId) {
    parameters.set("ws", workspaceId);
  } else {
    parameters.delete("ws");
  }

  const nextSearch = parameters.toString();
  return { hash, pathname, search: nextSearch.length === 0 ? "" : `?${nextSearch}` };
}

function currentWorkspaceFromList(
  listForClient: Extract<WorkspaceListState, { status: "success" }> | null,
  requestedWorkspaceId: string | null,
) {
  if (!listForClient) {
    return null;
  }

  return (
    listForClient.workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ??
    listForClient.workspaces[0] ??
    null
  );
}

function WorkspaceSwitcher({
  currentWorkspace,
  onCreateWorkspace,
  onSelectWorkspace,
  workspaces,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filteredWorkspaces = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) {
      return workspaces;
    }

    return workspaces.filter((workspace) =>
      workspace.name.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [query, workspaces]);

  return (
    <div className="files-switcher">
      <Popover
        contentLabel="工作空间切换器"
        onOpenChange={setOpen}
        open={open}
        trigger={
          <button
            aria-label="选择工作空间"
            className="files-switcher-trigger"
            ref={triggerRef}
            type="button"
          >
            <span className="files-switcher-copy">
              <strong>{currentWorkspace?.name ?? "未选择工作空间"}</strong>
              <span>{currentWorkspace?.root ?? "—"}</span>
            </span>
          </button>
        }
      >
        <div className="files-switcher-panel">
          <label className="files-switcher-search">
            搜索工作空间
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索工作空间"
              value={query}
            />
          </label>
          <ul className="files-switcher-list">
            {filteredWorkspaces.map((workspace) => {
              const current = workspace.id === currentWorkspace?.id;
              return (
                <li key={workspace.id}>
                  <button
                    aria-pressed={current}
                    className="files-switcher-item"
                    onClick={() => {
                      setOpen(false);
                      onSelectWorkspace(workspace.id);
                    }}
                    type="button"
                  >
                    <span className="files-switcher-item-copy">
                      <strong>{workspace.name}</strong>
                      <span>{workspace.root}</span>
                    </span>
                    {current ? (
                      <span aria-label="当前工作空间" className="files-switcher-check" role="img">
                        ✓
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {filteredWorkspaces.length === 0 ? (
            <p className="files-switcher-empty ui-muted">没有匹配的工作空间</p>
          ) : null}
          <button
            className="ui-button"
            onClick={() => {
              setOpen(false);
              onCreateWorkspace(triggerRef.current);
            }}
            type="button"
          >
            ＋ 新建工作空间
          </button>
        </div>
      </Popover>
    </div>
  );
}

function EmptyWorkspace({
  folderNotice,
  onNewDirectory,
  onNewWorkspace,
  switcher,
}: {
  folderNotice?: string | null;
  onNewDirectory(): void;
  onNewWorkspace(trigger: HTMLElement | null): void;
  switcher: ReactNode;
}) {
  return (
    <WorkspaceColumns
      directory={
        <EmptyState description="使用左上角 ＋ 新建工作空间" title="先选择或创建工作空间" />
      }
      folderNotice={folderNotice ?? null}
      onNewDirectory={onNewDirectory}
      onNewWorkspace={onNewWorkspace}
      preview={<EmptyPreview />}
      switcher={switcher}
    />
  );
}

export function FilesPage() {
  const { createSessionClient } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  const location = useLocation();
  const navigate = useNavigate();
  const locationKey = `${location.pathname}${location.search}${location.hash}`;
  const [emptyFolderError, setEmptyFolderError] = useState<string | null>(null);
  const [listState, setListState] = useState<WorkspaceListState>({ status: "loading" });
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialogState | null>(null);
  const listSequenceRef = useRef(0);
  const mountedRef = useRef(false);
  const workspaceDialogRef = useRef<WorkspaceDialogState | null>(null);
  const workspaceReturnFocusRef = useRef<HTMLElement | null>(null);
  const workspaceMutationRef = useRef<AbortController | null>(null);
  const workspaceSequenceRef = useRef(0);

  const closeWorkspaceDialog = useCallback(() => {
    workspaceDialogRef.current = null;
    workspaceMutationRef.current?.abort();
    workspaceMutationRef.current = null;
    setWorkspaceDialog(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      workspaceDialogRef.current = null;
      workspaceMutationRef.current?.abort();
      workspaceMutationRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    listSequenceRef.current += 1;
    const request = listSequenceRef.current;
    setListState({ status: "loading" });
    void client
      .listWorkspaces({ signal: controller.signal })
      .then(({ workspaces }) => {
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          request !== listSequenceRef.current
        ) {
          return;
        }

        setListState({ status: "success", client, workspaces });
      })
      .catch((error: unknown) => {
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          request !== listSequenceRef.current ||
          isUnauthorized(error)
        ) {
          return;
        }

        setListState({ status: "error", message: errorMessage(error) });
      });

    return () => {
      controller.abort();
      closeWorkspaceDialog();
    };
  }, [client, closeWorkspaceDialog]);

  useEffect(() => {
    const dialog = workspaceDialogRef.current;
    if (dialog && dialog.location !== locationKey) {
      closeWorkspaceDialog();
    }
  }, [closeWorkspaceDialog, locationKey]);

  const listForClient =
    listState.status === "success" && listState.client === client ? listState : null;
  const requestedWorkspaceId = new URLSearchParams(location.search).get("ws");
  const currentWorkspace = currentWorkspaceFromList(listForClient, requestedWorkspaceId);
  const urlMatchesWorkspace = currentWorkspace
    ? requestedWorkspaceId === currentWorkspace.id
    : requestedWorkspaceId === null;

  useEffect(() => {
    if (!listForClient || urlMatchesWorkspace) {
      return;
    }

    navigate(
      workspaceNavigation(
        location.pathname,
        location.search,
        location.hash,
        currentWorkspace?.id ?? null,
      ),
      { replace: true },
    );
  }, [
    currentWorkspace?.id,
    listForClient,
    location.hash,
    location.pathname,
    location.search,
    navigate,
    urlMatchesWorkspace,
  ]);

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      closeWorkspaceDialog();
      setEmptyFolderError(null);
      navigate(workspaceNavigation(location.pathname, location.search, location.hash, workspaceId));
    },
    [closeWorkspaceDialog, location.hash, location.pathname, location.search, navigate],
  );

  const openWorkspaceDialog = useCallback(
    (trigger: HTMLElement | null) => {
      workspaceReturnFocusRef.current = trigger;
      workspaceMutationRef.current?.abort();
      workspaceMutationRef.current = null;
      workspaceSequenceRef.current += 1;
      const dialog = {
        id: workspaceSequenceRef.current,
        error: null,
        location: locationKey,
        pending: false,
      };
      workspaceDialogRef.current = dialog;
      setWorkspaceDialog(dialog);
    },
    [locationKey],
  );

  const createWorkspace = useCallback(
    (input: { name: string; dir?: string }) => {
      const dialog = workspaceDialogRef.current;
      if (!dialog || workspaceMutationRef.current) {
        return;
      }

      const controller = new AbortController();
      workspaceMutationRef.current = controller;
      const pendingDialog = { ...dialog, error: null, pending: true };
      workspaceDialogRef.current = pendingDialog;
      setWorkspaceDialog(pendingDialog);
      void client
        .createWorkspace(input, { signal: controller.signal })
        .then((workspace) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            workspaceDialogRef.current?.id !== dialog.id
          ) {
            return;
          }

          workspaceDialogRef.current = null;
          workspaceMutationRef.current = null;
          setWorkspaceDialog(null);
          setListState((current) =>
            current.status === "success"
              ? {
                  status: "success",
                  client: current.client,
                  workspaces: [...current.workspaces, workspace],
                }
              : current,
          );
          navigate(
            workspaceNavigation(location.pathname, location.search, location.hash, workspace.id),
          );
        })
        .catch((error: unknown) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            workspaceDialogRef.current?.id !== dialog.id ||
            isUnauthorized(error)
          ) {
            return;
          }

          workspaceMutationRef.current = null;
          const message =
            error instanceof ApiError && error.status === 409
              ? "同名工作空间已存在"
              : errorMessage(error);
          const failedDialog = { ...dialog, error: message, pending: false };
          workspaceDialogRef.current = failedDialog;
          setWorkspaceDialog(failedDialog);
        });
    },
    [client, location.hash, location.pathname, location.search, navigate],
  );

  const switcher = listForClient ? (
    <WorkspaceSwitcher
      currentWorkspace={currentWorkspace}
      onCreateWorkspace={openWorkspaceDialog}
      onSelectWorkspace={selectWorkspace}
      workspaces={listForClient.workspaces}
    />
  ) : null;

  return (
    <section className="files-page">
      {listForClient ? null : listState.status === "error" ? (
        <p className="ui-alert" role="alert">
          {listState.message}
        </p>
      ) : (
        <p className="files-status ui-muted" role="status">
          正在读取工作空间
        </p>
      )}
      {listForClient && currentWorkspace && urlMatchesWorkspace ? (
        <WorkspaceBrowser
          client={client}
          key={currentWorkspace.id}
          onNewWorkspace={openWorkspaceDialog}
          switcher={switcher}
          workspace={currentWorkspace}
        />
      ) : null}
      {listForClient && !currentWorkspace && urlMatchesWorkspace ? (
        <EmptyWorkspace
          folderNotice={emptyFolderError}
          onNewDirectory={() => setEmptyFolderError("当前工作空间没有可写目录")}
          onNewWorkspace={openWorkspaceDialog}
          switcher={switcher}
        />
      ) : null}
      {workspaceDialog ? (
        <WorkspaceDialog
          error={workspaceDialog.error}
          onCancel={closeWorkspaceDialog}
          onCreate={createWorkspace}
          pending={workspaceDialog.pending}
          returnFocus={workspaceReturnFocusRef}
        />
      ) : null}
    </section>
  );
}
