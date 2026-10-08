import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
import type { ApiClient } from "../../lib/api.js";
import type { ChatSession } from "../../lib/session-contract.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { downloadMarkdown, markdownFilename, sessionMarkdown } from "./export-markdown.js";
import { ownsHistory } from "./ownership.js";
import { sessionNavigation, sessionTitle } from "./session-path.js";
import type { ChatHistoryState, ChatListState } from "./types.js";

/**
 * 一次元数据请求修改、也是唯一从其响应合并的键：重命名 → `title`，置顶 → `pinnedAt`，
 * 归档与恢复 → `archivedAt`。
 */
type MetaKey = "title" | "pinnedAt" | "archivedAt";

type RenameState = {
  client: ApiClient;
  sessionId: string;
  title: string | null;
  busy: boolean;
  error: string | null;
  /** 标识这一次打开：迟到的结果只作用于发起它的那次打开。 */
  token: number;
};

/** 打开的 `另存为工作空间` 对话框；`workspaceId` 是打开那一刻该会话的临时空间。 */
type PromoteState = {
  client: ApiClient;
  sessionId: string;
  workspaceId: string;
  busy: boolean;
  error: string | null;
  token: number;
};

/** 工作空间名字的码点上限，与服务端一致。 */
const MAX_WORKSPACE_NAME_CODEPOINTS = 64;

/** 去掉首尾空白后的工作空间名字；为空或超过码点上限时为 null（不可提交）。 */
export function workspaceNameOf(text: string): string | null {
  const name = text.trim();
  return name.length === 0 || [...name].length > MAX_WORKSPACE_NAME_CODEPOINTS ? null : name;
}

/**
 * 打开的删除确认框；`title` 是打开那一刻的显示标题。`shared` 在打开时用已加载的列表（含已归档）
 * 判定：另有会话与它同 `workspaceId`。只对临时空间的会话有意义（确认文案的三种变体）。
 */
type DeleteState = {
  client: ApiClient;
  sessionId: string;
  title: string;
  workspaceId: string | null;
  temporaryWorkspace: boolean;
  shared: boolean;
};

/**
 * 只读说明（archived-notice.tsx）里 `恢复` 的忙碌与失败文案，属于 `client` 的 `sessionId` 会话：
 * 换账号或换会话后不显示。
 */
type NoticeState = { client: ApiClient; sessionId: string; busy: boolean; error: string | null };

/** 列表区顶部提示：没有对话框可显示的失败。属于 `client`，换账号后不再显示。 */
type AlertState = { client: ApiClient; message: string };

/** DELETE 在途的会话 id，属于 `client`；只经 `deletingIds` 读取。 */
type DeletingState = { client: ApiClient; ids: readonly string[] };

/**
 * 页面交给删除用的句柄：中止历史读取、关闭事件流、重读列表、当前选中的会话 id（响应到达时读取），
 * 以及会话列表状态（打开删除确认框时判定临时空间是否共用）。`history` 是页面持有的历史（导出当前
 * 会话时读它的视图）。
 */
type PageHandles = {
  abortHistory(): void;
  closeSource(): void;
  history: ChatHistoryState;
  list: ChatListState;
  refreshList(client: ApiClient): void;
  requestedSessionRef: RefObject<string | null>;
};

/** 为 `client` 的 `sessionId` 会话打开的 Dialog 关闭（null）；为别的会话打开的原样返回。 */
function closedFor<Opening extends { client: ApiClient; sessionId: string }>(
  opening: Opening | null,
  client: ApiClient,
  sessionId: string,
): Opening | null {
  return opening?.client === client && opening.sessionId === sessionId ? null : opening;
}

/**
 * `client` 名下 DELETE 在途的会话 id。标记属于别的 client 时为空：旧 client 的标记不带到新 client
 * （两个账号可以有相同的会话 id）。
 */
function deletingIds(marks: DeletingState, client: ApiClient): readonly string[] {
  return marks.client === client ? marks.ids : [];
}

