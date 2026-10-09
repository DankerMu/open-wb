// 会话页的页面状态（无渲染 hook，只由 ChatPage 调用）：列表、历史、连接、发送/创建、所有权 fence 与派生量。
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ApiClient } from "../../lib/api.js";
import type { ChatMessageSnapshot } from "../../lib/session-contract.js";
import { useAuth } from "../auth/index.js";
import { useAttachmentsState } from "./attachments-state.js";
import { canSend, composerLocks } from "./composer-locks.js";
import { useComposerOptions } from "./composer-options.js";
import { errorMessage, isNotFound, isUnauthorized } from "./errors.js";
import {
  blocksNewSession,
  ownsCreateSend,
  ownsHistory,
  ownsMutation,
  visibleOwnedAlert,
} from "./ownership.js";
import { useSessionActions } from "./session-actions.js";
import { composerWorkspaceId, selectedSession, sessionNavigation } from "./session-path.js";
import {
  applyChatEvent,
  type ChatEvent,
  chatStateFromSnapshot,
  connectSessionEvents,
  isUnknownTurn,
} from "./stream.js";
import { TERMINAL_REFRESH_GUIDANCE, type UndoConflict, useTurnActions } from "./turn-actions.js";
import type {
  ChatHistoryState,
  ChatListState,
  ChatMutationOwner,
  ChatOwnedAlert,
  ChatUndoNotice,
  PendingCreateSend,
} from "./types.js";
import { useSessionListEvents } from "./use-session-list-events.js";
import { useWelcomeOptions } from "./welcome-options.js";
import { resolveSessionSpace, useWorkspaceList } from "./workspace-list.js";

type SessionEventHandle = { close(): void; resync(): void };
type ReadyHistory = Extract<ChatHistoryState, { status: "ready" }>;
/**
 * `resync` marks the connection whose unknown-turn event asked for a fresh snapshot (issue 633).
 * Set by a pure updater, consumed by an effect; every installed snapshot replaces the state and
 * clears it.
 */
type PageHistoryState =
  | Exclude<ChatHistoryState, ReadyHistory>
  | (ReadyHistory & { resync?: { source: SessionEventHandle } });

const MISSING_EVENT_SOURCE = "无法连接会话事件";

