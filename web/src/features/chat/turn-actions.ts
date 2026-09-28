// 会话页回合操作：prompt 派发及其所有权 fence、审批作答（由 ChatPage 调用；stop/regenerate/fork 的落点）。
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

type TurnActionDeps = {
  abortMutation: () => void;
  clientRef: RefObject<ApiClient>;
  closeSource: () => void;
  installSnapshot: (snapshot: ChatMessageSnapshot, ownedClient: ApiClient) => void;
  mountedRef: RefObject<boolean>;
  mutationControllerRef: RefObject<AbortController | null>;
  mutationGenerationRef: RefObject<number>;
  openSource: (snapshot: ChatMessageSnapshot, ownedClient: ApiClient) => void;
  pendingCreateSendRef: RefObject<PendingCreateSend | null>;
  refreshList: (ownedClient: ApiClient) => void;
  releaseMutationIfOwned: (controller: AbortController) => void;
  requestedSessionRef: RefObject<string | null>;
  setCreating: Dispatch<SetStateAction<boolean>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setMutationOwner: Dispatch<SetStateAction<ChatMutationOwner | null>>;
  setPromptError: Dispatch<SetStateAction<ChatOwnedAlert | null>>;
  setStreamError: Dispatch<SetStateAction<ChatOwnedAlert | null>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
};

export function useTurnActions({
  abortMutation,
  clientRef,
  closeSource,
  installSnapshot,
  mountedRef,
  mutationControllerRef,
  mutationGenerationRef,
  openSource,
  pendingCreateSendRef,
  refreshList,
  releaseMutationIfOwned,
  requestedSessionRef,
  setCreating,
  setDraft,
  setMutationOwner,
  setPromptError,
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

  // Approval answers never touch the prompt mutation fence: a write that must not abort a prompt.
  const ownsAnswer = useCallback(
    (ownedClient: ApiClient, sessionId: string) =>
      mountedRef.current &&
      ownedClient === clientRef.current &&
      requestedSessionRef.current === sessionId,
    [clientRef, mountedRef, requestedSessionRef],
  );

  /** Silent reconcile after 409: the old source stays open until the snapshot is in hand. */
  const reconcileSettled = useCallback(
    (ownedClient: ApiClient, sessionId: string) => {
      void ownedClient.getMessages(sessionId).then(
        (snapshot) => {
          if (!ownsAnswer(ownedClient, sessionId)) {
            return;
          }
          installSnapshot(snapshot, ownedClient);
          openSource(snapshot, ownedClient);
        },
        () => undefined,
      );
    },
    [installSnapshot, openSource, ownsAnswer],
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
          if (!ownsAnswer(ownedClient, sessionId) || isUnauthorized(error)) {
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
    [clientRef, ownsAnswer, reconcileSettled, requestedSessionRef, setPromptError],
  );

  return { answerApproval, dispatchPrompt, restoreOwnedDraft };
}
