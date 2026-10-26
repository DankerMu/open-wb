/**
 * The mounts of the workspace `WorkspaceBrowser` shows (workspace-mounts「挂载根行」, design D18).
 *
 * - The list: one `GET …/mounts` when the workspace is entered (a new `workspaceId` included — the
 *   session sidebar keeps the browser across workspaces), and again on `refetch`: the browser's `刷新`
 *   button and a successful unmount call it. Nothing else does — no polling, no refetch after an
 *   expand, a selection or an entry operation, nor on the handle's `refresh` (the session sidebar
 *   calls that after the assistant's steps; D18's `刷新` is the button). A failed `GET` drops the
 *   rows and leaves its envelope message in `error` (none for a 401: the login layer's); the last
 *   list read for this workspace is kept for the mount names below.
 * - The rows' data is that list alone: the root `tree` does not list mount points (D21) and nothing
 *   here filters it. Registered mounts are shown whether or not `enabled` is true (an offline row can
 *   still be unmounted).
 * - Mount names: those of the last list read for this workspace, failed refetches or not. Before any
 *   list was read (in flight, or every `GET` failed) a first segment the loaded root listing does not
 *   name counts as one: the root never lists a mount point (D21), and what it does not list can only
 *   be reached by a walk the server answered. Without the root's listing nothing counts (only an
 *   `onlyPaths` row gets there, and the session's changed paths are never inside a mount, D21).
 * - `preview(selected)`: `inMount` is whether the first segment of the selected path is a mount's
 *   name (a directory whose name merely starts with one is not inside it) — the browser hands it to
 *   the preview area as「在挂载内」; `framed` is the preview that needs the preview token (a web page,
 *   a PDF or an office document) when not inside a mount, `null` otherwise: no token is issued or
 *   renewed for a file inside a mount (file-previewers「挂载内文件不签发」).
 * - `walk(path, cache)`: `revealStep` with the online mounts' names as root rows (files-web「地址定位到
 *   文件」reaches into a mount). `show` is what the walk expands: `expand`, and while no list was read
 *   the unlisted first segment too, so a mount row that arrives after the walk comes out expanded; it
 *   stays out of `expand` (no row yet: a failure there is no error row). An offline mount is not a
 *   root row — like its row it is not expanded; its level is asked for once and the walk ends there.
 * - Loaded directories: `loadedDirectoryPaths` walks from the root's listing, which never names a
 *   mount, so the directories under mounts are added here, walking each mount's listings the same
 *   way. `loaded(cache)` adds those of the online mounts (what `refresh` lists again);
 *   `dialogDirectories` (the `位置` dropdown) only those of online mounts that are not read-only.
 *   `refetch(relist)` (the `刷新` button: it has just listed the online mounts' layers again) calls
 *   `relist(path, true)` once the list is read for the loaded layers of each mount that is online in
 *   it and was not online before — one click brings back a mount that came back online.
 * - Mounting (`mount-dialog.tsx`): `openCreate` is there only while `enabled` is true. Its submit
 *   sends one `POST …/mounts`; on 201 the dialog closes, the new mount joins the list at once and the
 *   list is fetched again, and its row (`mount-roots.tsx`, through `takeCreated`) comes out expanded
 *   with focus on it — the cancelling close's return of focus to `新建` is dropped. That claim lasts
 *   until the row takes it, that refetch fails or another refetch starts. A failure keeps the dialog
 *   open with the envelope message; `取消` aborts the wait. A `取消` (or Escape) after a `POST` was
 *   sent from this dialog fetches the list once more: the server may have made the mount all the
 *   same (design D18), and its row then shows up as any listed row does — not expanded, no focus.
 * - Unmount: `useRequestDialog` holds the confirmation. Confirming sends one `DELETE …/mounts/<id>`;
 *   on 204 the row goes at once, focus goes to the space root's row, `onSelectionInside` is called
 *   when the selected file is inside that mount, and the list is fetched again. A failure keeps the
 *   dialog open with the envelope message.
 */
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, CreateMountInput, MountList, MountView } from "../../lib/api.js";
import {
  type DirectoryCache,
  loadedDirectoryPaths,
  ownValue,
  revealStep,
  workspacePath,
} from "./browser-paths.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { useRequestDialog } from "./request-dialog.js";
import type { PreviewState } from "./types.js";

type Fetched = {
  client: ApiClient;
  workspaceId: string;
  /** The last list read for this workspace: a later failed `GET` keeps it. */
  list: MountList | null;
  /** The last `GET`'s failure: the rows are hidden while it is set. */
  error: string | null;
};

type Relist = (path: string, refresh: true) => void;
/** A `刷新` click's relisting: for this workspace, of the mounts not online (`was`) at the click. */
type PendingRelist = { client: ApiClient; workspaceId: string; relist: Relist; was: Set<string> };

const NO_MOUNTS: readonly MountView[] = [];

const online = (mounts: readonly MountView[]) =>
  new Set(mounts.filter((mount) => mount.status === "online").map((mount) => mount.name));

/** Whether the root's listing is loaded and has no entry named `name`. */
function unlistedAtRoot(cache: DirectoryCache, name: string) {
  const root = ownValue(cache, "");
  return root !== undefined && !root.entries.some((entry) => entry.name === name);
}

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

