import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import { errorMessage, isUnauthorized } from "./errors.js";

export type Workspace = Awaited<ReturnType<ApiClient["listWorkspaces"]>>["workspaces"][number];
type WorkspaceListState = {
  client: ApiClient;
  workspaces: readonly Workspace[] | null;
  error: string | null;
};

/**
 * 会话页的工作空间列表：`workspaces` 是当前 client 最近一次成功读取的结果，首次读取完成前与
 * 最近一次读取失败后为 null。`refresh` 由会话页在每次读取会话列表时并行触发，两个请求互不等待；
 * 同一 client 重新读取期间沿用上一次结果，换 client 后立即清空（不露出上一账号的空间名）。
 * `error` 是最近一次读取失败的文案：读取成功、换 client 与失败后的重新读取开始时清空，所以
 * `workspaces` 与 `error` 同为 null 即读取在途。
 * `silent` 的读取（列表事件触发）开始时不清空；失败时保留上一次的结果或文案——除非此前的读取还
 * 没有结果（它顶替了那次读取），这时照常记为失败。
 * 被取代、已卸载或不属于当前 client 的响应一律丢弃；401 交给客户端既有的通知机制。
 */
export function useWorkspaceList(client: ApiClient) {
  const [state, setState] = useState<WorkspaceListState>({ client, workspaces: null, error: null });
  const clientRef = useRef(client);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  clientRef.current = client;

  useEffect(
    () => () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  const refresh = useCallback((ownedClient: ApiClient, silent = false) => {
    if (ownedClient !== clientRef.current) {
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    generationRef.current += 1;
    const generation = generationRef.current;
    const settle = (workspaces: readonly Workspace[] | null, error: string | null) => {
      if (
        !controller.signal.aborted &&
        generation === generationRef.current &&
        ownedClient === clientRef.current
      ) {
        setState({ client: ownedClient, workspaces, error });
      }
    };
    // 失败时 workspaces 已为 null，所以「同一 client 且无错误」之外的两种情况都回到读取在途。
    if (!silent) {
      setState((current) =>
        current.client === ownedClient && current.error === null
          ? current
          : { client: ownedClient, workspaces: null, error: null },
      );
    }
    void ownedClient.listWorkspaces({ signal: controller.signal }).then(
      ({ workspaces }) => settle(workspaces, null),
      (error: unknown) => {
        if (isUnauthorized(error)) return;
        if (!silent) return settle(null, errorMessage(error));
        // 静默读取顶替了一次尚无结果的读取时，它的失败就是那次读取的失败；否则保留现状。
        setState((current) =>
          controller.signal.aborted ||
          generation !== generationRef.current ||
          (current.client === ownedClient && (current.workspaces ?? current.error) !== null)
            ? current
            : { client: ownedClient, workspaces: null, error: errorMessage(error) },
        );
      },
    );
  }, []);

  const owned = state.client === client;
  return {
    refresh,
    workspaces: owned ? state.workspaces : null,
    error: owned ? state.error : null,
  };
}
