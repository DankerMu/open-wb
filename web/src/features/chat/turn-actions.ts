// 会话页回合操作：prompt 派发及其所有权 fence、审批作答、停止、重新生成、从此处分叉（由 useChatSession 调用并注入 fence 状态）。
import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import { type ApiClient, ApiError } from "../../lib/api.js";
import type { ChatMessageSnapshot } from "../../lib/session-contract.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import type { ChatMutationOwner, ChatOwnedAlert, PendingCreateSend } from "./types.js";

export const TERMINAL_REFRESH_GUIDANCE = "请刷新页面后重试";

/** 409 `approval_settled`: the approval was already settled server-side (by `code`, not status). */
function isApprovalSettled(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.code === "approval_settled";
}

/**
 * Regenerate rejections that prove no server commit (409/400/503, or 401 handed to login). Anything
 * else, 502 included, may follow a commit that deleted the old answer, so the page reconciles.
 */
function isUncommittedRegenerate(error: unknown) {
  return error instanceof ApiError && [400, 401, 409, 503].includes(error.status);
}

type TurnActionDeps = {
  abortMutation: () => void;
  clientRef: RefObject<ApiClient>;
  closeSource: () => void;
  historyGenerationRef: RefObject<number>;
  installSnapshot: (snapshot: ChatMessageSnapshot, ownedClient: ApiClient) => void;
  mountedRef: RefObject<boolean>;
  mutationControllerRef: RefObject<AbortController | null>;
  mutationGenerationRef: RefObject<number>;
  openSource: (snapshot: ChatMessageSnapshot, ownedClient: ApiClient) => void;
  pendingCreateSendRef: RefObject<PendingCreateSend | null>;
  refreshList: (ownedClient: ApiClient) => void;
  releaseMutationIfOwned: (controller: AbortController) => void;
  requestedSessionRef: RefObject<string | null>;
  selectSession: (sessionId: string | null) => void;
  setCreating: Dispatch<SetStateAction<boolean>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setForkOwner: Dispatch<SetStateAction<ChatMutationOwner | null>>;
  setMutationOwner: Dispatch<SetStateAction<ChatMutationOwner | null>>;
  setPromptError: Dispatch<SetStateAction<ChatOwnedAlert | null>>;
  setRegenerateOwner: Dispatch<SetStateAction<ChatMutationOwner | null>>;
  setStreamError: Dispatch<SetStateAction<ChatOwnedAlert | null>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
};

