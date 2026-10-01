import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import type { ChatSession } from "../../lib/session-contract.js";
import { useToast } from "../../ui/index.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import type { ChatHistoryState, ChatListState } from "./types.js";

/** 一次元数据请求修改、也是唯一从其响应合并的键：重命名 → `title`，置顶 → `pinnedAt`。 */
type MetaKey = "title" | "pinnedAt";

type RenameState = {
  client: ApiClient;
  sessionId: string;
  title: string | null;
  busy: boolean;
  error: string | null;
  /** 标识这一次打开：迟到的结果只作用于发起它的那次打开。 */
  token: number;
};

function withMeta(session: ChatSession, view: ChatSession, key: MetaKey): ChatSession {
  return key === "title"
    ? { ...session, title: view.title }
    : { ...session, pinnedAt: view.pinnedAt };
}

/**
 * 会话元数据操作（重命名、置顶/取消置顶）：行菜单与顶栏 `重命名` 共用。重命名 Dialog 的状态在
 * 这里而不在侧栏槽位节点里（槽位节点随折叠与覆盖层关闭卸载）。
 *
 * 列表条目与快照会话的 `title`、`pinnedAt` 只来自 PATCH 200 的响应，且只合并该请求修改的那个
 * 键——迟到的响应不会把已刷新的 `status` 或另一类请求刚写入的值改回去；不做乐观更新。同一会话
 * 的同类请求只采用最后发出者的响应；不属于当前 client、或页面卸载后到达的响应一律丢弃（卸载时
 * abort 全部在途请求）。与回合互斥无关：任何状态（含 `running`）都可用。
 */
export function useSessionActions(
  client: ApiClient,
  setListState: Dispatch<SetStateAction<ChatListState>>,
  setHistoryState: Dispatch<SetStateAction<ChatHistoryState>>,
) {
  const toast = useToast();
  const [state, setState] = useState<RenameState | null>(null);
  const stateRef = useRef(state);
  const clientRef = useRef(client);
  const mountedRef = useRef(false);
  const tokenRef = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const sequencesRef = useRef(new Map<string, number>());
  const controllersRef = useRef(new Set<AbortController>());

  stateRef.current = state;
  clientRef.current = client;

  useEffect(() => {
    const controllers = controllersRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, []);

  /** 响应视图按 id 合并进列表与快照，其余字段（含快照状态上的 `resync` 标记）原样展开保留。 */
  function merge(ownedClient: ApiClient, view: ChatSession, key: MetaKey) {
    setListState((list) =>
      list.status === "success" &&
      list.client === ownedClient &&
      list.sessions.some((session) => session.id === view.id)
        ? {
            ...list,
            sessions: list.sessions.map((session) =>
              session.id === view.id ? withMeta(session, view, key) : session,
            ),
          }
        : list,
    );
    setHistoryState((history) =>
      history.status === "ready" &&
      history.client === ownedClient &&
      history.snapshot.session.id === view.id
        ? {
            ...history,
            snapshot: {
              ...history.snapshot,
              session: withMeta(history.snapshot.session, view, key),
            },
          }
        : history,
    );
  }

  /** 发出一次 PATCH。两个回调只在响应通过 fence 时调用；`succeeded` 调用前响应视图已合并。 */
  function send(
    sessionId: string,
    key: MetaKey,
    patch: Parameters<ApiClient["patchSession"]>[1],
    succeeded: () => void,
    failed: (error: unknown) => void,
  ) {
    const sequenceKey = `${sessionId}:${key}`;
    const sequence = (sequencesRef.current.get(sequenceKey) ?? 0) + 1;
    sequencesRef.current.set(sequenceKey, sequence);
    const controller = new AbortController();
    controllersRef.current.add(controller);
    /** fence：未卸载、未 abort、仍是当前 client，且是该「会话 + 键」最后发出的请求。 */
    const current = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      client === clientRef.current &&
      sequence === sequencesRef.current.get(sequenceKey);
    void client
      .patchSession(sessionId, patch, { signal: controller.signal })
      .finally(() => controllersRef.current.delete(controller))
      .then(
        (view) => {
          if (!current()) return;
          merge(client, view, key);
          succeeded();
        },
        (error: unknown) => {
          if (current()) failed(error);
        },
      );
  }

  function openRename(session: ChatSession, trigger: HTMLElement | null) {
    returnFocus.current = trigger;
    tokenRef.current += 1;
    setState({
      client,
      sessionId: session.id,
      title: session.title,
      busy: false,
      error: null,
      token: tokenRef.current,
    });
  }

  function submitRename(text: string) {
    const title = text.trim();
    if (!state || state.busy || title.length === 0) return;
    const { sessionId, token } = state;
    /** 只改发起本请求的那次打开；它已被关闭或被新的打开取代时不动。 */
    const update = (next: (opening: RenameState) => RenameState | null) =>
      setState((opening) => (opening?.token === token ? next(opening) : opening));
    update((opening) => ({ ...opening, busy: true, error: null }));
    send(
      sessionId,
      "title",
      { title },
      () => {
        toast.show({ type: "success", message: "已重命名" });
        update(() => null);
      },
      (error) => {
        if (isUnauthorized(error)) {
          update((opening) => ({ ...opening, busy: false }));
        } else if (stateRef.current?.token === token) {
          update((opening) => ({ ...opening, busy: false, error: errorMessage(error) }));
        } else {
          toast.show({ type: "error", message: errorMessage(error) });
        }
      },
    );
  }

  function togglePin(session: ChatSession) {
    send(
      session.id,
      "pinnedAt",
      { pinned: session.pinnedAt === null },
      () => toast.show({ type: "success", message: "已更新置顶状态" }),
      (error) => {
        if (!isUnauthorized(error)) toast.show({ type: "error", message: errorMessage(error) });
      },
    );
  }

  return {
    openRename,
    togglePin,
    /** `RenameDialog` 的 props；没有打开的重命名、或它属于上一个 client 时为 null。 */
    rename:
      state && state.client === client
        ? {
            title: state.title,
            busy: state.busy,
            error: state.error,
            returnFocus,
            onSubmit: submitRename,
            onCancel: () => setState(null),
          }
        : null,
  };
}
