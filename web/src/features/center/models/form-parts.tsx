import { type ReactNode, type Ref, useId, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEscapeFallback } from "../../../components/escape-fallback.js";

/**
 * 模型 tab 两个表单对话框（`新增模型` / `编辑模型` 与知识库嵌入模型）共用的件：带原因的文本字段、密钥框与对话框外壳。
 */

const ERROR_TEXT = "m-0 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";
const KEEP_KEY_PLACEHOLDER = "留空保留现有密钥";

type FieldProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: true };

/** 一个带 label 的文本字段，校验原因显示在它下方并经 `aria-describedby` 关联。 */
export function TextField({
  label,
  error,
  children,
}: {
  label: string;
  error: string | undefined;
  children: (props: FieldProps) => ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(error ? { id, "aria-describedby": errorId, "aria-invalid": true } : { id })}
      {error ? (
        <p className={ERROR_TEXT} id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** `上游地址` 字段。 */
export function BaseUrlField({
  error,
  value,
  onChange,
}: {
  error: string | undefined;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <TextField error={error} label="上游地址">
      {(field) => (
        <Input
          {...field}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          value={value}
        />
      )}
    </TextField>
  );
}

/**
 * `密钥` 字段：恒为 `type="password"`，值由调用方持有（打开时为空，从不预填已存密钥）；`keep` 为真即已有密钥，
 * placeholder 提示留空保留。常见密码管理器据各自的忽略属性跳过它。
 */
export function KeyField({
  error,
  keep,
  value,
  onChange,
}: {
  error: string | undefined;
  keep: boolean;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <TextField error={error} label="密钥">
      {(field) => (
        <Input
          {...field}
          autoComplete="new-password"
          data-1p-ignore
          data-bwignore
          data-lpignore="true"
          onChange={(event) => onChange(event.target.value)}
          {...(keep ? { placeholder: KEEP_KEY_PLACEHOLDER } : {})}
          type="password"
          value={value}
        />
      )}
    </TextField>
  );
}

type ShellProps = {
  title: string;
  pending: boolean;
  /** 服务端拒绝的原因（`ApiError.message`）；客户端校验的原因显示在各字段旁。 */
  error: string | null;
  restoreFocus(): void;
  /** 已 `preventDefault`，且只在不在途时调用。 */
  onSubmit(): void;
  onCancel(): void;
  saveRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
};

/**
 * 表单对话框外壳：标题、表单、框内 `role="alert"` 与 `取消` / `保存`。接入 Escape 关闭回退（`useEscapeFallback`）；
 * 请求在途时两个按钮禁用，Escape、遮罩与关闭按钮也关不掉（结果总落在打开的对话框上）。
 */
export function FormDialogShell({
  title,
  pending,
  error,
  restoreFocus,
  onSubmit,
  onCancel,
  saveRef,
  children,
}: ShellProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: !pending, onOpenChange });

  // 两个按钮在请求发出的那次提交里被禁用：焦点若因此落到 body，移回表单的第一个可编辑字段。
  useLayoutEffect(() => {
    if (!pending) return;
    const active = document.activeElement;
    if (active === document.body || (active as HTMLButtonElement | null)?.disabled) {
      formRef.current?.querySelector<HTMLInputElement>("input:not([readonly])")?.focus();
    }
  }, [pending]);

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        className="max-h-[calc(100%-2rem)] overflow-y-auto sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="leading-5">{title}</DialogTitle>
        </DialogHeader>
        {/* 不是登录表单：常见密码管理器据 data-form-type 与各自的忽略属性跳过它（design Risks「浏览器密码管理器」）。 */}
        <form
          className="flex flex-col gap-3"
          data-form-type="other"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending) onSubmit();
          }}
          ref={formRef}
        >
          {children}
          {error ? (
            <p className={`${ERROR_TEXT} rounded-lg bg-destructive/10 px-2.5 py-2`} role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button disabled={pending} onClick={onCancel} type="button" variant="ghost">
              取消
            </Button>
            <Button
              aria-busy={pending ? true : undefined}
              disabled={pending}
              ref={saveRef}
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
