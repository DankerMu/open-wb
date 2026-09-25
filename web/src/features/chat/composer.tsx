import { type FormEvent, useId } from "react";
import { Button, Icon } from "../../ui/index.js";

type ComposerProps = {
  disabled: boolean;
  draft: string;
  generating: boolean;
  onChangeDraft(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  placeholder: string;
  sendDisabled: boolean;
};

/** 输入卡：textarea 在上，底部工具栏只有圆形发送按钮；提示行在卡外。 */
export function Composer({
  disabled,
  draft,
  generating,
  onChangeDraft,
  onSubmit,
  placeholder,
  sendDisabled,
}: ComposerProps) {
  const inputId = useId();
  const hintId = useId();
  return (
    <form className="chat-composer" onSubmit={onSubmit}>
      <div className="chat-composer-card">
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
          rows={2}
          value={draft}
        />
        <div className="chat-composer-toolbar">
          {generating ? (
            <p className="chat-composer-pending" role="status">
              生成中
            </p>
          ) : null}
          <Button
            aria-label={generating ? "生成中" : "发送"}
            className="chat-send"
            disabled={sendDisabled}
            size="icon"
            type="submit"
            variant="primary"
          >
            <Icon name="send" />
          </Button>
        </div>
      </div>
      <p className="chat-composer-hint" id={hintId}>
        Enter 发送 · Shift+Enter 换行
      </p>
    </form>
  );
}
