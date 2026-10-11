/**
 * The 新建文件夹 dialog of `WorkspaceBrowser`: its open / pending / error state and the one `dirs`
 * request behind it. A newer dialog, 取消 and unmount abort the request, and a result that arrives
 * for a dialog no longer current is dropped.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../../lib/api.js";
import { type DirectoryCache, workspacePath } from "./browser-paths.js";
import { errorMessage, isUnauthorized } from "./errors.js";

type FolderDialogState = {
  id: number;
  error: string | null;
  pending: boolean;
};

/** `cacheRef` 只用来看根是否已加载；`reloadDirectory` 在创建成功后重取父目录。 */
export function useFolderDialog(
  client: Pick<ApiClient, "createDir">,
  workspaceId: string,
  cacheRef: RefObject<DirectoryCache>,
  reloadDirectory: (path: string, refresh: boolean) => void,
) {
  const [dialog, setDialog] = useState<FolderDialogState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogIdRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const mutationRef = useRef<AbortController | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const sequenceRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      dialogIdRef.current = null;
      mutationRef.current?.abort();
      mutationRef.current = null;
    };
  }, []);

  const close = useCallback(() => {
    dialogIdRef.current = null;
    mutationRef.current?.abort();
    mutationRef.current = null;
    setDialog(null);
  }, []);

  const open = useCallback(
    (trigger: HTMLElement | null) => {
      if (!cacheRef.current[""]) {
        setNotice("当前工作空间没有可写目录");
        return;
      }

      mutationRef.current?.abort();
      mutationRef.current = null;
      sequenceRef.current += 1;
      dialogIdRef.current = sequenceRef.current;
      returnFocus.current = trigger;
      setNotice(null);
      setDialog({ id: sequenceRef.current, error: null, pending: false });
    },
    [cacheRef],
  );

  const create = useCallback(
    (parent: string, name: string) => {
      const dialogId = dialogIdRef.current;
      if (dialogId === null || mutationRef.current) {
        return;
      }

      const controller = new AbortController();
      mutationRef.current = controller;
      setDialog((current) =>
        current?.id === dialogId ? { ...current, error: null, pending: true } : current,
      );
      void client
        .createDir(workspaceId, workspacePath(parent, name), { signal: controller.signal })
        .then(() => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            dialogIdRef.current !== dialogId
          ) {
            return;
          }

          dialogIdRef.current = null;
          mutationRef.current = null;
          setDialog(null);
          reloadDirectory(parent, true);
        })
        .catch((error: unknown) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            dialogIdRef.current !== dialogId ||
            isUnauthorized(error)
          ) {
            return;
          }

          mutationRef.current = null;
          const message =
            error instanceof ApiError && error.status === 409
              ? "该目录下已存在同名条目"
              : errorMessage(error);
          setDialog((current) =>
            current?.id === dialogId ? { ...current, error: message, pending: false } : current,
          );
        });
    },
    [client, reloadDirectory, workspaceId],
  );

  return { close, create, dialog, notice, open, returnFocus };
}
