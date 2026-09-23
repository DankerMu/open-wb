import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { type ApiClient, ApiError, REQUEST_FAILED_MESSAGE } from "../../lib/api.js";
import type { ChatMessageSnapshot, ChatSession } from "../../lib/session-contract.js";
import { useAuth } from "../auth/index.js";
import { ConversationView } from "./conversation-view.js";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
  connectSessionEvents,
} from "./stream.js";

type ChatListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; client: ApiClient; sessions: ChatSession[] };

type ChatHistoryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: ChatMessageSnapshot; view: ChatState };

type SessionEventHandle = { close(): void };

type PendingCreateSend = {
  client: ApiClient;
  generation: number;
  originSessionId: string | null;
  prompt: string;
  sessionId: string | null;
};

const COMPOSER_LABEL = "给助手发消息";
const GENERATING_LABEL = "生成中";
const TITLE_FALLBACK = "新会话";
const TERMINAL_REFRESH_GUIDANCE = "请刷新页面后重试";
const EMPTY_SELECTION = "选择一个会话，或直接发送开始新对话";
const MISSING_EVENT_SOURCE = "无法连接会话事件";

function isUnauthorized(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

function isNotFound(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

function sessionNavigation(
  pathname: string,
  search: string,
  hash: string,
  sessionId: string | null,
) {
  const parameters = new URLSearchParams(search);
  if (sessionId) {
    parameters.set("session", sessionId);
  } else {
    parameters.delete("session");
  }
  const nextSearch = parameters.toString();
  return { hash, pathname, search: nextSearch.length === 0 ? "" : `?${nextSearch}` };
}

function sessionTitle(session: ChatSession) {
  return session.title && session.title.length > 0 ? session.title : TITLE_FALLBACK;
}

function ownsCreateSend(
  pending: PendingCreateSend | null,
  client: ApiClient,
  sessionId: string | null,
): pending is PendingCreateSend & { sessionId: string } {
  return (
    pending !== null &&
    pending.client === client &&
    pending.sessionId !== null &&
    pending.sessionId === sessionId
  );
}

export function ChatPage() {
  const { createSessionClient } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  const location = useLocation();
  const navigate = useNavigate();
  const requestedSessionId = new URLSearchParams(location.search).get("session");
  const [draft, setDraft] = useState("");
  const [listState, setListState] = useState<ChatListState>({ status: "loading" });
  const [historyState, setHistoryState] = useState<ChatHistoryState>({ status: "idle" });
  const [promptError, setPromptError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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

  const refreshList = useCallback(
    (ownedClient: ApiClient) => {
      if (ownedClient !== clientRef.current) {
        return;
      }
      abortList();
      const controller = new AbortController();
      listControllerRef.current = controller;
      listGenerationRef.current += 1;
      const generation = listGenerationRef.current;
      void ownedClient
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
            isUnauthorized(error)
          ) {
            return;
          }
          setListState({ status: "error", message: errorMessage(error) });
        });
    },
    [abortList],
  );

  useEffect(() => {
    fencePageWork();
    setListState({ status: "loading" });
    setHistoryState({ status: "idle" });
    setPromptError(null);
    setStreamError(null);
    setCreating(false);
    setSubmitting(false);
    refreshList(client);
    return () => {
      abortList();
    };
  }, [abortList, client, fencePageWork, refreshList]);

  const installSnapshot = useCallback((snapshot: ChatMessageSnapshot) => {
    if (snapshot.session.id !== requestedSessionRef.current) {
      return;
    }
    setHistoryState({ status: "ready", snapshot, view: chatStateFromSnapshot(snapshot) });
    setStreamError(null);
  }, []);

  const openSource = useCallback(
    (snapshot: ChatMessageSnapshot) => {
      closeSource();
      const EventSourceCtor = globalThis.EventSource;
      if (typeof EventSourceCtor !== "function") {
        setStreamError(`${MISSING_EVENT_SOURCE}。${TERMINAL_REFRESH_GUIDANCE}`);
        return;
      }
      const sessionId = snapshot.session.id;
      const ownedClient = clientRef.current;
      const handle = connectSessionEvents(sessionId, {
        EventSourceCtor,
        initialCursor: snapshot.streamCursor,
        loadSnapshot(signal) {
          return ownedClient.getMessages(sessionId, { signal });
        },
        onSnapshot(next) {
          if (
            sourceSessionRef.current !== sessionId ||
            next.session.id !== requestedSessionRef.current
          ) {
            return;
          }
          installSnapshot(next);
        },
        onEvent(event: ChatEvent) {
          if (sourceSessionRef.current !== sessionId) {
            return;
          }
          setHistoryState((current) => {
            if (
              current.status !== "ready" ||
              current.snapshot.session.id !== sessionId ||
              sessionId !== requestedSessionRef.current
            ) {
              return current;
            }
            return {
              status: "ready",
              snapshot: current.snapshot,
              view: applyChatEvent(current.view, event),
            };
          });
        },
        onError(error) {
          if (sourceSessionRef.current !== sessionId) {
            return;
          }
          setStreamError(`${errorMessage(error)}。${TERMINAL_REFRESH_GUIDANCE}`);
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
      setHistoryState({ status: "loading" });
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
          installSnapshot(snapshot);
          openSource(snapshot);
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
          setHistoryState({ status: "error", message: errorMessage(error) });
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

  const finishCreateSend = useCallback((generation: number) => {
    if (pendingCreateSendRef.current?.generation === generation) {
      pendingCreateSendRef.current = null;
    }
    setCreating(false);
    setSubmitting(false);
  }, []);

  const failOwnedPrompt = useCallback(
    (
      controller: AbortController,
      mutationGeneration: number,
      ownedClient: ApiClient,
      error: unknown,
      generation: number,
      accepted: boolean,
    ) => {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        mutationGeneration !== mutationGenerationRef.current ||
        ownedClient !== clientRef.current ||
        isUnauthorized(error)
      ) {
        releaseMutationIfOwned(controller);
        return;
      }
      if (accepted) {
        setStreamError(`${errorMessage(error)}。${TERMINAL_REFRESH_GUIDANCE}`);
        setSubmitting(false);
        releaseMutationIfOwned(controller);
        return;
      }
      setPromptError(errorMessage(error));
      finishCreateSend(generation);
      releaseMutationIfOwned(controller);
    },
    [finishCreateSend, releaseMutationIfOwned],
  );

  const dispatchPrompt = useCallback(
    (sessionId: string, prompt: string, generation: number, ownedClient: ApiClient) => {
      abortMutation();
      const controller = new AbortController();
      mutationControllerRef.current = controller;
      mutationGenerationRef.current += 1;
      const mutationGeneration = mutationGenerationRef.current;
      setSubmitting(true);
      setPromptError(null);
      void ownedClient
        .prompt(sessionId, prompt, { signal: controller.signal })
        .then(() => {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            mutationGeneration !== mutationGenerationRef.current ||
            pendingCreateSendRef.current?.generation !== generation ||
            ownedClient !== clientRef.current ||
            requestedSessionRef.current !== sessionId
          ) {
            return;
          }
          closeSource();
          return ownedClient.getMessages(sessionId, { signal: controller.signal }).then(
            (snapshot) => {
              if (
                !mountedRef.current ||
                controller.signal.aborted ||
                mutationGeneration !== mutationGenerationRef.current ||
                pendingCreateSendRef.current?.generation !== generation ||
                ownedClient !== clientRef.current ||
                requestedSessionRef.current !== sessionId
              ) {
                return;
              }
              installSnapshot(snapshot);
              openSource(snapshot);
              refreshList(ownedClient);
              finishCreateSend(generation);
              releaseMutationIfOwned(controller);
            },
            (error: unknown) => {
              failOwnedPrompt(controller, mutationGeneration, ownedClient, error, generation, true);
            },
          );
        })
        .catch((error: unknown) => {
          failOwnedPrompt(controller, mutationGeneration, ownedClient, error, generation, false);
        });
    },
    [
      abortMutation,
      closeSource,
      failOwnedPrompt,
      finishCreateSend,
      installSnapshot,
      openSource,
      refreshList,
      releaseMutationIfOwned,
    ],
  );

  useEffect(() => {
    const pending = pendingCreateSendRef.current;
    const keepOwnedPrompt =
      ownsCreateSend(pending, client, requestedSessionId) && pending.prompt.length > 0;
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
      const currentPending = pendingCreateSendRef.current;
      if (
        ownsCreateSend(currentPending, client, requestedSessionId) &&
        currentPending.prompt.length > 0
      ) {
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
      pending.prompt.length === 0 ||
      mutationControllerRef.current !== null
    ) {
      return;
    }
    dispatchPrompt(pending.sessionId, pending.prompt, pending.generation, pending.client);
  }, [client, dispatchPrompt, requestedSessionId]);

  const selectSession = useCallback(
    (sessionId: string | null) => {
      navigate(sessionNavigation(location.pathname, location.search, location.hash, sessionId));
    },
    [location.hash, location.pathname, location.search, navigate],
  );

  const createAndSelect = useCallback(
    (prompt?: string) => {
      if (createControllerRef.current || mutationControllerRef.current) {
        return;
      }
      const controller = new AbortController();
      createControllerRef.current = controller;
      createSendGenerationRef.current += 1;
      const generation = createSendGenerationRef.current;
      if (prompt !== undefined) {
        pendingCreateSendRef.current = {
          client,
          generation,
          originSessionId: requestedSessionId,
          prompt,
          sessionId: null,
        };
        setSubmitting(true);
      } else {
        pendingCreateSendRef.current = {
          client,
          generation,
          originSessionId: requestedSessionId,
          prompt: "",
          sessionId: null,
        };
      }
      setCreating(true);
      setPromptError(null);
      void client
        .createSession({ signal: controller.signal })
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
              client,
              generation,
              originSessionId: pendingCreateSendRef.current.originSessionId,
              prompt: pendingCreateSendRef.current.prompt,
              sessionId: session.id,
            };
          } else {
            setCreating(false);
          }
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
          createControllerRef.current = null;
          pendingCreateSendRef.current = null;
          setCreating(false);
          setSubmitting(false);
          setPromptError(errorMessage(error));
        });
    },
    [
      client,
      location.hash,
      location.pathname,
      location.search,
      navigate,
      refreshList,
      requestedSessionId,
    ],
  );

  const submitComposer = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (creating || submitting || createControllerRef.current || mutationControllerRef.current) {
        return;
      }
      if (draft.trim().length === 0) {
        return;
      }
      const prompt = draft;
      setDraft("");
      if (!requestedSessionId) {
        createAndSelect(prompt);
        return;
      }
      createSendGenerationRef.current += 1;
      const generation = createSendGenerationRef.current;
      pendingCreateSendRef.current = {
        client,
        generation,
        originSessionId: requestedSessionId,
        prompt,
        sessionId: requestedSessionId,
      };
      dispatchPrompt(requestedSessionId, prompt, generation, client);
    },
    [client, createAndSelect, creating, dispatchPrompt, draft, requestedSessionId, submitting],
  );

  useEffect(() => {
    if (historyState.status !== "ready") {
      return;
    }
    const sessionId = historyState.snapshot.session.id;
    const nextStatus = historyState.view.status;
    setListState((list) => {
      if (list.status !== "success") {
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
  }, [historyState]);

  const listForClient =
    listState.status === "success" && listState.client === client ? listState : null;
  const historyView = historyState.status === "ready" ? historyState.view : null;
  const generating =
    creating ||
    submitting ||
    historyState.status === "loading" ||
    historyView?.status === "running" ||
    Boolean(streamError);
  const sendDisabled = generating || draft.trim().length === 0;

  return (
    <section>
      <h1>会话</h1>
      <ConversationView
        composerDisabled={generating}
        composerLabel={COMPOSER_LABEL}
        draft={draft}
        emptySelection={EMPTY_SELECTION}
        generating={generating}
        generatingLabel={GENERATING_LABEL}
        historyError={historyState.status === "error" ? historyState.message : null}
        historyView={historyView}
        listError={listState.status === "error" ? listState.message : null}
        listLoading={listState.status === "loading"}
        onChangeDraft={setDraft}
        onCreateSession={() => createAndSelect()}
        onSelectSession={selectSession}
        onSubmit={submitComposer}
        promptError={promptError}
        requestedSessionId={requestedSessionId}
        sendDisabled={sendDisabled}
        sessions={listForClient?.sessions ?? null}
        sessionTitle={sessionTitle}
        streamError={streamError}
      />
    </section>
  );
}
