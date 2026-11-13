// 欢迎态首次发送的建会话与交接（由 useChatSession 调用并注入 fence 状态）：恰一次 `createSession`，暂存的附件
// 与知识库引用交给新会话，选中返回的 id；那唯一一次 prompt 由会话页在选中之后派发。
import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ApiClient } from "../../lib/api.js";
import type { useAttachmentsState } from "./attachments-state.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { sessionNavigation } from "./session-path.js";
import type { ChatMutationOwner, ChatOwnedAlert, PendingCreateSend } from "./types.js";
import type { WelcomeOptions } from "./welcome-options.js";

type CreateAndSelectDeps = {
  adoptAttachments: ReturnType<typeof useAttachmentsState>["adopt"];
  /** 欢迎态暂存的知识库引用交给新会话（与附件同处、导航之前），首次发送那次 prompt 发出时引用还在。 */
  adoptKbRefs: (sessionId: string) => void;
  client: ApiClient;
  clientRef: RefObject<ApiClient>;
  createControllerRef: RefObject<AbortController | null>;
  createSendGenerationRef: RefObject<number>;
  /** 创建带了设置键时输入框选项缓存失效。 */
  invalidateComposer: () => void;
  mountedRef: RefObject<boolean>;
  mutationControllerRef: RefObject<AbortController | null>;
  pendingCreateSendRef: RefObject<PendingCreateSend | null>;
  refreshList: (ownedClient: ApiClient) => void;
  requestedSessionId: string | null;
  restoreOwnedDraft: (prompt: string, ownedClient: ApiClient, sessionId: string | null) => void;
  setCreating: Dispatch<SetStateAction<boolean>>;
  setMutationOwner: Dispatch<SetStateAction<ChatMutationOwner | null>>;
  setPromptError: Dispatch<SetStateAction<ChatOwnedAlert | null>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  welcome: Pick<WelcomeOptions, "createBody" | "picked">;
};

// 会话只在欢迎态首次发送时创建：恰一次创建，选中返回的 id 后恰一次 prompt。
export function useCreateAndSelect({
  adoptAttachments,
  adoptKbRefs,
  client,
  clientRef,
  createControllerRef,
  createSendGenerationRef,
  invalidateComposer,
  mountedRef,
  mutationControllerRef,
  pendingCreateSendRef,
  refreshList,
  requestedSessionId,
  restoreOwnedDraft,
  setCreating,
  setMutationOwner,
  setPromptError,
  setSubmitting,
  welcome: { createBody, picked },
}: CreateAndSelectDeps) {
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(
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
      setMutationOwner({ client, originSessionId, sessionId: null });
      setPromptError(null);
      void client
        .createSession(createBody(), { signal: controller.signal })
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
          if (Object.keys(picked).length > 0) invalidateComposer(); // 创建带了设置键
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
          adoptAttachments(session.id, session.workspaceId);
          adoptKbRefs(session.id);
          refreshList(client);
          // Sync commit only holds while routes have no loader/lazy/middleware; adding one reopens
          // #1543 (guarded by chat-page-welcome-handoff.test.tsx).
          navigate(
            sessionNavigation(location.pathname, location.search, location.hash, session.id),
            { flushSync: true },
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
      adoptAttachments,
      adoptKbRefs,
      client,
      clientRef,
      createBody,
      createControllerRef,
      createSendGenerationRef,
      invalidateComposer,
      location.hash,
      location.pathname,
      location.search,
      mountedRef,
      mutationControllerRef,
      navigate,
      pendingCreateSendRef,
      picked,
      refreshList,
      requestedSessionId,
      restoreOwnedDraft,
      setCreating,
      setMutationOwner,
      setPromptError,
      setSubmitting,
    ],
  );
}