export function useChatSession() {
  const { createSessionClient } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  const location = useLocation();
  const navigate = useNavigate();
  const requestedSessionId = new URLSearchParams(location.search).get("session");
  const [draft, setDraft] = useState("");
  const [listState, setListState] = useState<ChatListState>({ status: "loading", client });
  const [historyState, setHistoryState] = useState<PageHistoryState>({ status: "idle" });
  const [promptError, setPromptError] = useState<ChatOwnedAlert | null>(null);
  const [streamError, setStreamError] = useState<ChatOwnedAlert | null>(null);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mutationOwner, setMutationOwner] = useState<ChatMutationOwner | null>(null);
  const [regenerateOwner, setRegenerateOwner] = useState<ChatMutationOwner | null>(null);
  const [forkOwner, setForkOwner] = useState<ChatMutationOwner | null>(null);
  const [undoOwner, setUndoOwner] = useState<ChatMutationOwner | null>(null);
  const [undoConflict, setUndoConflict] = useState<UndoConflict | null>(null);
  const [undoNotice, setUndoNotice] = useState<ChatUndoNotice | null>(null);
  const {
    error: workspacesError,
    refresh: refreshWorkspaces,
    workspaces,
  } = useWorkspaceList(client);
  const welcome = useWelcomeOptions(workspaces, workspacesError);
  const composerOptions = useComposerOptions(client, requestedSessionId);
  const mountedRef = useRef(false);
  const clientRef = useRef(client);
  const requestedSessionRef = useRef(requestedSessionId);
  const listGenerationRef = useRef(0);
  const historyGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const createSendGenerationRef = useRef(0);
  const sourceRef = useRef<SessionEventHandle | null>(null);
  const sourceSessionRef = useRef<string | null>(null);
  const pendingCreateSendRef = useRef<PendingCreateSend | null>(null);
  const listControllerRef = useRef<AbortController | null>(null);
  const historyControllerRef = useRef<AbortController | null>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const createControllerRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const focusOnWelcomeRef = useRef(false);
  const focusOnUnlockRef = useRef(false);
  const undoFlightRef = useRef<ChatMutationOwner | null>(null);
  const undoSkippedResyncRef = useRef<ChatMutationOwner | null>(null);
  const viewRunningRef = useRef(false);

  clientRef.current = client;
  requestedSessionRef.current = requestedSessionId;

  const closeSource = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    sourceSessionRef.current = null;
  }, []);

  const abortList = useCallback(() => {
    listControllerRef.current?.abort();
    listControllerRef.current = null;
  }, []);

  const abortHistory = useCallback(() => {
    historyControllerRef.current?.abort();
    historyControllerRef.current = null;
  }, []);

  const abortMutation = useCallback(() => {
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = null;
  }, []);

  const abortCreate = useCallback(() => {
    createControllerRef.current?.abort();
    createControllerRef.current = null;
  }, []);

  const releaseMutationIfOwned = useCallback((controller: AbortController) => {
    if (mutationControllerRef.current === controller) {
      mutationControllerRef.current = null;
    }
  }, []);

  const fencePageWork = useCallback(() => {
    listGenerationRef.current += 1;
    historyGenerationRef.current += 1;
    mutationGenerationRef.current += 1;
    createSendGenerationRef.current += 1;
    pendingCreateSendRef.current = null;
    abortList();
    abortHistory();
    abortMutation();
    abortCreate();
    closeSource();
  }, [abortCreate, abortHistory, abortList, abortMutation, closeSource]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fencePageWork();
    };
  }, [fencePageWork]);

  // 一次列表读取：中止在途的并重发。`silent`（列表事件触发）失败时保留现有列表、不置错误。
  const readList = useCallback(
    (ownedClient: ApiClient, silent: boolean) => {
      if (ownedClient !== clientRef.current) {
        return null;
      }
      abortList();
      const controller = new AbortController();
      listControllerRef.current = controller;
      listGenerationRef.current += 1;
      const generation = listGenerationRef.current;
      const flight = ownedClient
        .listSessions({ signal: controller.signal })
        .then(({ sessions }) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            generation !== listGenerationRef.current ||
            ownedClient !== clientRef.current
          ) {
            return;
          }
          setListState({ status: "success", client: ownedClient, sessions });
        })
        .catch((error: unknown) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            generation !== listGenerationRef.current ||
            ownedClient !== clientRef.current ||
            isUnauthorized(error) ||
            silent
          ) {
            return;
          }
          setListState({ status: "error", client: ownedClient, message: errorMessage(error) });
        });
      refreshWorkspaces(ownedClient, silent);
      return flight;
    },
    [abortList, refreshWorkspaces],
  );
  const refreshList = useSessionListEvents({
    client,
    readList,
    selected() {
      const sessionId = sourceSessionRef.current;
      const source = sourceRef.current;
      return source !== null && sessionId !== null && sessionId === requestedSessionRef.current
        ? { sessionId, running: viewRunningRef.current, resync: source.resync }
        : null;
    },
    // 按会话计：只有针对当前选中会话的在途撤回才略过对齐，并记下这笔欠账（撤回落定处据此补读）。
    undoInFlight() {
      const flight = undoFlightRef.current;
      if (
        flight?.client !== clientRef.current ||
        flight.sessionId !== requestedSessionRef.current
      ) {
        return false;
      }
      undoSkippedResyncRef.current = flight;
      return true;
    },
  });
  const sessionActions = useSessionActions(client, setListState, setHistoryState, {
    abortHistory,
    closeSource,
    history: historyState,
    list: listState,
    refreshList,
    requestedSessionRef,
    setPromptError,
  });

  useEffect(() => {
    fencePageWork();
    setListState({ status: "loading", client });
    setHistoryState({ status: "idle" });
    setPromptError(null);
    setStreamError(null);
    setCreating(false);
    setSubmitting(false);
    setMutationOwner(null);
    refreshList(client);
    return () => {
      abortList();
    };
  }, [abortList, client, fencePageWork, refreshList]);

  const installSnapshot = useCallback((snapshot: ChatMessageSnapshot, ownedClient: ApiClient) => {
    if (ownedClient !== clientRef.current || snapshot.session.id !== requestedSessionRef.current) {
      return;
    }
    setHistoryState({
      status: "ready",
      client: ownedClient,
      snapshot,
      view: chatStateFromSnapshot(snapshot),
    });
    setStreamError(null);
  }, []);

  const openSource = useCallback(
    (snapshot: ChatMessageSnapshot, ownedClient: ApiClient) => {
      closeSource();
      const EventSourceCtor = globalThis.EventSource;
      const sessionId = snapshot.session.id;
      if (typeof EventSourceCtor !== "function") {
        setStreamError({
          client: ownedClient,
          sessionId,
          message: `${MISSING_EVENT_SOURCE}。${TERMINAL_REFRESH_GUIDANCE}`,
        });
        return;
      }
      const handle: SessionEventHandle = connectSessionEvents(sessionId, {
        EventSourceCtor,
        initialCursor: snapshot.streamCursor,
        loadSnapshot(signal) {
          return ownedClient.getMessages(sessionId, { signal });
        },
        onSnapshot(next) {
          if (
            sourceSessionRef.current !== sessionId ||
            ownedClient !== clientRef.current ||
            next.session.id !== requestedSessionRef.current
          ) {
            return;
          }
          installSnapshot(next, ownedClient);
        },
        onEvent(event: ChatEvent) {
          if (sourceSessionRef.current !== sessionId || ownedClient !== clientRef.current) {
            return;
          }
          setHistoryState((current) => {
            if (
              current.status !== "ready" ||
              current.client !== ownedClient ||
              current.snapshot.session.id !== sessionId ||
              sessionId !== requestedSessionRef.current
            ) {
              return current;
            }
            if (isUnknownTurn(current.view, event)) {
              // Not reduced: the recovery snapshot brings the turn. One request per connection
              // until a snapshot install replaces this state.
              return current.resync?.source === handle
                ? current
                : { ...current, resync: { source: handle } };
            }
            return { ...current, view: applyChatEvent(current.view, event) };
          });
        },
        onError(error) {
          if (sourceSessionRef.current !== sessionId || ownedClient !== clientRef.current) {
            return;
          }
          setStreamError({
            client: ownedClient,
            sessionId,
            message: `${errorMessage(error)}。${TERMINAL_REFRESH_GUIDANCE}`,
          });
        },
      });
      sourceRef.current = handle;
      sourceSessionRef.current = sessionId;
    },
    [closeSource, installSnapshot],
  );

  const loadHistory = useCallback(
    (sessionId: string, ownedClient: ApiClient) => {
      abortHistory();
      closeSource();
      const controller = new AbortController();
      historyControllerRef.current = controller;
      historyGenerationRef.current += 1;
      const generation = historyGenerationRef.current;
      setHistoryState({ status: "loading", client: ownedClient, sessionId });
      setStreamError(null);
      void ownedClient
        .getMessages(sessionId, { signal: controller.signal })
        .then((snapshot) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            generation !== historyGenerationRef.current ||
            ownedClient !== clientRef.current ||
            requestedSessionRef.current !== sessionId
          ) {
            return;
          }
          installSnapshot(snapshot, ownedClient);
          openSource(snapshot, ownedClient);
        })
        .catch((error: unknown) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            generation !== historyGenerationRef.current ||
            ownedClient !== clientRef.current ||
            requestedSessionRef.current !== sessionId ||
            isUnauthorized(error)
          ) {
            return;
          }
          if (isNotFound(error)) {
            setHistoryState({ status: "idle" });
            navigate(sessionNavigation(location.pathname, location.search, location.hash, null), {
              replace: true,
            });
            return;
          }
          setHistoryState({
            status: "error",
            client: ownedClient,
            sessionId,
            message: errorMessage(error),
          });
        });
    },
    [
      abortHistory,
      closeSource,
      installSnapshot,
      location.hash,
      location.pathname,
      location.search,
      navigate,
      openSource,
    ],
  );
  const loadHistoryRef = useRef(loadHistory);
  loadHistoryRef.current = loadHistory;

  const selectSession = useCallback(
    (sessionId: string | null) => {
      navigate(sessionNavigation(location.pathname, location.search, location.hash, sessionId));
    },
    [location.hash, location.pathname, location.search, navigate],
  );

  const ownedHistory = ownsHistory(historyState, client, requestedSessionId);
  const listForClient =
    listState.client === client && listState.status === "success" ? listState : null;
  const selected = selectedSession(requestedSessionId, listForClient, ownedHistory, historyState);
  const slashWorkspaceId = composerWorkspaceId(requestedSessionId, selected, welcome.workspace);
  const attachments = useAttachmentsState({
    client,
    scopeKey: requestedSessionId,
    workspaceId: slashWorkspaceId,
    upload: composerOptions?.upload,
  });
  const tags = attachments.items;
  const turn = useTurnActions({
    abortMutation,
    clientRef,
    closeSource,
    composerRef,
    focusOnUnlockRef,
    historyGenerationRef,
    installSnapshot,
    loadHistoryRef,
    mountedRef,
    mutationControllerRef,
    mutationGenerationRef,
    openSource,
    pendingCreateSendRef,
    refreshList,
    releaseMutationIfOwned,
    flushAttachments: attachments.flush,
    replaceAttachments: attachments.replace,
    requestedSessionRef,
    restoreAttachments: attachments.restore,
    selectSession,
    setCreating,
    setDraft,
    setForkOwner,
    setListState,
    setMutationOwner,
    setPromptError,
    setRegenerateOwner,
    setStreamError,
    setSubmitting,
    setUndoConflict,
    setUndoNotice,
    setUndoOwner,
    undoConflict,
    undoNotice,
    undoFlightRef,
    undoSkippedResyncRef,
  });
  const { answerApproval, dispatchPrompt, forkTurn, regenerateTurn, restoreOwnedDraft, stopTurn } =
    turn;

  useEffect(() => {
    // 待决的撤回冲突不跨选择：换会话或换账号即作废，回来时不再弹出。
    setUndoConflict(null);
    setUndoNotice(null);
    const pending = pendingCreateSendRef.current;
    const keepOwnedPrompt = ownsCreateSend(pending, client, requestedSessionId);
    const keepOwnedCreate =
      pending !== null &&
      pending.client === client &&
      pending.sessionId === null &&
      pending.originSessionId === requestedSessionId;
    if (keepOwnedPrompt || keepOwnedCreate) {
      return;
    }
    if (pending && pending.client === client) {
      pendingCreateSendRef.current = null;
      createSendGenerationRef.current += 1;
      abortCreate();
      abortMutation();
      setCreating(false);
      setSubmitting(false);
      setMutationOwner(null);
    }
    if (!requestedSessionId) {
      abortHistory();
      closeSource();
      historyGenerationRef.current += 1;
      setHistoryState({ status: "idle" });
      setStreamError(null);
      return;
    }
    loadHistory(requestedSessionId, client);
    return () => {
      if (ownsCreateSend(pendingCreateSendRef.current, client, requestedSessionId)) {
        return;
      }
      abortHistory();
      closeSource();
    };
  }, [
    abortCreate,
    abortHistory,
    abortMutation,
    client,
    closeSource,
    loadHistory,
    requestedSessionId,
  ]);

  useEffect(() => {
    const pending = pendingCreateSendRef.current;
    if (
      !ownsCreateSend(pending, client, requestedSessionId) ||
      pending.accepted ||
      mutationControllerRef.current
    ) {
      return;
    }
    dispatchPrompt(pending.sessionId, pending.prompt, pending.generation, pending.client);
  }, [client, dispatchPrompt, requestedSessionId]);

  // 会话只在欢迎态首次发送时创建：恰一次创建，选中返回的 id 后恰一次 prompt。
  const createAndSelect = useCallback(
    (prompt: string) => {
      if (createControllerRef.current || mutationControllerRef.current) {
        return;
      }
      const controller = new AbortController();
      createControllerRef.current = controller;
      createSendGenerationRef.current += 1;
      const generation = createSendGenerationRef.current;
      const originSessionId = requestedSessionId;
      pendingCreateSendRef.current = {
        accepted: false,
        client,
        generation,
        originSessionId,
        prompt,
        sessionId: null,
      };
      setSubmitting(true);
      setCreating(true);
      setMutationOwner({
        client,
        originSessionId,
        sessionId: null,
      });
      setPromptError(null);
      void client
        .createSession(welcome.createBody(), { signal: controller.signal })
        .then((session) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            generation !== createSendGenerationRef.current ||
            client !== clientRef.current
          ) {
            return;
          }
          createControllerRef.current = null;
          if (pendingCreateSendRef.current?.generation === generation) {
            pendingCreateSendRef.current = {
              accepted: false,
              client,
              generation,
              originSessionId: pendingCreateSendRef.current.originSessionId,
              prompt: pendingCreateSendRef.current.prompt,
              sessionId: session.id,
            };
            setMutationOwner({
              client,
              originSessionId: pendingCreateSendRef.current.originSessionId,
              sessionId: session.id,
            });
          } else {
            setCreating(false);
            setMutationOwner(null);
          }
          attachments.adopt(session.id, session.workspaceId);
          refreshList(client);
          navigate(
            sessionNavigation(location.pathname, location.search, location.hash, session.id),
          );
        })
        .catch((error: unknown) => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            generation !== createSendGenerationRef.current ||
            isUnauthorized(error)
          ) {
            if (createControllerRef.current === controller) {
              createControllerRef.current = null;
            }
            return;
          }
          const rejectedPrompt =
            pendingCreateSendRef.current?.generation === generation
              ? pendingCreateSendRef.current.prompt
              : "";
          createControllerRef.current = null;
          pendingCreateSendRef.current = null;
          restoreOwnedDraft(rejectedPrompt, client, originSessionId);
          setCreating(false);
          setSubmitting(false);
          setMutationOwner(null);
          setPromptError({
            client,
            sessionId: originSessionId,
            message: errorMessage(error),
          });
        });
    },
    [
      attachments.adopt,
      client,
      location.hash,
      location.pathname,
      location.search,
      navigate,
      refreshList,
      requestedSessionId,
      restoreOwnedDraft,
      welcome.createBody,
    ],
  );
  // 发送路径的文本入口：表单提交与运行时适配器的 `onNew` 都走这里。
  const sendPrompt = useCallback(
    (prompt: string) => {
      if (creating || submitting || createControllerRef.current || mutationControllerRef.current) {
        return;
      }
      if (!canSend(prompt, tags)) {
        return;
      }
      setDraft("");
      setUndoNotice(null);
      if (!requestedSessionId) {
        createAndSelect(prompt);
        return;
      }
      createSendGenerationRef.current += 1;
      const generation = createSendGenerationRef.current;
      pendingCreateSendRef.current = {
        accepted: false,
        client,
        generation,
        originSessionId: requestedSessionId,
        prompt,
        sessionId: requestedSessionId,
      };
      setMutationOwner({
        client,
        originSessionId: requestedSessionId,
        sessionId: requestedSessionId,
      });
      dispatchPrompt(requestedSessionId, prompt, generation, client);
    },
    [client, createAndSelect, creating, dispatchPrompt, requestedSessionId, submitting, tags],
  );
  const submitComposer = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      sendPrompt(draft);
    },
    [draft, sendPrompt],
  );

  useEffect(() => {
    if (historyState.status !== "ready" || historyState.client !== client) {
      return;
    }
    const sessionId = historyState.snapshot.session.id;
    const nextStatus = historyState.view.status;
    setListState((list) => {
      if (list.status !== "success" || list.client !== historyState.client) {
        return list;
      }
      const current = list.sessions.find((session) => session.id === sessionId);
      if (!current || current.status === nextStatus) {
        return list;
      }
      return {
        status: "success",
        client: list.client,
        sessions: list.sessions.map((session) =>
          session.id === sessionId ? { ...session, status: nextStatus } : session,
        ),
      };
    });
  }, [client, historyState]);

  const resyncRequest = historyState.status === "ready" ? historyState.resync : undefined;
  useEffect(() => {
    // Only the connection that delivered the unknown turn, and only while it is still current.
    if (resyncRequest !== undefined && resyncRequest.source === sourceRef.current) {
      resyncRequest.source.resync();
    }
  }, [resyncRequest]);

  const historyView = ownedHistory && historyState.status === "ready" ? historyState.view : null;
  viewRunningRef.current = historyView?.status === "running";
  const workspace = workspaces?.find((item) => item.id === selected?.workspaceId);
  // 产物用的「空间可解析」判定；`temporaryWorkspace` 取自 `selected`（列表优先），转正后随列表翻转。
  const spaceId = selected?.workspaceId;
  const temporary = selected?.temporaryWorkspace ?? false;
  const space = useMemo(
    () => resolveSessionSpace(spaceId, temporary, workspaces),
    [spaceId, temporary, workspaces],
  );
  const ownedBusy = ownsMutation(mutationOwner, client, requestedSessionId);
  const ownedStreamError = visibleOwnedAlert(streamError, client, requestedSessionId);
  const { composerDisabled, generating, sendDisabled } = composerLocks({
    sending: ownedBusy && (creating || submitting),
    regenerating: ownsMutation(regenerateOwner, client, requestedSessionId),
    running: historyView?.status === "running",
    historyLoading: ownedHistory && historyState.status === "loading",
    forking: ownsMutation(forkOwner, client, requestedSessionId),
    streamFailed: Boolean(ownedStreamError),
    undoing: ownsMutation(undoOwner, client, requestedSessionId),
    draft,
    attachments: tags,
  });

  // `新建会话`：replace 导航回欢迎态，不发请求、不动草稿。`focusComposer` 为假（侧栏是覆盖层）时
  // 焦点交给外壳；已在欢迎态时只聚焦。离开会话后输入框解锁的那次提交里才聚焦（锁定时 focus 无效）。
  const showWelcome = useCallback(
    (focusComposer: boolean) => {
      if (!requestedSessionId) {
        if (focusComposer) composerRef.current?.focus();
        return;
      }
      // 首次发送的「创建—发送」交接尚未落定：不导航、不中止，否则会留下一个没有消息的会话。
      if (blocksNewSession(pendingCreateSendRef.current, client, requestedSessionId)) {
        return;
      }
      focusOnWelcomeRef.current = focusComposer;
      navigate(sessionNavigation(location.pathname, location.search, location.hash, null), {
        replace: true,
      });
    },
    [client, location.hash, location.pathname, location.search, navigate, requestedSessionId],
  );
  useEffect(() => {
    if (requestedSessionId || composerDisabled || !focusOnWelcomeRef.current) {
      return;
    }
    focusOnWelcomeRef.current = false;
    composerRef.current?.focus();
  }, [composerDisabled, requestedSessionId]);
  // 撤回落定后：标记只在置位后的第一次提交里有效（无依赖数组）。那次提交输入框若仍锁定，
  // `focus()` 无效、标记照样清掉，不留到以后无关的解锁。
  useEffect(() => {
    if (focusOnUnlockRef.current) {
      focusOnUnlockRef.current = false;
      composerRef.current?.focus();
    }
  });

  return {
    answerApproval,
    attachments,
    client,
    composerDisabled,
    composerOptions,
    composerRef,
    draft,
    forkTurn,
    generating,
    historyError: ownedHistory && historyState.status === "error" ? historyState.message : null,
    historyView,
    listError:
      listState.client === client && listState.status === "error" ? listState.message : null,
    listLoading: listState.client === client && listState.status === "loading",
    promptError: visibleOwnedAlert(promptError, client, requestedSessionId),
    regenerateTurn,
    requestedSessionId,
    selectSession,
    selected,
    sendDisabled,
    sendPrompt,
    sessionActions,
    sessions: listForClient?.sessions ?? null,
    setDraft,
    showWelcome,
    slashWorkspaceId,
    space,
    stopTurn,
    streamError: ownedStreamError,
    submitComposer,
    undoConflict: turn.undoConflictFor(client, requestedSessionId),
    undoNotice: turn.undoNoticeFor(client, requestedSessionId),
    undoTurn: turn.undoTurn,
    welcome,
    workspace,
    workspaces,
  };
}