/** The loaded layers of each mount online in `mounts` that was not online at the click. */
function relistBack(pending: PendingRelist, mounts: readonly MountView[], cache: DirectoryCache) {
  for (const name of online(mounts)) {
    if (pending.was.has(name)) continue;
    for (const path of loadedUnder(cache, name)) pending.relist(path, true);
  }
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
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;
  const relistRef = useRef<PendingRelist | null>(null);
  const rootRow = useRef<HTMLElement | null>(null);
  // The id of the mount the dialog has just created, until its row takes it (`takeCreated`).
  const createdRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is the refetch trigger.
  useEffect(() => {
    const controller = new AbortController();
    const settle = (list: MountList | null, error: string | null) =>
      setFetched((previous) => {
        const same = previous?.client === client && previous.workspaceId === workspaceId;
        return { client, workspaceId, list: list ?? (same ? previous.list : null), error };
      });
    client.listMounts(workspaceId, { signal: controller.signal }).then(
      (list) => {
        if (controller.signal.aborted) return;
        settle(list, null);
        const pending = relistRef.current;
        relistRef.current = null;
        if (pending?.client === client && pending.workspaceId === workspaceId) {
          relistBack(pending, list.mounts, directoriesRef.current);
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted || isUnauthorized(error)) return;
        relistRef.current = null;
        createdRef.current = null;
        settle(null, errorMessage(error));
      },
    );
    return () => controller.abort();
  }, [client, workspaceId, generation]);

  // Another workspace's answer is never shown, not even for the render that switches.
  const current =
    fetched?.client === client && fetched.workspaceId === workspaceId ? fetched : null;
  const known = current?.list?.mounts ?? null;
  const mounts = (current?.error === null ? known : null) ?? NO_MOUNTS;
  const names = useMemo(() => known && new Set(known.map((mount) => mount.name)), [known]);
  const onlineNames = useMemo(() => online(known ?? NO_MOUNTS), [known]);

  const refetch = useCallback(
    (relist?: Relist) => {
      relistRef.current = relist ? { client, workspaceId, relist, was: online(mounts) } : null;
      createdRef.current = null;
      setGeneration((value) => value + 1);
    },
    [client, mounts, workspaceId],
  );
  const holds = useCallback(
    (path: string) =>
      names ? names.has(firstSegment(path)) : unlistedAtRoot(directories, firstSegment(path)),
    [directories, names],
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
  const walk = useCallback(
    (path: string, cache: DirectoryCache) => {
      const step = revealStep(path, cache, onlineNames);
      const first = firstSegment(path);
      const guess = names === null && first !== path && unlistedAtRoot(cache, first);
      return { ...step, show: guess ? [...step.expand, first] : step.expand };
    },
    [names, onlineNames],
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
  const { dialog, open, returnFocus, submit } = request;
  const openUnmount = useCallback(
    (mount: MountView, trigger: HTMLElement | null) => {
      // The space root's row: the first row of the list the mount rows are in.
      rootRow.current =
        trigger?.closest("ul")?.querySelector<HTMLElement>(":scope > li > button") ?? null;
      open(mount, trigger);
    },
    [open],
  );
  const confirm = useCallback(() => {
    const mount = dialog?.subject;
    if (!mount) return;
    submit(
      (signal) => client.deleteMount(workspaceId, mount.id, { signal }),
      () => {
        returnFocus.current = rootRow.current;
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
  }, [client, dialog, refetch, returnFocus, selectedFileRef, submit, workspaceId]);

  const creation = useRequestDialog<null>();
  const {
    close: closeCreation,
    open: openCreation,
    returnFocus: creationFocus,
    submit: submitCreation,
  } = creation;
  // Whether the open dialog has sent a `POST` (its `取消` then refetches).
  const sentRef = useRef(false);
  const openCreate = useCallback(
    (trigger: HTMLElement | null) => {
      sentRef.current = false;
      openCreation(null, trigger);
    },
    [openCreation],
  );
  const cancelCreate = useCallback(() => {
    closeCreation();
    if (sentRef.current) refetch();
    sentRef.current = false;
  }, [closeCreation, refetch]);
  const create = useCallback(
    (input: CreateMountInput) => {
      let made: MountView | null = null;
      submitCreation(
        (signal) => {
          sentRef.current = true;
          return client.createMount(workspaceId, input, { signal }).then((view) => {
            made = view;
          });
        },
        () => {
          const view = made;
          creationFocus.current = null;
          sentRef.current = false;
          if (!view) return;
          setFetched((previous) =>
            previous?.list && previous.client === client && previous.workspaceId === workspaceId
              ? {
                  ...previous,
                  list: { ...previous.list, mounts: [...previous.list.mounts, view] },
                }
              : previous,
          );
          refetch();
          // After `refetch`, which drops any earlier claim.
          createdRef.current = view.id;
        },
      );
    },
    [client, creationFocus, refetch, submitCreation, workspaceId],
  );
  const takeCreated = useCallback((id: string) => {
    if (createdRef.current !== id) return false;
    createdRef.current = null;
    return true;
  }, []);

  const enabled = (current?.error === null && current.list?.enabled) || false;
  return {
    enabled,
    /** The `新建` menu's `挂载目录`: only while `enabled`. */
    openCreate: enabled ? openCreate : undefined,
    /** What `MountDialog` takes while the dialog is open. */
    creating: creation.dialog && {
      error: creation.dialog.error,
      pending: creation.dialog.pending,
      returnFocus: creationFocus,
      onCancel: cancelCreate,
      onCreate: create,
      listSources: (signal: AbortSignal) => client.listMountSources({ signal }),
    },
    error: current?.error ?? null,
    loaded,
    preview,
    dialogDirectories,
    refetch,
    walk,
    /** What `DirectoryTree` hands to `MountRoots`. */
    roots: {
      mounts,
      onUnmount: openUnmount,
      takeCreated,
      unmount: dialog && {
        error: dialog.error,
        mount: dialog.subject,
        onCancel: request.close,
        onConfirm: confirm,
        pending: dialog.pending,
        returnFocus,
      },
    },
  };
}

export type MountRootsState = ReturnType<typeof useMounts>["roots"];
