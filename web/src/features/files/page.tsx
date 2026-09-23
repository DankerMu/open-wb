import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError } from "../../lib/api.js";
import { useAuth } from "../auth/index.js";
import { WorkspaceDialog } from "./dialogs.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { EmptyPreview, WorkspaceBrowser, WorkspaceColumns } from "./tree.js";
import type { Workspace } from "./types.js";

type WorkspaceListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; workspaces: Workspace[] };

type WorkspaceDialogState = {
  id: number;
  error: string | null;
  location: string;
  pending: boolean;
};

type WorkspaceSwitcherProps = {
  currentWorkspace: Workspace | null;
  workspaces: readonly Workspace[];
  onCreateWorkspace(): void;
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

function WorkspaceSwitcher({
  currentWorkspace,
  onCreateWorkspace,
  onSelectWorkspace,
  workspaces,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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
    <div style={{ overflowWrap: "anywhere" }}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="选择工作空间"
        onClick={() => setOpen((current) => !current)}
        style={{ boxSizing: "border-box", maxWidth: "100%", textAlign: "left" }}
        type="button"
      >
        <strong>{currentWorkspace?.name ?? "未选择工作空间"}</strong>
        <span>{currentWorkspace?.root ?? "—"}</span>
      </button>
      {open ? (
        <div
          aria-label="工作空间切换器"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
          role="dialog"
          style={{ border: "1px solid currentColor", marginTop: "0.5rem", padding: "0.75rem" }}
        >
          <label>
            搜索工作空间
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索工作空间"
              value={query}
            />
          </label>
          <ul>
            {filteredWorkspaces.map((workspace) => {
              const current = workspace.id === currentWorkspace?.id;
              return (
                <li key={workspace.id}>
                  <button
                    aria-pressed={current}
                    onClick={() => {
                      setOpen(false);
                      onSelectWorkspace(workspace.id);
                    }}
                    type="button"
                  >
                    <strong>{workspace.name}</strong>
                    <span>{workspace.root}</span>
                    {current ? (
                      <span aria-label="当前工作空间" role="img">
                        ✓
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {filteredWorkspaces.length === 0 ? <p>没有匹配的工作空间</p> : null}
          <button
            onClick={() => {
              setOpen(false);
              onCreateWorkspace();
            }}
            type="button"
          >
            ＋ 新建工作空间
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EmptyWorkspace({
  onNewDirectory,
  onNewWorkspace,
  switcher,
}: {
  onNewDirectory(): void;
  onNewWorkspace(): void;
  switcher: ReactNode;
}) {
  return (
    <WorkspaceColumns
      directory={
        <>
          <p>该工作空间暂无目录</p>
          <p>点击左上角 ＋ 新建文件夹，或挂载本服务器/外部服务器目录</p>
        </>
      }
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

        setListState({ status: "success", workspaces });
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
    };
  }, [client]);

  useEffect(() => {
    const dialog = workspaceDialogRef.current;
    if (dialog && dialog.location !== locationKey) {
      closeWorkspaceDialog();
    }
  }, [closeWorkspaceDialog, locationKey]);

  const requestedWorkspaceId = new URLSearchParams(location.search).get("ws");
  const currentWorkspace =
    listState.status === "success"
      ? (listState.workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ??
        listState.workspaces[0] ??
        null)
      : null;
  const urlMatchesWorkspace = currentWorkspace
    ? requestedWorkspaceId === currentWorkspace.id
    : requestedWorkspaceId === null;

  useEffect(() => {
    if (listState.status !== "success" || urlMatchesWorkspace) {
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
    listState.status,
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

  const openWorkspaceDialog = useCallback(() => {
    workspaceSequenceRef.current += 1;
    const dialog = {
      id: workspaceSequenceRef.current,
      error: null,
      location: locationKey,
      pending: false,
    };
    workspaceDialogRef.current = dialog;
    setWorkspaceDialog(dialog);
  }, [locationKey]);

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
              ? { status: "success", workspaces: [...current.workspaces, workspace] }
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

  const switcher =
    listState.status === "success" ? (
      <WorkspaceSwitcher
        currentWorkspace={currentWorkspace}
        onCreateWorkspace={openWorkspaceDialog}
        onSelectWorkspace={selectWorkspace}
        workspaces={listState.workspaces}
      />
    ) : null;

  return (
    <section>
      <h1>工作空间</h1>
      {listState.status === "loading" ? <p role="status">正在读取工作空间</p> : null}
      {listState.status === "error" ? <p role="alert">{listState.message}</p> : null}
      {listState.status === "success" && currentWorkspace && urlMatchesWorkspace ? (
        <WorkspaceBrowser
          client={client}
          key={currentWorkspace.id}
          onNewWorkspace={openWorkspaceDialog}
          switcher={switcher}
          workspace={currentWorkspace}
        />
      ) : null}
      {listState.status === "success" && !currentWorkspace && urlMatchesWorkspace ? (
        <>
          <EmptyWorkspace
            onNewDirectory={() => setEmptyFolderError("当前工作空间没有可写目录")}
            onNewWorkspace={openWorkspaceDialog}
            switcher={switcher}
          />
          {emptyFolderError ? <p role="alert">{emptyFolderError}</p> : null}
        </>
      ) : null}
      {workspaceDialog ? (
        <WorkspaceDialog
          error={workspaceDialog.error}
          onCancel={closeWorkspaceDialog}
          onCreate={createWorkspace}
          pending={workspaceDialog.pending}
        />
      ) : null}
    </section>
  );
}
