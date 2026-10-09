// 输入框的附件区（design D12）：文本框上方的标签列表，以及把它接到会话页的 `useAttachmentArea`——隐藏的
// 文件输入框、数量与大小的提示、「+」菜单 `上传文件` 项的可用判定。标签状态与上传队列在 attachments-state.ts。
import { type ReactNode, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "../../ui/index.js";
import { formatSize } from "../files/file-meta.js";
import { NO_WORKSPACE, type useAttachmentsState } from "./attachments-state.js";

type Attachments = ReturnType<typeof useAttachmentsState>;
type Attachment = Attachments["items"][number];

/** 状态字样：已上传的不写字。 */
function statusText({ message, percent, status }: Attachment): string | null {
  if (status === "uploading") return `上传中 ${percent}%`;
  if (status === "failed") return `失败：${message}`;
  return status === "pending" ? "待上传" : null;
}

/**
 * 标签列表：每项依次是文件名、大小、状态字样（上传中另有进度条）与移除键。移除键不随输入框锁定禁用——
 * 回合进行中也要能取消还在传的文件。
 */
function AttachmentChips({ items, onRemove }: { items: Attachment[]; onRemove(id: number): void }) {
  return (
    <ul
      aria-label="附件"
      className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0"
      data-slot="composer-attachments"
      // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
      role="list"
    >
      {items.map((item) => {
        const status = statusText(item);
        return (
          <li
            className="flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-border bg-muted py-0.5 pr-0.5 pl-2 text-xs leading-5 data-[status=failed]:border-(--wb-status-error-text)"
            data-status={item.status}
            key={item.id}
          >
            <span className="min-w-0 truncate font-medium" title={item.name}>
              {item.name}
            </span>
            <span className="flex-none text-muted-foreground">{formatSize(item.size)}</span>
            {status === null ? null : (
              <span
                className={`max-w-48 min-w-0 truncate ${item.status === "failed" ? "text-(--wb-status-error-text)" : "text-muted-foreground"}`}
                title={status}
              >
                {status}
              </span>
            )}
            {item.status === "uploading" ? (
              <div
                aria-label={`${item.name} 上传进度`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={item.percent}
                className="h-1 w-10 flex-none overflow-hidden rounded-full bg-border"
                role="progressbar"
              >
                <div
                  className="h-full bg-(--wb-brand-primary)"
                  style={{ width: `${item.percent}%` }}
                />
              </div>
            ) : null}
            <Button
              aria-label={`移除 ${item.name}`}
              className="flex-none"
              onClick={() => onRemove(item.id)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Icon name="x" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

type AttachmentAreaInput = {
  attachments: Attachments;
  /** 输入框锁定：文件框此时收到的文件不接受（文件对话框开着时回合开始的情形）。 */
  locked: boolean;
  /** 输入框选项（上传上限）已取得。 */
  ready: boolean;
  /** 当前会话 id；欢迎态为 null，此时没有 `上传文件` 项。 */
  sessionId: string | null;
  /** 当前会话的工作空间：没有为 null，会话还没解析出来为 undefined。 */
  workspaceId: string | null | undefined;
};

/**
 * 附件区交给会话页的四块：`chips` 进输入卡（没有标签时为 null），`notice` 是数量与大小的提示，`input` 是
 * 隐藏的文件输入框，`upload` 是「+」菜单 `上传文件` 项的 props（不可用时带原因；欢迎态为 undefined）。
 */
export function useAttachmentArea({
  attachments,
  locked,
  ready,
  sessionId,
  workspaceId,
}: AttachmentAreaInput): {
  chips: ReactNode;
  input: ReactNode;
  notice: ReactNode;
  upload: { disabled: boolean; reason: string | null; open(): void } | undefined;
} {
  const inputRef = useRef<HTMLInputElement>(null);
  const { accept, items, notice, remove } = attachments;
  return {
    chips: items.length === 0 ? null : <AttachmentChips items={items} onRemove={remove} />,
    input: (
      <input
        data-slot="composer-file-input"
        hidden
        multiple
        onChange={(event) => {
          if (!locked) accept(Array.from(event.target.files ?? []));
          // 清掉选择：同一个文件可以再选一次。
          event.target.value = "";
        }}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
    ),
    notice:
      notice === null ? null : (
        <p className="ui-alert flex-none" role="alert">
          {notice}
        </p>
      ),
    upload:
      sessionId === null
        ? undefined
        : {
            disabled: !ready || workspaceId == null,
            open: () => inputRef.current?.click(),
            reason: workspaceId === null ? NO_WORKSPACE : null,
          },
  };
}
