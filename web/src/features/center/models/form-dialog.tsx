import { type FormEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MODEL_EFFORTS, type ModelView } from "@/lib/api";
import { useEscapeFallback } from "../../../components/escape-fallback.js";
import {
  type FieldErrors,
  initialValues,
  type ModelEffort,
  type ModelFormValues,
  validateModelForm,
} from "./validate.js";

const EFFORTS_NOTE = "不勾选即不声明强度集合，界面列全部档位";
const KEEP_KEY_PLACEHOLDER = "留空保留现有密钥";
const ERROR_TEXT = "m-0 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";

type FormDialogProps = {
  /** null 是新增；否则是编辑该视图（打开那一刻的）。 */
  opened: ModelView | null;
  pending: boolean;
  /** 服务端拒绝的原因（`ApiError.message`）；客户端校验的原因显示在各字段旁。 */
  error: string | null;
  restoreFocus(): void;
  onSubmit(values: ModelFormValues): void;
  onCancel(): void;
};

/** 一个带 label 的文本字段，校验原因显示在它下方并经 `aria-describedby` 关联。 */
function TextField({
  label,
  error,
  children,
}: {
  label: string;
  error: string | undefined;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
  }) => ReactNode;
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

function CheckField({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

/**
 * `新增模型` / `编辑模型` 对话框（model-registry「模型 tab」）。按「有打开的对话框」条件挂载：关闭即卸载，表单
 * 状态（含密钥）随之丢弃；密钥框恒为 `type="password"`、打开时为空。提交前逐字段校验，有原因就不发请求。
 * 请求在途时 `保存` 与 `取消` 禁用，Escape、遮罩与关闭按钮也关不掉（结果总落在打开的对话框上）。
 */
export function ModelFormDialog({
  opened,
  pending,
  error,
  restoreFocus,
  onSubmit,
  onCancel,
}: FormDialogProps) {
  const [values, setValues] = useState(() => initialValues(opened));
  const [errors, setErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: !pending, onOpenChange });
  const set = (patch: Partial<ModelFormValues>) =>
    setValues((current) => ({ ...current, ...patch }));

  // 两个按钮在请求发出的那次提交里被禁用：焦点若因此落到 body，移回表单的第一个可编辑字段。
  useLayoutEffect(() => {
    if (!pending) return;
    const active = document.activeElement;
    if (active === document.body || (active as HTMLButtonElement | null)?.disabled) {
      formRef.current?.querySelector<HTMLInputElement>("input:not([readonly])")?.focus();
    }
  }, [pending]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found = validateModelForm(values, opened);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(values);
  }

  function toggleEffort(effort: ModelEffort, checked: boolean) {
    const others = values.efforts.filter((candidate) => candidate !== effort);
    set({ efforts: checked ? [...others, effort] : others });
  }

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
          <DialogTitle className="leading-5">{opened ? "编辑模型" : "新增模型"}</DialogTitle>
        </DialogHeader>
        {/* 不是登录表单：常见密码管理器据 data-form-type 与各自的忽略属性跳过它（design Risks「浏览器密码管理器」）。 */}
        <form
          className="flex flex-col gap-3"
          data-form-type="other"
          noValidate
          onSubmit={submit}
          ref={formRef}
        >
          <TextField error={errors.id} label="ID">
            {(field) => (
              <Input
                {...field}
                onChange={(event) => set({ id: event.target.value })}
                readOnly={opened !== null}
                value={values.id}
              />
            )}
          </TextField>
          <TextField error={errors.name} label="名称">
            {(field) => (
              <Input
                {...field}
                onChange={(event) => set({ name: event.target.value })}
                value={values.name}
              />
            )}
          </TextField>
          <div className="flex gap-4">
            <CheckField
              checked={values.reasoning}
              label="推理"
              onChange={(reasoning) => set(reasoning ? { reasoning } : { reasoning, efforts: [] })}
            />
            <CheckField
              checked={values.vision}
              label="看图"
              onChange={(vision) => set({ vision })}
            />
          </div>
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 text-sm font-medium">推理强度</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {MODEL_EFFORTS.map((effort) => (
                <CheckField
                  checked={values.efforts.includes(effort)}
                  disabled={!values.reasoning}
                  key={effort}
                  label={effort}
                  onChange={(checked) => toggleEffort(effort, checked)}
                />
              ))}
            </div>
            {values.reasoning && values.efforts.length === 0 ? (
              <p className="ui-muted text-xs">{EFFORTS_NOTE}</p>
            ) : null}
          </fieldset>
          <TextField error={errors.maxTokens} label="最大 tokens">
            {(field) => (
              <Input
                {...field}
                inputMode="numeric"
                onChange={(event) => set({ maxTokens: event.target.value })}
                type="number"
                value={values.maxTokens}
              />
            )}
          </TextField>
          <TextField error={errors.baseUrl} label="上游地址">
            {(field) => (
              <Input
                {...field}
                autoComplete="off"
                onChange={(event) => set({ baseUrl: event.target.value })}
                value={values.baseUrl}
              />
            )}
          </TextField>
          <TextField error={errors.apiKey} label="密钥">
            {(field) => (
              <Input
                {...field}
                autoComplete="new-password"
                data-1p-ignore
                data-bwignore
                data-lpignore="true"
                onChange={(event) => set({ apiKey: event.target.value })}
                {...(opened ? { placeholder: KEEP_KEY_PLACEHOLDER } : {})}
                type="password"
                value={values.apiKey}
              />
            )}
          </TextField>
          {error ? (
            <p className={`${ERROR_TEXT} rounded-lg bg-destructive/10 px-2.5 py-2`} role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button disabled={pending} onClick={onCancel} type="button" variant="ghost">
              取消
            </Button>
            <Button aria-busy={pending ? true : undefined} disabled={pending} type="submit">
              保存
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
