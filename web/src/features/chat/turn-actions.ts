// 会话页回合操作：prompt 派发及其所有权 fence、审批作答、停止、重新生成、从此处分叉、撤回（由 useChatSession 调用并注入 fence 状态）。
import { type Dispatch, type RefObject, type SetStateAction, useCallback } from "react";
import { type ApiClient, ApiError } from "../../lib/api.js";
import type { ChatMessageSnapshot } from "../../lib/session-contract.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import type {
  ChatListState,
  ChatMutationOwner,
  ChatOwnedAlert,
  ChatUndoNotice,
  PendingCreateSend,
} from "./types.js";

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

/** 409 `undo_conflict`：共用这个工作空间的其它会话在那之后运行过回合（按 `code` 认）。 */
function isUndoConflict(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.code === "undo_conflict";
}

type UndoFiles = Parameters<ApiClient["undoMessage"]>[2];
/** 等待用户三选一的冲突：`trigger` 是当初被点的 `撤回` 按钮。 */
export type UndoConflict = {
  client: ApiClient;
  sessionId: string;
  messageId: number;
  trigger: HTMLElement;
};

type TurnActionDeps = {
  abortMutation: () => void;
  clientRef: RefObject<ApiClient>;
  closeSource: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** 置真后的下一次提交里聚焦输入框（请求期间它是 disabled，`focus()` 无效），只此一次。 */
  focusOnUnlockRef: RefObject<boolean>;
  historyGenerationRef: RefObject<number>;
  installSnapshot: (snapshot: ChatMessageSnapshot, ownedClient: ApiClient) => void;
  /** A ref: `loadHistory` changes with the location, `dispatchPrompt` must not. */
  loadHistoryRef: RefObject<(sessionId: string, ownedClient: ApiClient) => void>;
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
  setListState: Dispatch<SetStateAction<ChatListState>>;
  setMutationOwner: Dispatch<SetStateAction<ChatMutationOwner | null>>;
  setPromptError: Dispatch<SetStateAction<ChatOwnedAlert | null>>;
  setRegenerateOwner: Dispatch<SetStateAction<ChatMutationOwner | null>>;
  setStreamError: Dispatch<SetStateAction<ChatOwnedAlert | null>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  setUndoConflict: Dispatch<SetStateAction<UndoConflict | null>>;
  setUndoNotice: Dispatch<SetStateAction<ChatUndoNotice | null>>;
  setUndoOwner: Dispatch<SetStateAction<ChatMutationOwner | null>>;
  /** 待决的撤回冲突（页面状态）。 */
  undoConflict: UndoConflict | null;
  /** 最近一次被本页应用的撤回留下的未还原文件说明（页面状态）。 */
  undoNotice: ChatUndoNotice | null;
  /** 同步的在途闩：同一会话的撤回在途时，下一次点击不发请求（状态要到下一次渲染才禁用按钮）。 */
  undoFlightRef: RefObject<ChatMutationOwner | null>;
};

