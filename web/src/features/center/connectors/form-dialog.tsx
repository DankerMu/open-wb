import { type FormEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ConnectorView } from "@/lib/api";
import { useEscapeFallback } from "../../../components/escape-fallback.js";
import {
  type ConnectorFormValues,
  type Entry,
  type FieldErrors,
  initialValues,
  validateConnectorForm,
} from "./validate.js";

const TYPES = ["stdio", "http"] as const;
const KEEP_VALUE_PLACEHOLDER = "留空保留现有值";
const ERROR_TEXT = "m-0 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";

type FormDialogProps = {
  /** null 是新增；否则是编辑该视图（打开那一刻的）。 */
  opened: ConnectorView | null;
  pending: boolean;
  /** 服务端拒绝的原因（`ApiError.message`）；客户端校验的原因显示在各字段旁。 */
  error: string | null;
  restoreFocus(): void;
  onSubmit(values: ConnectorFormValues): void;
  onCancel(): void;
};

type FieldProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: true };

/** 一个带 label 的字段，校验原因显示在它下方并经 `aria-describedby` 关联。 */
function Field({
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

/**
 * 键值对编辑（环境变量 / 请求头）：已有键的键名只读、值框为空且 placeholder `留空保留现有值`、不可移除；新加的行可
 * 移除。值框恒为 `type="password"`（凭证），带与模型密钥框相同的密码管理器忽略属性。
 */
function EntriesField({
  legend,
  noun,
  entries,
  error,
  onChange,
}: {
  legend: "环境变量" | "请求头";
  noun: "变量" | "请求头";
  entries: readonly Entry[];
  error: string | undefined;
  onChange(entries: Entry[]): void;
}) {
  const errorId = useId();
  const patch = (index: number, next: Partial<Entry>) =>
    onChange(entries.map((entry, at) => (at === index ? { ...entry, ...next } : entry)));
  return (
    <fieldset
      aria-describedby={error ? errorId : undefined}
      className="m-0 flex flex-col gap-1.5 border-0 p-0"
    >
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      {entries.map((entry, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 行只追加或移除新行，键名可编辑、没有稳定 id；输入框全受控。
        <div className="flex items-center gap-2" key={index}>
          <Input
            aria-label={`${noun}名 ${index + 1}`}
            autoComplete="off"
            className="font-mono"
            onChange={(event) => patch(index, { key: event.target.value })}
            readOnly={entry.existing}
            value={entry.key}
          />
          <Input
            aria-label={`${noun}值 ${index + 1}`}
            autoComplete="new-password"
            data-1p-ignore
            data-bwignore
            data-lpignore="true"
            onChange={(event) => patch(index, { value: event.target.value })}
            {...(entry.existing ? { placeholder: KEEP_VALUE_PLACEHOLDER } : {})}
            type="password"
            value={entry.value}
          />
          {entry.existing ? null : (
            <Button
              aria-label={`移除${noun} ${index + 1}`}
              onClick={() => onChange(entries.filter((_, at) => at !== index))}
              size="sm"
              type="button"
              variant="ghost"
            >
              移除
            </Button>
          )}
        </div>
      ))}
      <div>
        <Button
          onClick={() => onChange([...entries, { key: "", value: "", existing: false }])}
          size="sm"
          type="button"
          variant="outline"
        >
          {`添加${legend}`}
        </Button>
      </div>
      {error ? (
        <p className={ERROR_TEXT} id={errorId}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * `新增连接器` / `编辑连接器` 对话框（connectors「中心「连接器」tab」，写法照模型 tab 的对话框）。按「有打开的对话框」
 * 条件挂载：关闭即卸载，表单状态（含凭证）随之丢弃。名称与类型在编辑时只读；只显示所选类型的字段。提交前逐字段校验，
 * 有原因就不发请求。请求在途时 `保存` 与 `取消` 禁用，Escape、遮罩与关闭按钮也关不掉。
 */
export function ConnectorFormDialog({
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
  const set = (patch: Partial<ConnectorFormValues>) =>
    setValues((current) => ({ ...current, ...patch }));
  const editing = opened !== null;

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
    const found = validateConnectorForm(values, opened);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(values);
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        className="max-h-[calc(100%-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="leading-5">{editing ? "编辑连接器" : "新增连接器"}</DialogTitle>
        </DialogHeader>
        {/* 不是登录表单：常见密码管理器据 data-form-type 与各自的忽略属性跳过它（同模型对话框）。 */}
        <form
          className="flex flex-col gap-3"
          data-form-type="other"
          noValidate
          onSubmit={submit}
          ref={formRef}
        >
          <Field error={errors.name} label="名称">
            {(field) => (
              <Input
                {...field}
                autoComplete="off"
                onChange={(event) => set({ name: event.target.value })}
                readOnly={editing}
                value={values.name}
              />
            )}
          </Field>
          <Field error={undefined} label="类型">
            {(field) => (
              <Select
                disabled={editing}
                onValueChange={(type) => set({ type: type as ConnectorFormValues["type"] })}
                value={values.type}
              >
                <SelectTrigger {...field} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field error={errors.description} label="描述">
            {(field) => (
              <Input
                {...field}
                autoComplete="off"
                onChange={(event) => set({ description: event.target.value })}
                value={values.description}
              />
            )}
          </Field>
          {values.type === "stdio" ? (
            <>
              <Field error={errors.command} label="命令">
                {(field) => (
                  <Input
                    {...field}
                    autoComplete="off"
                    className="font-mono"
                    onChange={(event) => set({ command: event.target.value })}
                    value={values.command}
                  />
                )}
              </Field>
              <Field error={errors.args} label="参数（每行一个）">
                {(field) => (
                  <Textarea
                    {...field}
                    className="font-mono"
                    onChange={(event) => set({ args: event.target.value })}
                    value={values.args}
                  />
                )}
              </Field>
              <EntriesField
                entries={values.env}
                error={errors.env}
                legend="环境变量"
                noun="变量"
                onChange={(env) => set({ env })}
              />
            </>
          ) : (
            <>
              <Field error={errors.url} label="地址">
                {(field) => (
                  <Input
                    {...field}
                    autoComplete="off"
                    onChange={(event) => set({ url: event.target.value })}
                    value={values.url}
                  />
                )}
              </Field>
              <EntriesField
                entries={values.headers}
                error={errors.headers}
                legend="请求头"
                noun="请求头"
                onChange={(headers) => set({ headers })}
              />
            </>
          )}
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
