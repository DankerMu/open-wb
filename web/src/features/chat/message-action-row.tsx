// 消息操作行（design D4、D8）：应用层组件，容器是 `ActionBarPrimitive.Root`（默认配置：不自动隐藏、
// 不随运行态隐藏），按钮是普通 `button`。行是否渲染、行里有哪些按钮都由调用方（message-thread.tsx）与
// 这里的 props 决定，不读运行时的可见性。不用 `ActionBarPrimitive.Copy` / `Reload`：前者复制的是运行时
// 拼出的文本且吞掉失败（没有就地提示的出口），后者的禁用条件来自运行时而不是输入框锁定。
// 不渲染编辑、分支切换与附件。不弹轻提示。
import { ActionBarPrimitive } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { Icon, type IconName } from "../../ui/index.js";
import { useCopyFeedback } from "./copy-feedback.js";

function Row({ children }: { children: ReactNode }) {
  return (
    <ActionBarPrimitive.Root className="mt-2 flex items-center gap-0.5" data-slot="message-actions">
      {children}
    </ActionBarPrimitive.Root>
  );
}

/** 图标按钮：可访问名与 tooltip 都是 `label`。 */
function ActionButton({
  disabled,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-label={label}
      className="flex size-[26px] flex-none cursor-pointer items-center justify-center rounded-md text-(--wb-icon-muted) hover:bg-accent hover:text-(--wb-text-secondary) disabled:pointer-events-none disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon name={icon} size={12} />
    </button>
  );
}

/**
 * `复制`：复制消息的原始 Markdown 文本。成功时图标换成对勾约 2 秒，并有一个视觉隐藏的状态文本
 * `已复制`；失败时在按钮旁就地显示 `复制失败`，下一次点击时清除。
 */
function CopyAction({ text }: { text: string }) {
  const { copy, result } = useCopyFeedback(text);
  return (
    <>
      <ActionButton
        icon={result === "copied" ? "check" : "copy"}
        label="复制"
        onClick={() => void copy()}
      />
      {result === "copied" ? (
        <span className="sr-only" role="status">
          已复制
        </span>
      ) : null}
      {result === "failed" ? (
        <span className="px-1 text-xs text-(--wb-status-error-text)" role="alert">
          复制失败
        </span>
      ) : null}
    </>
  );
}

/** `onRegenerate` 自行落定每个分支，从不 reject；输入框锁定期间（含本次点击到结算之间）按钮禁用。 */
type Regenerate = { disabled: boolean; onRegenerate(): Promise<unknown> };

/** 助手消息的操作行：正文非空时有 `复制`，符合重新生成条件时有 `重新生成`。 */
export function AssistantActions({
  regenerate,
  text,
}: {
  regenerate?: Regenerate | undefined;
  text: string;
}) {
  return (
    <Row>
      {text === "" ? null : <CopyAction text={text} />}
      {regenerate ? (
        <ActionButton
          disabled={regenerate.disabled}
          icon="refresh-cw"
          label="重新生成"
          onClick={() => void regenerate.onRegenerate()}
        />
      ) : null}
    </Row>
  );
}

/** 用户消息的操作行：只有 `从此处分叉`；`onFork` 自行落定每个分支，从不 reject。 */
export function UserActions({ disabled, onFork }: { disabled: boolean; onFork(): void }) {
  return (
    <Row>
      <ActionButton disabled={disabled} icon="git-branch" label="从此处分叉" onClick={onFork} />
    </Row>
  );
}
