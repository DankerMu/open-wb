import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import { isUnauthorized } from "./errors.js";

type Workspace = Awaited<ReturnType<ApiClient["listWorkspaces"]>>["workspaces"][number];
type WorkspaceListState = { client: ApiClient; workspaces: readonly Workspace[] | null };

/**
 * 会话页的工作空间列表：`workspaces` 是当前 client 最近一次成功读取的结果，首次读取完成前与
 * 最近一次读取失败后为 null。`refresh` 由会话页在每次读取会话列表时并行触发，两个请求互不等待；
 * 同一 client 重新读取期间沿用上一次结果，换 client 后立即清空（不露出上一账号的空间名）。
 * 被取代、已卸载或不属于当前 client 的响应一律丢弃；401 交给客户端既有的通知机制。
 */
export function useWorkspaceList(client: ApiClient) {
  const [state, setState] = useState<WorkspaceListState>({ client, workspaces: null });
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

  const refresh = useCallback((ownedClient: ApiClient) => {
    if (ownedClient !== clientRef.current) {
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    generationRef.current += 1;
    const generation = generationRef.current;
    const settle = (workspaces: readonly Workspace[] | null) => {
      if (
        !controller.signal.aborted &&
        generation === generationRef.current &&
        ownedClient === clientRef.current
      ) {
        setState({ client: ownedClient, workspaces });
      }
    };
    setState((current) =>
      current.client === ownedClient ? current : { client: ownedClient, workspaces: null },
    );
    void ownedClient.listWorkspaces({ signal: controller.signal }).then(
      ({ workspaces }) => settle(workspaces),
      (error: unknown) => {
        if (!isUnauthorized(error)) settle(null);
      },
    );
  }, []);

  return { refresh, workspaces: state.client === client ? state.workspaces : null };
}
