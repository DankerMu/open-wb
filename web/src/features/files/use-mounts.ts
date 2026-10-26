/**
 * The mounts of the workspace `WorkspaceBrowser` shows (workspace-mounts「挂载根行」, design D18).
 *
 * - The list: one `GET …/mounts` when the workspace is entered (a new `workspaceId` included — the
 *   session sidebar keeps the browser across workspaces), and again on `refetch`: the browser's `刷新`
 *   button and a successful unmount call it. Nothing else does — no polling, no refetch after an
 *   expand, a selection or an entry operation, nor on the handle's `refresh` (the session sidebar
 *   calls that after the assistant's steps; D18's `刷新` is the button). A failed `GET` drops the
 *   rows and leaves its envelope message in `error` (none for a 401: the login layer's).
 * - The rows' data is that list alone: the root `tree` does not list mount points (D21) and nothing
 *   here filters it. Registered mounts are shown whether or not `enabled` is true (an offline row can
 *   still be unmounted).
 * - `preview(selected)`: `inMount` is whether the first segment of the selected path is a mount's
 *   name (a directory whose name merely starts with one is not inside it) — the browser hands it to
 *   the preview area as「在挂载内」; `framed` is the preview that needs the preview token (a web page,
 *   a PDF or an office document) when not inside a mount, `null` otherwise: no token is issued or
 *   renewed for a file inside a mount (file-previewers「挂载内文件不签发」).
 * - Loaded directories: `loadedDirectoryPaths` walks from the root's listing, which never names a
 *   mount, so the directories under mounts are added here, walking each mount's listings the same
 *   way. `loaded(cache)` adds those of the online mounts (what `refresh` lists again);
 *   `dialogDirectories` (the `位置` dropdown) only those of online mounts that are not read-only.
 * - Unmount: `useRequestDialog` holds the confirmation. Confirming sends one `DELETE …/mounts/<id>`;
 *   on 204 the row goes at once, `onSelectionInside` is called when the selected file is inside that
 *   mount, and the list is fetched again. A failure keeps the dialog open with the envelope message.
 */
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, MountList, MountView } from "../../lib/api.js";
import {
  type DirectoryCache,
  loadedDirectoryPaths,
  ownValue,
  workspacePath,
} from "./browser-paths.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { useRequestDialog } from "./request-dialog.js";
import type { PreviewState } from "./types.js";

type Fetched = {
  client: ApiClient;
  workspaceId: string;
  list: MountList | null;
  error: string | null;
};

const NO_MOUNTS: readonly MountView[] = [];

/** First segment of a workspace path (the whole path when it has no `/`). */
function firstSegment(path: string) {
  const slash = path.indexOf("/");
  return slash < 0 ? path : path.slice(0, slash);
}

/** `root` and the directories below it whose listings are loaded, walking from `root` down. */
function loadedUnder(cache: DirectoryCache, root: string): string[] {
  if (!ownValue(cache, root)) {
    return [];
  }

  const paths = [root];
  const visit = (parent: string) => {
    for (const entry of ownValue(cache, parent)?.entries ?? []) {
      const path = workspacePath(parent, entry.name);
      if (entry.type === "dir" && ownValue(cache, path)) {
        paths.push(path);
        visit(path);
      }
    }
  };
  visit(root);
  return paths;
}

type Framed = Extract<PreviewState, { status: "web" | "document" }>;

/**
 * `directories` are the browser's listings (`dialogDirectories` is computed from them);
 * `onSelectionInside` is called after an unmount when the selected file was inside that mount.
 */
export function useMounts(
  client: ApiClient,
  workspaceId: string,
  directories: DirectoryCache,
  selectedFileRef: RefObject<{ path: string } | null>,
  onSelectionInside: () => void,
) {
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [generation, setGeneration] = useState(0);
  const selectionInside = useRef(onSelectionInside);
  selectionInside.current = onSelectionInside;
  const refetch = useCallback(() => setGeneration((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is the refetch trigger.
  useEffect(() => {
    const controller = new AbortController();
    client.listMounts(workspaceId, { signal: controller.signal }).then(
      (list) => {
        if (!controller.signal.aborted) setFetched({ client, workspaceId, list, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isUnauthorized(error)) return;
        setFetched({ client, workspaceId, list: null, error: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [client, workspaceId, generation]);

  // Another workspace's answer is never shown, not even for the render that switches.
  const current =
    fetched?.client === client && fetched.workspaceId === workspaceId ? fetched : null;
  const mounts = current?.list?.mounts ?? NO_MOUNTS;
  const names = useMemo(() => new Set(mounts.map((mount) => mount.name)), [mounts]);

  const holds = useCallback(
    (path: string | undefined) => path !== undefined && names.has(firstSegment(path)),
    [names],
  );
  const preview = useCallback(
    (selected: { path: string; preview: PreviewState | null } | null) => {
      const inMount = selected !== null && holds(selected.path);
      const shown = selected?.preview;
      const framed: Framed | null =
        !inMount && (shown?.status === "web" || shown?.status === "document") ? shown : null;
      return { framed, inMount };
    },
    [holds],
  );
  const layers = useCallback(
    (cache: DirectoryCache, writable: boolean) =>
      mounts
        .filter((mount) => mount.status === "online" && !(writable && mount.readOnly))
        .flatMap((mount) => loadedUnder(cache, mount.name)),
    [mounts],
  );
  const loaded = useCallback(
    (cache: DirectoryCache) => [...loadedDirectoryPaths(cache), ...layers(cache, false)],
    [layers],
  );
  const dialogDirectories = useMemo(
    () => [...loadedDirectoryPaths(directories), ...layers(directories, true)],
    [directories, layers],
  );

  const request = useRequestDialog<MountView>();
  const { dialog, submit } = request;
  const confirm = useCallback(() => {
    const mount = dialog?.subject;
    if (!mount) return;
    submit(
      (signal) => client.deleteMount(workspaceId, mount.id, { signal }),
      () => {
        setFetched((previous) =>
          previous?.list
            ? {
                ...previous,
                list: {
                  ...previous.list,
                  mounts: previous.list.mounts.filter(({ id }) => id !== mount.id),
                },
              }
            : previous,
        );
        const selected = selectedFileRef.current?.path;
        if (selected !== undefined && firstSegment(selected) === mount.name) {
          selectionInside.current();
        }
        refetch();
      },
    );
  }, [client, dialog, refetch, selectedFileRef, submit, workspaceId]);

  return {
    enabled: current?.list?.enabled ?? false,
    error: current?.error ?? null,
    loaded,
    preview,
    dialogDirectories,
    refetch,
    /** What `DirectoryTree` hands to `MountRoots`. */
    roots: {
      mounts,
      onUnmount: request.open,
      unmount: dialog && {
        error: dialog.error,
        mount: dialog.subject,
        onCancel: request.close,
        onConfirm: confirm,
        pending: dialog.pending,
        returnFocus: request.returnFocus,
      },
    },
  };
}

export type MountRootsState = ReturnType<typeof useMounts>["roots"];