function withoutSession(list: ChatListState, client: ApiClient, sessionId: string): ChatListState {
  return list.status === "success" && list.client === client
    ? { ...list, sessions: list.sessions.filter((session) => session.id !== sessionId) }
    : list;
}

/**
 * 列表区的 `新建会话`（nav 的直接子按钮；顶部提示里的 `关闭提示` 不是直接子元素）；列表区未挂载
 * （侧栏折叠、覆盖层关闭）时为 null。列表区在外壳的侧栏槽位里渲染，这里按 DOM 取而不传 ref。
 */
function listEntryPoint() {
  return document.querySelector<HTMLElement>('nav[aria-label="会话列表"] > button');
}

/**
 * 对话框关闭后的焦点：打开它的按钮还在就还给它；按钮已卸载（条目被删除、列表区换了呈现面）时
 * 落到列表区的首个控件，不落回 body。
 */
function restoreFocus(trigger: HTMLElement | null) {
  (trigger?.isConnected ? trigger : listEntryPoint())?.focus({ preventScroll: true });
}

function withMeta(session: ChatSession, view: ChatSession, key: MetaKey): ChatSession {
  if (key === "title") return { ...session, title: view.title };
  if (key === "pinnedAt") return { ...session, pinnedAt: view.pinnedAt };
  return { ...session, archivedAt: view.archivedAt };
}

/**
 * 会话条目操作（重命名、置顶/取消置顶、归档/恢复、删除、另存为工作空间、导出记录）：行菜单与顶栏 `重命名` 共用。
 * 重命名、另存为工作空间的 Dialog 与删除确认框的状态在这里而不在侧栏槽位节点里（槽位节点随折叠与覆盖层关闭卸载）。
 *
 * 列表条目与快照会话的 `title`、`pinnedAt`、`archivedAt` 只来自 PATCH 200 的响应，且只合并该请求修改的那个
 * 键——迟到的响应不会把已刷新的 `status` 或另一类请求刚写入的值改回去；不做乐观更新。同一会话
 * 的同类请求只采用最后发出者的响应；不属于当前 client、或页面卸载后到达的响应一律丢弃（卸载时
 * abort 全部在途请求）。重命名与置顶和回合互斥无关：任何状态（含 `running`）都可用；归档在
 * `running` 的会话上由菜单禁用，服务端的 409 走列表区顶部提示。归档与恢复不改选中与 URL。
 *
 * 删除同样不做乐观更新：条目只在本 client 的 DELETE 得到 204 时移除，每个会话同一时刻至多一个
 * 在途 DELETE。「是否为当前会话」在响应到达时读 `page.requestedSessionRef`；是则先关闭事件流再
 * 以 replace 移除 `?session=`，其余收尾（历史置 idle 等）由页面既有的 `requestedSessionId` effect
 * 完成。
 *
 * 不弹轻提示：成功以列表自身的变化为反馈；对话框开着时的失败在对话框内显示；没有对话框的动作
 * （置顶、归档、恢复、导出）与对话框关闭后才到达的失败进 `alert`（列表区顶部提示），下一次列表动作发起时清除。
 * 已归档会话主区说明里的 `恢复` 是另一个出口（`restoreNotice`）：忙碌与失败留在说明里。
 */
