import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useId,
  useState,
} from "react";
import { Button, Icon, useToast } from "../../ui/index.js";

type StopTurn = () => Promise<"stopping" | null>;

type ComposerProps = {
  disabled: boolean;
  draft: string;
  /** 卡片内工具栏之后的末尾节点（欢迎态的空间选择）；不传时卡片以工具栏结尾。 */
  footer?: ReactNode;
  generating: boolean;
  /** 输入框元素的 ref（会话页经它聚焦输入框）。 */
  inputRef?: Ref<HTMLTextAreaElement>;
  /** 先于既有 Enter 规则调用；返回 true 表示按键已被处理，不再提交。 */
  interceptKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  onChangeDraft(value: string): void;
  onStop: StopTurn;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  placeholder: string;
  sendDisabled: boolean;
  /** 卡片内、输入框上方的候选面板（斜杠命令）；不传时不渲染。 */
  slashMenu?: ReactNode;
  /** 当前选中会话；null（欢迎态建会话途中）时停止键禁用。 */
  stopSessionId: string | null;
};

/** 输入卡：textarea 在上，底部工具栏只有圆形发送按钮（生成中换成停止键）；提示行在卡外。 */
export function Composer({
  disabled,
  draft,
  footer,
  generating,
  inputRef,
  interceptKeyDown,
  onChangeDraft,
  onStop,
  onSubmit,
  placeholder,
  sendDisabled,
  slashMenu,
  stopSessionId,
}: ComposerProps) {
  const inputId = useId();
  const hintId = useId();
  return (
    <form className="chat-composer" onSubmit={onSubmit}>
      <div className="chat-composer-card">
        {slashMenu}
        <label className="ui-sr-only" htmlFor={inputId}>
          给助手发消息
        </label>
        <textarea
          aria-describedby={hintId}
          className="chat-composer-input"
          disabled={disabled}
          id={inputId}
          onChange={(event) => onChangeDraft(event.target.value)}
          onKeyDown={(event) => {
            if (interceptKeyDown?.(event)) return;
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            ) {
              return;
            }
            event.preventDefault();
            if (!event.repeat && !sendDisabled) {
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={placeholder}
          ref={inputRef}
          rows={2}
          value={draft}
        />
        <div className="chat-composer-toolbar">
          {generating ? (
            <p className="chat-composer-pending" role="status">
              生成中
            </p>
          ) : null}
          {generating ? (
            <StopButton key={stopSessionId ?? ""} onStop={onStop} sessionId={stopSessionId} />
          ) : (
            <Button
              aria-label="发送"
              className="chat-send"
              disabled={sendDisabled}
              size="icon"
              type="submit"
              variant="primary"
            >
              <Icon name="send" />
            </Button>
          )}
        </div>
        {footer}
      </div>
      <p className="chat-composer-hint" id={hintId}>
        Enter 发送 · Shift+Enter 换行
      </p>
    </form>
  );
}

/**
 * 生成中替换发送键的圆形停止键：只在自己的 stop 请求在途时禁用，任何响应后（仍 running 时）恢复可点；
 * 解锁与「已停止」呈现只来自权威状态（`turn.end stopped` 或快照），从不来自 stop 响应本身。
 */
function StopButton({ onStop, sessionId }: { onStop: StopTurn; sessionId: string | null }) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  return (
    <Button
      aria-label="停止"
      className="chat-send"
      disabled={pending || sessionId === null}
      onClick={() => {
        setPending(true);
        void onStop().then((result) => {
          if (result === "stopping") {
            toast.show({ type: "info", message: "已停止生成" });
          }
          setPending(false);
        });
      }}
      size="icon"
      title="停止"
      type="button"
      variant="primary"
    >
      <Icon name="square" size={12} />
    </Button>
  );
}
