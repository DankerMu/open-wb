// 消息线程骨架（design D4）：应用层组件，直接由 ThreadPrimitive / MessagePrimitive 组合；滚动层在
// thread-viewport.tsx，思考折叠在 thinking-fold.tsx，工具调用组在 tool-call-group.tsx，操作行在
// message-action-row.tsx，已结算审批记录在 approval-card.tsx（待决审批不在消息里，见 composer-dock.tsx）。
// 文件变更卡在 file-changes-card.tsx，产物卡在 artifact-card.tsx，按 D4 的块次序挂在助手消息里。
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  type MessageState,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { memo, type Ref, useCallback } from "react";
import type { ApiClient } from "../../lib/api.js";
import { BrandMark, Icon } from "../../ui/index.js";
import { ApprovalRecords } from "./approval-card.js";
import { ArtifactCards } from "./artifact-card.js";
import { FileChangesCard } from "./file-changes-card.js";
import { MarkdownBody } from "./markdown-body.js";
import { AssistantActions, UserActions } from "./message-action-row.js";
import { type ChatMessageCustom, messageCustom } from "./runtime-convert.js";
import type { ChatState } from "./stream.js";
import { ThinkingFold } from "./thinking-fold.js";
import { ThreadViewport, type TranscriptHandle } from "./thread-viewport.js";
import { ToolCallGroup } from "./tool-call-group.js";
import { useThreadRuntime } from "./use-thread-runtime.js";
import type { Workspace } from "./workspace-list.js";

type ThreadProps = {
  /** 选中的会话已归档（只读）：不渲染 `从此处分叉` 与 `重新生成`，零消息时也不显示空态。 */
  archived: boolean;
  /** 当前账号的 API client；产物卡经它按需拉取预览。 */
  client: ApiClient;
  /** 对话内搜索的当前匹配；其余消息不带 `aria-current`。 */
  currentId: number | null;
  /** 输入框锁定期间分叉与重新生成禁用，零消息时也不显示空态。 */
  locked: boolean;
  onFork(messageId: number): Promise<void>;
  onRegenerate(): Promise<void>;
  onSend(prompt: string): void;
  onStop(): Promise<unknown>;
  /** 对话内搜索经它调用滚动层的 `scrollToMessage`。 */
  scrollHandleRef: Ref<TranscriptHandle>;
  /** 选中会话的视图；历史尚未到达时为 null（滚动容器已在，内容根还没有）。 */
  view: ChatState | null;
  workspace: Workspace | null;
};

const NO_MESSAGES: ChatState["messages"] = [];

/** 末条助手消息可重新生成的会话状态（运行中与 `idle` 不可）。 */
const REGENERABLE: ReadonlySet<ChatState["status"]> = new Set(["done", "failed", "stopped"]);

/** 搜索当前匹配的底色：向外铺 6px 的同色阴影当衬底，不挪动布局。 */
const CURRENT_MATCH =
  "aria-[current=true]:bg-(--wb-brand-primary-subtle) aria-[current=true]:shadow-[0_0_0_6px_var(--wb-brand-primary-subtle)]";

function partText(message: MessageState, type: "reasoning" | "text"): string {
  for (const part of message.content) {
    if (part.type === type) return part.text;
  }
  return "";
}

const UserMessage = memo(function UserMessage({
  archived,
  current,
  custom,
  id,
  locked,
  onFork,
  text,
}: {
  archived: boolean;
  current: boolean;
  custom: ChatMessageCustom;
  id: number;
  locked: boolean;
  onFork: ThreadProps["onFork"];
  text: string;
}) {
  return (
    <MessagePrimitive.Root asChild>
      <article
        aria-current={current ? "true" : undefined}
        aria-label="用户"
        className={`flex max-w-[80%] min-w-0 flex-col gap-2 self-end rounded-2xl rounded-br-sm bg-(--wb-bg-hover-light) px-[15px] py-2.5 narrow:max-w-full ${CURRENT_MATCH}`}
      >
        <p
          className="m-0 text-sm leading-[1.65] wrap-anywhere whitespace-pre-wrap text-foreground"
          data-slot="message-body"
        >
          {text}
        </p>
        <ToolCallGroup steps={custom.steps} />
        <MessageError error={custom.error} />
        {archived ? null : <UserActions disabled={locked} onFork={() => void onFork(id)} />}
      </article>
    </MessagePrimitive.Root>
  );
});

function MessageError({ error }: { error: string | null }) {
  return error ? (
    <p
      className="m-0 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text)"
      data-slot="message-error"
      role="alert"
    >
      {error}
    </p>
  ) : null;
}

/** 正文：Markdown，或已停止且为空时的占位；运行中在末尾带光标（减少动态效果时不闪）。 */
function MessageBody({ status, text }: { status: ChatMessageCustom["status"]; text: string }) {
  return (
    <div className="text-sm leading-7 wrap-anywhere text-foreground" data-slot="message-body">
      {status === "stopped" && text === "" ? (
        <p className="text-(--wb-text-tertiary)">（已停止生成）</p>
      ) : (
        <MarkdownBody text={text} />
      )}
      {status === "running" ? (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block h-[15px] w-[7px] animate-caret-blink rounded-[1px] bg-(--wb-brand-primary) align-[-2px] motion-reduce:animate-none"
          data-slot="message-caret"
        />
      ) : null}
    </div>
  );
}