export function useTurnActions({
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
  requestedSessionRef,
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
      // A welcome-state first send skipped the new session's history read to keep the handoff, and
      // nothing reads it after a rejection: read it once so the page shows that session's state.
      if (
        pending?.originSessionId === null &&
        pending.sessionId !== null &&
        requestedSessionRef.current === pending.sessionId
      ) {
        loadHistoryRef.current(pending.sessionId, ownedClient);
      }
    },
    [
      clientRef,
      finishCreateSend,
      loadHistoryRef,
      mountedRef,
      mutationGenerationRef,
      pendingCreateSendRef,
      releaseMutationIfOwned,
      requestedSessionRef,
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
          pendingCreateSendRef.current = { ...pendingCreateSendRef.current, accepted: true };
          // Before the history read: once accepted the page may leave, and the sidebar entry
          // (title, status) must not wait for a read that leaving aborts.
          refreshList(ownedClient);
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

  /**
   * Resolves the message to show inside the prompt card (which may then answer again), or `null`
   * when nothing is to be shown: accepted, 409 `approval_settled` (silent reconcile), 401, or a
   * result the page no longer owns. Never rejects and never writes the composer's inline error.
   */
  const answerApproval = useCallback(
    (approvalId: number, decision: "allow" | "deny"): Promise<string | null> => {
      const ownedClient = clientRef.current;
      const sessionId = requestedSessionRef.current;
      if (sessionId === null) {
        return Promise.resolve(null);
      }
      setPromptError(null);
      return ownedClient.decideApproval(sessionId, approvalId, decision).then(
        () => null,
        (error: unknown) => {
          if (!ownsSessionWrite(ownedClient, sessionId) || isUnauthorized(error)) {
            return null;
          }
          if (isApprovalSettled(error)) {
            reconcileSettled(ownedClient, sessionId);
            return null;
          }
          return errorMessage(error);
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
  const regenerateTurn = useCallback((): Promise<void> => {
    const ownedClient = clientRef.current;
    const sessionId = requestedSessionRef.current;
    if (sessionId === null) {
      return Promise.resolve();
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
          return;
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
      },
      (error: unknown) => {
        fail(error, setPromptError);
        if (owned() && !isUncommittedRegenerate(error)) {
          reconcileSettled(ownedClient, sessionId);
        }
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

  /**
   * `撤回`：regenerate 的锁形状（页面级、按身份释放），不带历史令牌——离开又回到同一会话后到达的 200
   * 照常应用，否则原文丢失、线程停在提交前的快照上。不弹确认。200：覆盖草稿、合并列表条目、重读快照、
   * 聚焦输入框。`restore` 遇 409 `undo_conflict` 时释放锁并交给冲突对话框；其余失败进输入框上的错误。
   * 从不 reject。
   */
  const undoTurn = useCallback(
    (messageId: number, trigger: HTMLElement, files: UndoFiles = "restore"): Promise<void> => {
      const ownedClient = clientRef.current;
      const sessionId = requestedSessionRef.current;
      const flight = undoFlightRef.current;
      if (
        sessionId === null ||
        (flight?.client === ownedClient && flight.sessionId === sessionId)
      ) {
        return Promise.resolve();
      }
      const owner: ChatMutationOwner = {
        client: ownedClient,
        originSessionId: sessionId,
        sessionId,
      };
      const release = () => {
        if (undoFlightRef.current === owner) {
          undoFlightRef.current = null;
        }
        setUndoOwner((current) => (current === owner ? null : current));
      };
      const owned = () => ownsSessionWrite(ownedClient, sessionId);
      const fail = (error: unknown, write: typeof setPromptError, suffix = "") => {
        if (owned() && !isUnauthorized(error)) {
          write({ client: ownedClient, sessionId, message: `${errorMessage(error)}${suffix}` });
          // 对话框关闭时 `撤回` 按钮是禁用的，焦点还不回去：落在 body 上就交给输入框。
          focusOnUnlockRef.current = document.activeElement === document.body;
        }
        release();
      };
      undoFlightRef.current = owner;
      setPromptError(null);
      setUndoOwner(owner);
      return ownedClient.undoMessage(sessionId, messageId, files).then(
        ({ draft, files: { failed, skipped }, session }) => {
          if (!owned()) {
            release();
            return;
          }
          setDraft(draft);
          // 每一次被应用的 200 都重新决定说明：有未还原的就换成这一份，没有就撤掉已有的。
          setUndoNotice(
            skipped.count + failed.count > 0
              ? { client: ownedClient, sessionId, skipped, failed }
              : null,
          );
          // 只合并撤回会改的两个键；标题、置顶、归档等按 session-actions.ts 的规则不动。不另发列表 GET。
          setListState((list) =>
            list.status === "success" && list.client === ownedClient
              ? {
                  ...list,
                  sessions: list.sessions.map((entry) =>
                    entry.id === session.id
                      ? { ...entry, status: session.status, updatedAt: session.updatedAt }
                      : entry,
                  ),
                }
              : list,
          );
          closeSource();
          void ownedClient.getMessages(sessionId).then(
            (snapshot) => {
              if (owned()) {
                installSnapshot(snapshot, ownedClient);
                openSource(snapshot, ownedClient);
                focusOnUnlockRef.current = true;
              }
              release();
            },
            (error: unknown) => fail(error, setStreamError, `。${TERMINAL_REFRESH_GUIDANCE}`),
          );
        },
        (error: unknown) => {
          if (files === "restore" && isUndoConflict(error) && owned()) {
            setUndoConflict({ client: ownedClient, sessionId, messageId, trigger });
            release();
            return;
          }
          fail(error, setPromptError);
        },
      );
    },
    [
      clientRef,
      closeSource,
      focusOnUnlockRef,
      installSnapshot,
      openSource,
      ownsSessionWrite,
      requestedSessionRef,
      setDraft,
      setListState,
      setPromptError,
      setStreamError,
      setUndoConflict,
      setUndoNotice,
      setUndoOwner,
      undoFlightRef,
    ],
  );

  /**
   * 冲突对话框的 props；冲突不属于 `client` 与当前选中的 `sessionId` 时为 null（不渲染）。`只撤回对话` /
   * `连文件一起还原` 先关框再重发，重发的失败同样进输入框上的错误；关闭后焦点还给当初的 `撤回` 按钮，
   * 它已卸载（消息被撤回）时落到输入框。
   */
  const undoConflictFor = (client: ApiClient, sessionId: string | null) => {
    if (
      undoConflict === null ||
      undoConflict.client !== client ||
      undoConflict.sessionId !== sessionId
    ) {
      return null;
    }
    const { messageId, trigger } = undoConflict;
    const resend = (files: UndoFiles) => {
      setUndoConflict(null);
      void undoTurn(messageId, trigger, files);
    };
    return {
      onCancel: () => setUndoConflict(null),
      onForce: () => resend("force"),
      onKeep: () => resend("keep"),
      restoreFocus: () =>
        (trigger.isConnected ? trigger : composerRef.current)?.focus({ preventScroll: true }),
    };
  };

  /** 未还原文件说明的 props；不属于 `client` 与当前选中的 `sessionId` 时为 null（不渲染）。 */
  const undoNoticeFor = (client: ApiClient, sessionId: string | null) => {
    if (undoNotice === null || undoNotice.client !== client || undoNotice.sessionId !== sessionId) {
      return null;
    }
    return {
      failed: undoNotice.failed,
      // 关闭按钮随说明卸载：焦点交给输入框，不落回 body。
      onDismiss: () => {
        setUndoNotice(null);
        composerRef.current?.focus({ preventScroll: true });
      },
      skipped: undoNotice.skipped,
    };
  };

  return {
    answerApproval,
    dispatchPrompt,
    forkTurn,
    regenerateTurn,
    restoreOwnedDraft,
    stopTurn,
    undoConflictFor,
    undoNoticeFor,
    undoTurn,
  };
}