export function useTurnActions({
  abortMutation,
  clientRef,
  closeSource,
  historyGenerationRef,
  installSnapshot,
  mountedRef,
  mutationControllerRef,
  mutationGenerationRef,
  openSource,
  pendingCreateSendRef,
  refreshList,
  releaseMutationIfOwned,
  requestedSessionRef,
  selectSession,
  setCreating,
  setDraft,
  setForkOwner,
  setMutationOwner,
  setPromptError,
  setRegenerateOwner,
  setStreamError,
  setSubmitting,
}: TurnActionDeps) {
  const restoreOwnedDraft = useCallback(
    (prompt: string, ownedClient: ApiClient, sessionId: string | null) => {
      if (
        prompt.length === 0 ||
        ownedClient !== clientRef.current ||
        requestedSessionRef.current !== sessionId
      ) {
        return;
      }
      setDraft((current) => (current.length === 0 ? prompt : current));
    },
    [clientRef, requestedSessionRef, setDraft],
  );

  const finishCreateSend = useCallback(
    (generation: number) => {
      if (pendingCreateSendRef.current?.generation === generation) {
        pendingCreateSendRef.current = null;
      }
      setCreating(false);
      setSubmitting(false);
      setMutationOwner(null);
    },
    [pendingCreateSendRef, setCreating, setMutationOwner, setSubmitting],
  );

  const failOwnedPrompt = useCallback(
    (
      controller: AbortController,
      mutationGeneration: number,
      ownedClient: ApiClient,
      error: unknown,
      generation: number,
      accepted: boolean,
    ) => {
      const pending =
        pendingCreateSendRef.current?.generation === generation
          ? pendingCreateSendRef.current
          : null;
      const ownedSessionId = pending?.sessionId ?? pending?.originSessionId ?? null;
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
        setStreamError({
          client: ownedClient,
          sessionId: ownedSessionId,
          message: `${errorMessage(error)}。${TERMINAL_REFRESH_GUIDANCE}`,
        });
        setSubmitting(false);
        releaseMutationIfOwned(controller);
        return;
      }
      restoreOwnedDraft(pending?.prompt ?? "", ownedClient, ownedSessionId);
      setPromptError({
        client: ownedClient,
        sessionId: ownedSessionId,
        message: errorMessage(error),
      });
      finishCreateSend(generation);
      releaseMutationIfOwned(controller);
    },
    [
      clientRef,
      finishCreateSend,
      mountedRef,
      mutationGenerationRef,
      pendingCreateSendRef,
      releaseMutationIfOwned,
      restoreOwnedDraft,
      setPromptError,
      setStreamError,
      setSubmitting,
    ],
  );
  const dispatchPrompt = useCallback(
    (sessionId: string, prompt: string, generation: number, ownedClient: ApiClient) => {
      abortMutation();
      const controller = new AbortController();
      mutationControllerRef.current = controller;
      mutationGenerationRef.current += 1;
      const mutationGeneration = mutationGenerationRef.current;
      setSubmitting(true);
      setMutationOwner({
        client: ownedClient,
        originSessionId: sessionId,
        sessionId,
      });
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
              installSnapshot(snapshot, ownedClient);
              openSource(snapshot, ownedClient);
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
      clientRef,
      closeSource,
      failOwnedPrompt,
      finishCreateSend,
      installSnapshot,
      mountedRef,
      mutationControllerRef,
      mutationGenerationRef,
      openSource,
      pendingCreateSendRef,
      refreshList,
      releaseMutationIfOwned,
      requestedSessionRef,
      setMutationOwner,
      setPromptError,
      setSubmitting,
    ],
  );

  // Approval answers, stop and regenerate never touch the prompt mutation fence: writes that must
  // not abort a prompt. Their late results are fenced by client, selected session and mount only.
  const ownsSessionWrite = useCallback(
    (ownedClient: ApiClient, sessionId: string) =>
      mountedRef.current &&
      ownedClient === clientRef.current &&
      requestedSessionRef.current === sessionId,
    [clientRef, mountedRef, requestedSessionRef],
  );

  /** Silent reconcile (approval 409, regenerate 502): old source stays open until the snapshot. */
  const reconcileSettled = useCallback(
    (ownedClient: ApiClient, sessionId: string) => {
      void ownedClient.getMessages(sessionId).then(
        (snapshot) => {
          if (!ownsSessionWrite(ownedClient, sessionId)) {
            return;
          }
          installSnapshot(snapshot, ownedClient);
          openSource(snapshot, ownedClient);
        },
        () => undefined,
      );
    },
    [installSnapshot, openSource, ownsSessionWrite],
  );

  /** Resolves `true` when the bar may answer again (inline error shown); never rejects. */
  const answerApproval = useCallback(
    (approvalId: number, decision: "allow" | "deny"): Promise<boolean> => {
      const ownedClient = clientRef.current;
      const sessionId = requestedSessionRef.current;
      if (sessionId === null) {
        return Promise.resolve(false);
      }
      setPromptError(null);
      return ownedClient.decideApproval(sessionId, approvalId, decision).then(
        () => false,
        (error: unknown) => {
          if (!ownsSessionWrite(ownedClient, sessionId) || isUnauthorized(error)) {
            return false;
          }
          if (isApprovalSettled(error)) {
            reconcileSettled(ownedClient, sessionId);
            return false;
          }
          setPromptError({ client: ownedClient, sessionId, message: errorMessage(error) });
          return true;
        },
      );
    },
    [clientRef, ownsSessionWrite, reconcileSettled, requestedSessionRef, setPromptError],
  );

  /**
   * Resolves `"stopping"` on 202 for the still-owned session, else `null`; never rejects. 204
   * (`"idle"`) writes nothing: the composer follows the next authoritative event or snapshot.
   */
  const stopTurn = useCallback((): Promise<"stopping" | null> => {
    const ownedClient = clientRef.current;
    const sessionId = requestedSessionRef.current;
    if (sessionId === null) {
      return Promise.resolve(null);
    }
    setPromptError(null);
    return ownedClient.stopSession(sessionId).then(
      (result) =>
        result === "stopping" && ownsSessionWrite(ownedClient, sessionId) ? result : null,
      (error: unknown) => {
        if (ownsSessionWrite(ownedClient, sessionId) && !isUnauthorized(error)) {
          setPromptError({ client: ownedClient, sessionId, message: errorMessage(error) });
        }
        return null;
      },
    );
  }, [clientRef, ownsSessionWrite, requestedSessionRef, setPromptError]);

  // Page-level lock (never the prompt fence) released by identity on every branch; never rejects.
  const regenerateTurn = useCallback((): Promise<boolean> => {
    const ownedClient = clientRef.current;
    const sessionId = requestedSessionRef.current;
    if (sessionId === null) {
      return Promise.resolve(false);
    }
    const owner: ChatMutationOwner = { client: ownedClient, originSessionId: sessionId, sessionId };
    const release = () => setRegenerateOwner((current) => (current === owner ? null : current));
    const owned = () => ownsSessionWrite(ownedClient, sessionId);
    const fail = (error: unknown, write: typeof setPromptError, suffix = "") => {
      if (owned() && !isUnauthorized(error)) {
        write({ client: ownedClient, sessionId, message: `${errorMessage(error)}${suffix}` });
      }
      release();
    };
    setPromptError(null);
    setRegenerateOwner(owner);
    return ownedClient.regenerateSession(sessionId).then(
      () => {
        if (!owned()) {
          release();
          return false;
        }
        closeSource();
        void ownedClient.getMessages(sessionId).then(
          (snapshot) => {
            if (owned()) {
              installSnapshot(snapshot, ownedClient);
              openSource(snapshot, ownedClient);
              refreshList(ownedClient);
            }
            release();
          },
          (error: unknown) => fail(error, setStreamError, `。${TERMINAL_REFRESH_GUIDANCE}`),
        );
        return true;
      },
      (error: unknown) => {
        fail(error, setPromptError);
        if (owned() && !isUncommittedRegenerate(error)) {
          reconcileSettled(ownedClient, sessionId);
        }
        return false;
      },
    );
  }, [
    clientRef,
    closeSource,
    installSnapshot,
    openSource,
    ownsSessionWrite,
    reconcileSettled,
    refreshList,
    requestedSessionRef,
    setPromptError,
    setRegenerateOwner,
    setStreamError,
  ]);

  // Regenerate's lock shape plus the history token (no reload since the click: ABA). Never rejects.
  const forkTurn = useCallback(
    (messageId: number): Promise<void> => {
      const ownedClient = clientRef.current;
      const sessionId = requestedSessionRef.current;
      if (sessionId === null) {
        return Promise.resolve();
      }
      const generation = historyGenerationRef.current;
      const owner = { client: ownedClient, originSessionId: sessionId, sessionId };
      const release = () => setForkOwner((current) => (current === owner ? null : current));
      const owned = () =>
        ownsSessionWrite(ownedClient, sessionId) && historyGenerationRef.current === generation;
      setPromptError(null);
      setForkOwner(owner);
      return ownedClient.forkSession(sessionId, messageId).then(
        (fork) => {
          release();
          if (owned()) {
            setDraft(fork.draft);
            refreshList(ownedClient);
            selectSession(fork.session.id);
          }
        },
        (error: unknown) => {
          release();
          if (owned() && !isUnauthorized(error)) {
            setPromptError({ client: ownedClient, sessionId, message: errorMessage(error) });
          }
        },
      );
    },
    [
      clientRef,
      historyGenerationRef,
      ownsSessionWrite,
      refreshList,
      requestedSessionRef,
      selectSession,
      setDraft,
      setForkOwner,
      setPromptError,
    ],
  );

  return { answerApproval, dispatchPrompt, forkTurn, regenerateTurn, restoreOwnedDraft, stopTurn };
}
