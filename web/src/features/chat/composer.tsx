// 会话页输入框（design D6）：应用层组件，不用 ComposerPrimitive——拷入层的受控 textarea 加按钮，值即应用的
// `draft`，提交走页面既有的表单受理路径。`generating` 与 `disabled` 是两回事：前者驱动 `生成中` 与 `停止`，
// 后者只锁定输入框（历史加载中、分叉在途、连接器终止失败时只有后者为真）。
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useId,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "../../ui/index.js";

type StopTurn = () => Promise<"stopping" | null>;

type ComposerProps = {
  /** 工具栏的左组，即能力栏（「+」菜单、工作空间位）；不传时工具栏只有右组。 */
  capabilityBar?: ReactNode;
  disabled: boolean;
  draft: string;
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

/**
 * 输入卡：候选面板、textarea、底部工具栏（能力栏是左组，`生成中` 与发送/停止键是右组）；提示行在卡外。
 * 窄屏下工具栏可换行，右组作为一个整体落到下一行并靠右。
 */
export function Composer({
  capabilityBar,
  disabled,
  draft,
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
    <form
      className="mx-auto box-border flex w-full max-w-3xl flex-none flex-col gap-2 px-2 pt-2.5 pb-1 narrow:px-0"
      data-slot="composer"
      onSubmit={onSubmit}
    >
      <div
        className="relative flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-(--wb-shadow-input) has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-3 has-[textarea:focus-visible]:ring-ring/50"
        data-slot="composer-card"
      >
        {slashMenu}
        <label className="sr-only" htmlFor={inputId}>
          给助手发消息
        </label>
        <Textarea
          aria-describedby={hintId}
          className="max-h-40 min-h-13 resize-none overflow-x-hidden overflow-y-auto rounded-none border-0 bg-transparent p-0 text-[15px] leading-[1.75] wrap-anywhere text-foreground placeholder:text-(--wb-text-tertiary) focus-visible:ring-0 disabled:bg-transparent disabled:text-(--wb-text-tertiary) disabled:opacity-100 narrow:max-h-24 md:text-[15px] dark:bg-transparent dark:disabled:bg-transparent"
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
        <div
          className="flex min-h-8 items-center gap-2 narrow:flex-wrap narrow:gap-y-1"
          data-slot="composer-toolbar"
        >
          {capabilityBar}
          <div className="ml-auto flex flex-none items-center gap-2" data-slot="composer-actions">
            {generating ? (
              <p className="m-0 text-[13px] text-(--wb-brand-primary-deep)" role="status">
                生成中
              </p>
            ) : null}
            {generating ? (
              <StopButton key={stopSessionId ?? ""} onStop={onStop} sessionId={stopSessionId} />
            ) : (
              <Button
                aria-label="发送"
                className="rounded-full"
                disabled={sendDisabled}
                size="icon"
                type="submit"
              >
                <Icon name="send" />
              </Button>
            )}
          </div>
        </div>
      </div>
      <p className="m-0 text-center text-xs text-(--wb-text-tertiary)" id={hintId}>
        Enter 发送 · Shift+Enter 换行
      </p>
    </form>
  );
}

/**
 * 生成中替换发送键的圆形停止键：只在自己的 stop 请求在途时禁用，任何响应后（仍 running 时）恢复可点；
 * 解锁与「已停止」呈现只来自权威状态（`turn.end stopped` 或快照），从不来自 stop 响应本身，也不弹提示。
 */
function StopButton({ onStop, sessionId }: { onStop: StopTurn; sessionId: string | null }) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      aria-label="停止"
      className="rounded-full"
      disabled={pending || sessionId === null}
      onClick={() => {
        setPending(true);
        void onStop().then(() => setPending(false));
      }}
      size="icon"
      title="停止"
      type="button"
    >
      <Icon name="square" size={12} />
    </Button>
  );
}
