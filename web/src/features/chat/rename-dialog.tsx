import { type FormEvent, type RefObject, useRef, useState } from "react";
import { Button, Dialog, Input } from "../../ui/index.js";

type RenameProps = {
  /** 服务端标题；null 时输入框为空。 */
  title: string | null;
  busy: boolean;
  error: string | null;
  returnFocus: RefObject<HTMLElement | null>;
  onSubmit(text: string): void;
  onCancel(): void;
};

/**
 * `重命名任务` 对话框（demo:3795-3801）；`rename` 为 null 时不渲染。表单按「有打开的重命名」条件
 * 挂载，每次打开都是新的输入状态。Enter 走表单的原生提交（输入法组合中的 Enter 不触发隐式提交），
 * 本文件不写键盘处理。请求中仍可关闭（`取消`、`关闭`、Escape、遮罩）：网络停滞时不锁死页面，
 * 请求不因此取消。
 */
export function RenameDialog({ rename }: { rename: RenameProps | null }) {
  return rename ? <RenameForm {...rename} /> : null;
}

function RenameForm({ title, busy, error, returnFocus, onSubmit, onCancel }: RenameProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(title ?? "");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(text);
  }

  return (
    <Dialog
      busy={busy}
      initialFocus={inputRef}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open
      returnFocus={returnFocus}
      size="sm"
      title="重命名任务"
    >
      <form className="chat-rename-form" onSubmit={submit}>
        <Input
          aria-label="任务名称"
          onChange={(event) => setText(event.target.value)}
          ref={inputRef}
          value={text}
        />
        {error ? (
          <p className="ui-alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="chat-rename-actions">
          <Button onClick={onCancel} variant="ghost">
            取消
          </Button>
          <Button
            disabled={text.trim().length === 0}
            loading={busy}
            type="submit"
            variant="primary"
          >
            保存
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
