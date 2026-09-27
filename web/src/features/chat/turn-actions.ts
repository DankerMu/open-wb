// 会话页回合操作：prompt 派发及其所有权 fence（由 ChatPage 调用；stop/regenerate/fork/approval 的落点）。
import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import type { ApiClient } from "../../lib/api.js";
import type { ChatMessageSnapshot } from "../../lib/session-contract.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import type { ChatMutationOwner, ChatOwnedAlert, PendingCreateSend } from "./types.js";

export const TERMINAL_REFRESH_GUIDANCE = "请刷新页面后重试";

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

  return { dispatchPrompt, restoreOwnedDraft };
}
