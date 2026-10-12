/**
 * The 新建文件夹 dialog of `WorkspaceBrowser`: `useRequestDialog` with the one `dirs` request behind
 * it, and the notice shown instead of the dialog when the workspace has no listed root.
 */
import { type RefObject, useCallback, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import { type DirectoryCache, workspacePath } from "./browser-paths.js";
import { useRequestDialog } from "./request-dialog.js";

/** `cacheRef` 只用来看根是否已加载；`reloadDirectory` 在创建成功后重取父目录。 */
export function useFolderDialog(
  client: Pick<ApiClient, "createDir">,
  workspaceId: string,
  cacheRef: RefObject<DirectoryCache>,
  reloadDirectory: (path: string, refresh: boolean) => void,
) {
  const { close, dialog, open: openDialog, returnFocus, submit } = useRequestDialog<null>();
  const [notice, setNotice] = useState<string | null>(null);

  const open = useCallback(
    (trigger: HTMLElement | null) => {
      if (!cacheRef.current[""]) {
        setNotice("当前工作空间没有可写目录");
        return;
      }

      setNotice(null);
      openDialog(null, trigger);
    },
    [cacheRef, openDialog],
  );

  const create = useCallback(
    (parent: string, name: string) => {
      submit(
        (signal) => client.createDir(workspaceId, workspacePath(parent, name), { signal }),
        () => reloadDirectory(parent, true),
        "该目录下已存在同名条目",
      );
    },
    [client, reloadDirectory, submit, workspaceId],
  );

  return { close, create, dialog, notice, open, returnFocus };
}
