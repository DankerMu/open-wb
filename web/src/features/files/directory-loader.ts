/**
 * `WorkspaceBrowser` 的目录请求：一层目录的 `tree` 请求与它的三种结局。状态都是浏览器交出来的引用与
 * 写状态的函数（同 `follow-entry.ts` 的做法），这里不另存任何东西。
 */
import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import type { ApiClient } from "../../lib/api.js";
import { type DirectoryCache, ownValue, parentPath } from "./browser-paths.js";
import { errorMessage, isUnauthorized } from "./errors.js";

type Paths = ReadonlySet<string>;

type LoaderState = {
  cacheRef: RefObject<DirectoryCache>;
  client: ApiClient;
  directoryRequestsRef: RefObject<Map<string, AbortController>>;
  failedDirectoriesRef: RefObject<Map<string, string>>;
  focusMenuPath: RefObject<string | null>;
  mountedRef: RefObject<boolean>;
  setDirectories: Dispatch<SetStateAction<DirectoryCache>>;
  setDirectoryErrors: Dispatch<SetStateAction<Record<string, string>>>;
  setLoadingPaths: Dispatch<SetStateAction<Paths>>;
  /** 真值（浏览器给了 `onlyPaths`）时一个 `tree` 都不请求。 */
  subtreeOnly: boolean;
  workspaceId: string;
  /** 目录 `path` 的列表读到并进了缓存之后调用一次（引用须稳定）。 */
  onListed(path: string): void;
};

/**
 * 返回 `loadDirectory(path, refresh?, onTree?)`：请求目录 `path` 的列表。已加载的不重复请求，`refresh`
 * 为真时照样请求并顶掉在途的那一次；`subtreeOnly` 下直接返回。成功：列表进缓存，调 `onListed`。失败
 * （401 除外，那归登录层）：文案记进 `failedDirectoriesRef`，`onTree` 为真（这一层在树上有行）时另进
 * 错误行；旧列表保留。卸载或被中止之后的应答不提交任何状态。
 */
export function useDirectoryLoader({
  cacheRef,
  client,
  directoryRequestsRef,
  failedDirectoriesRef,
  focusMenuPath,
  mountedRef,
  onListed,
  setDirectories,
  setDirectoryErrors,
  setLoadingPaths,
  subtreeOnly,
  workspaceId,
}: LoaderState) {
  return useCallback(
    (path: string, refresh = false, onTree = true) => {
      if (subtreeOnly || (!refresh && ownValue(cacheRef.current, path))) {
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
      failedDirectoriesRef.current.delete(path);
      setLoadingPaths((current) => new Set(current).add(path));
      setDirectoryErrors((current) => {
        if (!ownValue(current, path)) {
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
          onListed(path);
        })
        .catch((error: unknown) => {
          if (!mountedRef.current || controller.signal.aborted || isUnauthorized(error)) {
            return;
          }

          const message = errorMessage(error);
          failedDirectoriesRef.current.set(path, message);
          if (focusMenuPath.current !== null && parentPath(focusMenuPath.current) === path) {
            focusMenuPath.current = null;
          }
          // 树上没有行的层（`path` 属性里上一级没有列出的那些）不进错误行：`刷新` 不会再请求它。
          if (onTree) {
            setDirectoryErrors((current) => ({ ...current, [path]: message }));
          }
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
    [
      cacheRef,
      client,
      directoryRequestsRef,
      failedDirectoriesRef,
      focusMenuPath,
      mountedRef,
      onListed,
      setDirectories,
      setDirectoryErrors,
      setLoadingPaths,
      subtreeOnly,
      workspaceId,
    ],
  );
}
