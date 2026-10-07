import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useEscapeFallback } from "../../ui/index.js";

type RenameProps = {
  /** 服务端标题；null 时输入框为空。 */
  title: string | null;
  busy: boolean;
  error: string | null;
  /** 关闭后把焦点还给打开它的按钮（按钮已卸载时落到列表区）。 */
  restoreFocus(): void;
  onSubmit(text: string): void;
  onCancel(): void;
};

/**
 * `重命名任务` 对话框（demo:3795-3801）；`rename` 为 null 时不渲染。表单按「有打开的重命名」条件
 * 挂载，每次打开都是新的输入状态。Enter 走表单的原生提交（输入法组合中的 Enter 不触发隐式提交），
 * 本文件不写键盘处理。请求中仍可关闭（`取消`、`关闭`、Escape、遮罩）：网络停滞时不锁死页面，
 * 请求不因此取消。失败在对话框内以 `role="alert"` 显示。
 */
export function RenameDialog({ rename }: { rename: RenameProps | null }) {
  return rename ? <RenameForm {...rename} /> : null;
}

function RenameForm({ title, busy, error, restoreFocus, onSubmit, onCancel }: RenameProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(title ?? "");
  const onOpenChange = (open: boolean) => {
    if (!open) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });

  // `保存` 在请求发出的那次提交里被禁用：焦点若在它上面（或已被浏览器移到 body），移回输入框，
  // 不让焦点逃出对话框。
  useLayoutEffect(() => {
    if (!busy) return;
    const active = document.activeElement;
    if (active === document.body || (active as HTMLButtonElement | null)?.disabled) {
      inputRef.current?.focus();
    }
  }, [busy]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(text);
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        ref={fallback.ref}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="leading-5">重命名任务</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Input
            aria-label="任务名称"
            onChange={(event) => setText(event.target.value)}
            ref={inputRef}
            value={text}
          />
          {error ? (
            <p
              className="m-0 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onCancel} type="button" variant="ghost">
              取消
            </Button>
            <Button
              aria-busy={busy ? true : undefined}
              disabled={busy || text.trim().length === 0}
              type="submit"
            >
              保存
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
