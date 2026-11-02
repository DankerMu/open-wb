import { type FormEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { BaseView, CreateKnowledgeBaseInput } from "@/lib/api";
import { useEscapeFallback } from "../../../components/escape-fallback.js";
import { TEMPLATES, templateLabel } from "./templates.js";

const ERROR_TEXT =
  "m-0 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";

type Values = { name: string; template: BaseView["template"]; raptor: boolean; graph: boolean };

type CreateDialogProps = {
  /** `GET /api/kb/status` 的 `compileReady`：知识库对话模型已指定。为假时两个复选都不渲染，十一种模板都一样。 */
  compileReady: boolean;
  pending: boolean;
  /** 服务端拒绝的原因（信封文案）。 */
  error: string | null;
  restoreFocus(): void;
  onSubmit(input: CreateKnowledgeBaseInput): void;
  onCancel(): void;
};

/** 只发所给的键：没勾的开关不带。名称原样发送，由服务端判定。 */
function toInput({ name, template, raptor, graph }: Values): CreateKnowledgeBaseInput {
  return { name, template, ...(raptor ? { raptor } : {}), ...(graph ? { graph } : {}) };
}

function CompileOption({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox checked={checked} id={id} onCheckedChange={(next) => onChange(next === true)} />
      <Label className="font-normal" htmlFor={id}>
        {label}
      </Label>
    </div>
  );
}

/**
 * `新建知识库` 对话框（knowledge-bases「中心「知识库」tab」）：名称、模板（十一种，每项带 demo 的说明）与只在
 * `compileReady` 时渲染的 `RAPTOR` / `知识图谱` 复选。按「有打开的对话框」条件挂载，关闭即卸载。请求在途时 `创建` 与
 * `取消` 禁用，Escape、遮罩与关闭按钮也关不掉；失败的信封文案以 `role="alert"` 留在框内。
 */
export function CreateKnowledgeBaseDialog({
  compileReady,
  pending,
  error,
  restoreFocus,
  onSubmit,
  onCancel,
}: CreateDialogProps) {
  const [values, setValues] = useState<Values>({
    name: "",
    template: "naive",
    raptor: false,
    graph: false,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const nameId = useId();
  const templateId = useId();
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: !pending, onOpenChange });
  const set = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));

  // 两个按钮在请求发出的那次提交里被禁用：焦点若因此落到 body，移回名称输入框。
  useLayoutEffect(() => {
    if (!pending) return;
    const active = document.activeElement;
    if (active === document.body || (active as HTMLButtonElement | null)?.disabled) {
      formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    }
  }, [pending]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    onSubmit(toInput(values));
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
          <DialogTitle className="leading-5">新建知识库</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" noValidate onSubmit={submit} ref={formRef}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>名称</Label>
            <Input
              autoComplete="off"
              id={nameId}
              onChange={(event) => set({ name: event.target.value })}
              value={values.name}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={templateId}>模板</Label>
            <Select
              onValueChange={(template) => set({ template: template as Values["template"] })}
              value={values.template}
            >
              <SelectTrigger className="w-full" id={templateId}>
                <SelectValue>{templateLabel(values.template)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TEMPLATES.map((template) => (
                  <SelectItem key={template.key} value={template.key}>
                    {`${template.label} — ${template.description}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {compileReady ? (
            <div className="flex flex-col gap-2">
              <CompileOption
                checked={values.raptor}
                label="RAPTOR"
                onChange={(raptor) => set({ raptor })}
              />
              <CompileOption
                checked={values.graph}
                label="知识图谱"
                onChange={(graph) => set({ graph })}
              />
            </div>
          ) : null}
          {error ? (
            <p className={ERROR_TEXT} role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button disabled={pending} onClick={onCancel} type="button" variant="ghost">
              取消
            </Button>
            <Button aria-busy={pending ? true : undefined} disabled={pending} type="submit">
              创建
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