export function useSessionActions(
  client: ApiClient,
  setListState: Dispatch<SetStateAction<ChatListState>>,
  setHistoryState: Dispatch<SetStateAction<ChatHistoryState>>,
  page: PageHandles,
) {
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<RenameState | null>(null);
  const [promoting, setPromoting] = useState<PromoteState | null>(null);
  const [removing, setRemoving] = useState<DeleteState | null>(null);
  const [deleting, setDeleting] = useState<DeletingState>({ client, ids: [] });
  const [alert, setAlert] = useState<AlertState | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const stateRef = useRef(state);
  const promotingRef = useRef(promoting);
  const clientRef = useRef(client);
  const mountedRef = useRef(false);
  const tokenRef = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const promoteReturnFocus = useRef<HTMLElement | null>(null);
  const deleteReturnFocus = useRef<HTMLElement | null>(null);
  /** 最近一次渲染的 location：删除响应到达时的 URL，而不是确认那一刻的。 */
  const locationRef = useRef(location);
  const sequencesRef = useRef(new Map<string, number>());
  const controllersRef = useRef(new Set<AbortController>());

  stateRef.current = state;
  promotingRef.current = promoting;
  clientRef.current = client;
  locationRef.current = location;

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

  /**
   * 登记一次请求（PATCH 与 DELETE 共用）：`signal` 随卸载 abort，`release` 在响应到达时注销它，
   * `current` 是 fence——未卸载、未 abort、仍是当前 client。
   */
  function track() {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return {
      signal: controller.signal,
      release: () => {
        controllersRef.current.delete(controller);
      },
      current: () =>
        mountedRef.current && !controller.signal.aborted && client === clientRef.current,
    };
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
    const request = track();
    /** fence 之外另加一条：是该「会话 + 键」最后发出的请求。 */
    const current = () => request.current() && sequence === sequencesRef.current.get(sequenceKey);
    void client
      .patchSession(sessionId, patch, { signal: request.signal })
      .finally(request.release)
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

  /** 通过 fence 的失败进列表区顶部提示；401 交给既有的未授权通知。 */
  function report(error: unknown) {
    if (!isUnauthorized(error)) setAlert({ client, message: errorMessage(error) });
  }

  /**
   * 一次打开（`token`）的名字对话框开始提交：置忙碌、清框内提示，返回状态更新与失败出口；重命名与
   * 另存为工作空间共用。`update` 只改
   * 发起本请求的那次打开，它已被关闭或被新的打开取代时不动。`failed`：401 只解除忙碌（交给既有的
   * 未授权通知）；那次打开还在 → 对话框内提示；否则 → 列表区顶部提示。
   */
  function beginSubmit<Opening extends { busy: boolean; error: string | null; token: number }>(
    setOpening: Dispatch<SetStateAction<Opening | null>>,
    openingRef: RefObject<Opening | null>,
    token: number,
  ) {
    const update = (next: (current: Opening) => Opening | null) =>
      setOpening((current) => (current?.token === token ? next(current) : current));
    const failed = (error: unknown) => {
      if (isUnauthorized(error)) {
        update((current) => ({ ...current, busy: false }));
      } else if (openingRef.current?.token === token) {
        update((current) => ({ ...current, busy: false, error: errorMessage(error) }));
      } else {
        report(error);
      }
    };
    update((current) => ({ ...current, busy: true, error: null }));
    return { update, failed };
  }

  function openRename(session: ChatSession, trigger: HTMLElement | null) {
    setAlert(null);
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
    setAlert(null);
    const { update, failed } = beginSubmit(setState, stateRef, state.token);
    send(state.sessionId, "title", { title }, () => update(() => null), failed);
  }

  /** 只对用临时空间的会话打开（菜单项只在这类会话上渲染）。 */
  function openPromote(session: ChatSession, trigger: HTMLElement | null) {
    if (session.workspaceId === null) return;
    setAlert(null);
    promoteReturnFocus.current = trigger;
    tokenRef.current += 1;
    setPromoting({
      client,
      sessionId: session.id,
      workspaceId: session.workspaceId,
      busy: false,
      error: null,
      token: tokenRef.current,
    });
  }

  /**
   * 以去掉首尾空白的名字发一次 promote。200（含对话框关闭之后才到的）：重读会话列表——同一次
   * 刷新也重读工作空间列表——并关闭这次打开的对话框；失败按 `beginSubmit` 的出口。
   */
  function submitPromote(text: string) {
    const name = workspaceNameOf(text);
    if (!promoting || promoting.busy || name === null) return;
    setAlert(null);
    const { update, failed } = beginSubmit(setPromoting, promotingRef, promoting.token);
    const request = track();
    void client
      .promoteWorkspace(promoting.workspaceId, name, { signal: request.signal })
      .finally(request.release)
      .then(
        () => {
          if (!request.current()) return;
          page.refreshList(client);
          update(() => null);
        },
        (error: unknown) => {
          if (request.current()) failed(error);
        },
      );
  }

  function togglePin(session: ChatSession) {
    setAlert(null);
    send(session.id, "pinnedAt", { pinned: session.pinnedAt === null }, () => {}, report);
  }

  /** 行菜单的归档与恢复。它顶替同一会话说明里在途的 `恢复`（后者的回调不再触发），所以先清说明的状态。 */
  function setArchived(session: ChatSession, archived: boolean) {
    setAlert(null);
    setNotice((current) => closedFor(current, client, session.id));
    send(session.id, "archivedAt", { archived }, () => {}, report);
  }

  /** 只读说明里为 `sessionId` 记的状态；没有、或属于上一个 client 或别的会话时为 null。 */
  function noticeFor(sessionId: string) {
    return notice && notice.client === client && notice.sessionId === sessionId ? notice : null;
  }

  /**
   * 只读说明里的 `恢复`：与行菜单同一个请求，但忙碌与失败留在说明里。点击即清列表区顶部提示与上一条
   * 失败；200 后会话视图已合并（主区回到可写），状态清空；401 只解除忙碌（交给既有的未授权通知）；
   * 其它失败在按钮旁显示。不切侧栏视图。
   */
  function restoreFromNotice(sessionId: string) {
    if (noticeFor(sessionId)?.busy) return;
    const settle = (error: string | null) =>
      setNotice((current) =>
        current?.client === client && current.sessionId === sessionId && current.busy
          ? { ...current, busy: false, error }
          : current,
      );
    setAlert(null);
    setNotice({ client, sessionId, busy: true, error: null });
    send(
      sessionId,
      "archivedAt",
      { archived: false },
      () => settle(null),
      (error) => settle(isUnauthorized(error) ? null : errorMessage(error)),
    );
  }

  /**
   * 导出记录：前端生成 Markdown 并触发下载，不改任何状态。会话是当前选中的且其历史对本 client 已就绪
   * 时用页面视图（含快照之后的流式更新），不发请求；否则恰读一次快照。读取失败不下载，走列表区顶部提示。
   */
  function exportSession(session: ChatSession) {
    setAlert(null);
    const title = sessionTitle(session);
    const save = (messages: Parameters<typeof sessionMarkdown>[0]["messages"]) =>
      downloadMarkdown(markdownFilename(title), sessionMarkdown({ title, messages }));
    const { history } = page;
    if (
      history.status === "ready" &&
      page.requestedSessionRef.current === session.id &&
      ownsHistory(history, client, session.id)
    ) {
      save(history.view.messages);
      return;
    }
    const request = track();
    void client
      .getMessages(session.id, { signal: request.signal })
      .finally(request.release)
      .then(
        (snapshot) => {
          if (request.current()) save(snapshot.messages);
        },
        (error: unknown) => {
          if (request.current()) report(error);
        },
      );
  }

  function openDelete(session: ChatSession, trigger: HTMLElement | null) {
    setAlert(null);
    deleteReturnFocus.current = trigger;
    const { list } = page;
    const loaded = list.status === "success" && list.client === client ? list.sessions : [];
    setRemoving({
      client,
      sessionId: session.id,
      title: sessionTitle(session),
      workspaceId: session.workspaceId,
      temporaryWorkspace: session.temporaryWorkspace,
      shared: loaded.some(
        (other) => other.id !== session.id && other.workspaceId === session.workspaceId,
      ),
    });
  }

  function isDeleting(sessionId: string) {
    return deletingIds(deleting, client).includes(sessionId);
  }

  /**
   * 发出 DELETE；该会话已有在途 DELETE 时不做任何事。通过 fence 的结果先清在途标记。204：移除
   * 条目、关闭为该会话打开的确认框与重命名 Dialog；响应到达时它是当前会话则关闭事件流并 replace
   * 回欢迎态（不重读列表）。401 交给既有的未授权通知。其它失败：关闭确认框、列表区顶部提示、重读列表。
   */
  function confirmDelete(sessionId: string) {
    if (isDeleting(sessionId)) return;
    setAlert(null);
    const request = track();
    setDeleting((marks) => ({ client, ids: [...deletingIds(marks, client), sessionId] }));
    const unmark = () =>
      setDeleting((marks) => ({
        client,
        ids: deletingIds(marks, client).filter((id) => id !== sessionId),
      }));
    void client
      .deleteSession(sessionId, { signal: request.signal })
      .finally(request.release)
      .then(
        () => {
          if (!request.current()) return;
          unmark();
          setListState((list) => withoutSession(list, client, sessionId));
          setRemoving((opening) => closedFor(opening, client, sessionId));
          setState((opening) => closedFor(opening, client, sessionId));
          if (page.requestedSessionRef.current !== sessionId) return;
          // 仍在途的历史读取若在 navigate 与下一次渲染之间得到 200，会为已删会话重开事件流：先中止它。
          page.abortHistory();
          page.closeSource();
          const { pathname, search, hash } = locationRef.current;
          navigate(sessionNavigation(pathname, search, hash, null), { replace: true });
        },
        (error: unknown) => {
          if (!request.current()) return;
          unmark();
          if (isUnauthorized(error)) return;
          setRemoving((opening) => closedFor(opening, client, sessionId));
          report(error);
          page.refreshList(client);
        },
      );
  }

  return {
    openRename,
    openPromote,
    togglePin,
    archive: (session: ChatSession) => setArchived(session, true),
    restore: (session: ChatSession) => setArchived(session, false),
    /** `ArchivedNotice` 的 props：当前选中的已归档会话 `sessionId` 的 `恢复`。 */
    restoreNotice: (sessionId: string) => ({
      busy: noticeFor(sessionId)?.busy ?? false,
      error: noticeFor(sessionId)?.error ?? null,
      onRestore: () => restoreFromNotice(sessionId),
    }),
    exportSession,
    openDelete,
    /** 列表区顶部提示的文案（null 为没有）与 `关闭提示`；属于上一个 client 的不显示。 */
    alert: alert && alert.client === client ? alert.message : null,
    dismissAlert: () => setAlert(null),
    /** `DeleteDialog` 的 props；没有打开的确认框、或它属于上一个 client 时为 null。 */
    remove:
      removing && removing.client === client
        ? {
            title: removing.title,
            workspace: removing.temporaryWorkspace
              ? removing.shared
                ? ("shared" as const)
                : ("sole" as const)
              : null,
            pending: isDeleting(removing.sessionId),
            restoreFocus: () => restoreFocus(deleteReturnFocus.current),
            onConfirm: () => confirmDelete(removing.sessionId),
            onCancel: () => setRemoving(null),
          }
        : null,
    /** `PromoteDialog` 的 props；没有打开的对话框、或它属于上一个 client 时为 null。 */
    promote:
      promoting && promoting.client === client
        ? {
            busy: promoting.busy,
            error: promoting.error,
            restoreFocus: () => restoreFocus(promoteReturnFocus.current),
            onSubmit: submitPromote,
            onCancel: () => setPromoting(null),
          }
        : null,
    /** `RenameDialog` 的 props；没有打开的重命名、或它属于上一个 client 时为 null。 */
    rename:
      state && state.client === client
        ? {
            title: state.title,
            busy: state.busy,
            error: state.error,
            restoreFocus: () => restoreFocus(returnFocus.current),
            onSubmit: submitRename,
            onCancel: () => setState(null),
          }
        : null,
  };
}