const AssistantMessage = memo(function AssistantMessage({
  client,
  current,
  custom,
  locked,
  onRegenerate,
  regenerable,
  text,
  thinking,
  workspace,
}: {
  client: ApiClient;
  current: boolean;
  custom: ChatMessageCustom;
  locked: boolean;
  onRegenerate: ThreadProps["onRegenerate"];
  /** 仅转录末条助手消息、且会话状态允许时为真。 */
  regenerable: boolean;
  text: string;
  thinking: string;
  workspace: Workspace | null;
}) {
  const { approvals, error, status, steps } = custom;
  const running = status === "running";
  return (
    <MessagePrimitive.Root asChild>
      <article
        aria-current={current ? "true" : undefined}
        aria-label="助手"
        className={`flex max-w-full min-w-0 gap-2.5 self-stretch aria-[current=true]:rounded-lg ${CURRENT_MATCH}`}
      >
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-7 flex-none"
          data-slot="message-avatar"
        >
          <BrandMark size={28} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5" data-slot="message-content">
          {thinking ? <ThinkingFold running={running} text={thinking} /> : null}
          <MessageBody status={status} text={text} />
          <ToolCallGroup steps={steps} />
          <ApprovalRecords approvals={approvals} />
          <MessageError error={error} />
          <FileChangesCard steps={steps} workspace={workspace} />
          <ArtifactCards client={client} steps={steps} workspace={workspace} />
          {status === "stopped" ? (
            <p
              aria-label="助手消息 已停止"
              className="m-0 self-start rounded-full border border-(--wb-border-default) px-2 py-px text-[11.5px] leading-4 text-(--wb-text-secondary)"
              data-slot="message-stopped"
              role="status"
            >
              已停止
            </p>
          ) : null}
          {!running && (text !== "" || regenerable) ? (
            <AssistantActions
              regenerate={regenerable ? { disabled: locked, onRegenerate } : undefined}
              text={text}
            />
          ) : null}
        </div>
      </article>
    </MessagePrimitive.Root>
  );
});

/**
 * 零消息空态（design D4）：装饰性图标、一行提示与只读的绑定工作空间名。`workspace` 为 null（未绑定，
 * 或空间名解析不出——列表读取中、读取失败、空间已删）时没有工作空间那一行。不是标题，也不是消息。
 * 只在输入框未锁定且会话未归档时渲染（见 `Thread` 的 `empty`）。
 */
function EmptyThread({ workspace }: { workspace: Workspace | null }) {
  return (
    <div
      className="my-auto flex min-w-0 flex-col items-center gap-2 py-10 text-center text-(--wb-text-tertiary)"
      data-slot="thread-empty"
    >
      <Icon name="message-square" size={20} />
      <p className="m-0 text-sm leading-6 text-(--wb-text-secondary)">还没有消息，发一条开始吧</p>
      {workspace ? (
        <p className="m-0 max-w-full truncate text-xs leading-5">{`工作空间 ${workspace.name}`}</p>
      ) : null}
    </div>
  );
}

/** 选中会话的线程：运行时、滚动层与全部消息。按会话 `key` 挂载，切换会话即重置跟随状态。 */
export function Thread({
  archived,
  client,
  currentId,
  locked,
  onFork,
  onRegenerate,
  onSend,
  onStop,
  scrollHandleRef,
  view,
  workspace,
}: ThreadProps) {
  const messages = view?.messages ?? NO_MESSAGES;
  const runtime = useThreadRuntime({ messages, onRegenerate, onSend, onStop });
  // 空态跟随输入框锁定：只在历史已到（下面的 `view` 分支）、没有消息且输入框未锁定时出现——回合进行中、
  // 或流错误带着刷新指引时都不显示；已归档的会话没有输入框，同样不显示。内容根此时撑满滚动容器，让它垂直居中。
  const empty = messages.length === 0 && !locked && !archived;
  const last = messages.at(-1);
  const regenerableId =
    view && !archived && last?.role === "assistant" && REGENERABLE.has(view.status)
      ? String(last.id)
      : null;
  // 引用稳定的渲染函数：依赖就是闭包里用到的这几项，其余重渲染不换函数。
  const renderMessage = useCallback(
    ({ message }: { message: MessageState }) => {
      const custom = messageCustom(message.metadata.custom);
      const current = message.id === String(currentId);
      const text = partText(message, "text");
      return message.role === "assistant" ? (
        <AssistantMessage
          client={client}
          current={current}
          custom={custom}
          locked={locked}
          onRegenerate={onRegenerate}
          regenerable={message.id === regenerableId}
          text={text}
          thinking={partText(message, "reasoning")}
          workspace={workspace}
        />
      ) : (
        <UserMessage
          archived={archived}
          current={current}
          custom={custom}
          id={Number(message.id)}
          locked={locked}
          onFork={onFork}
          text={text}
        />
      );
    },
    [archived, client, currentId, locked, onFork, onRegenerate, regenerableId, workspace],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadViewport handleRef={scrollHandleRef}>
        {view ? (
          <section
            aria-label="消息"
            className={`mx-auto box-border flex w-full max-w-3xl flex-col gap-4 px-2 pt-3 pb-6 narrow:px-0 ${empty ? "min-h-full" : ""}`}
          >
            {empty ? <EmptyThread workspace={workspace} /> : null}
            <ThreadPrimitive.Messages>{renderMessage}</ThreadPrimitive.Messages>
          </section>
        ) : null}
      </ThreadViewport>
    </AssistantRuntimeProvider>
  );
}
