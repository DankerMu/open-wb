import { type FormEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
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
import { DialogActions, DialogAlert, KbDialog } from "./dialog-shell.js";
import { chosenGroup, type MyScopeState, ScopeFields, scopeInput } from "./scope-dialog.js";
import { TEMPLATES, templateLabel } from "./templates.js";

type Values = {
  name: string;
  template: BaseView["template"];
  raptor: boolean;
  graph: boolean;
  scope: BaseView["scope"]["scope"];
  /** 用户在项目组下拉里选的组；没选过为 `null`（取首项）。 */
  groupId: string | null;
};

type CreateDialogProps = {
  /** `GET /api/kb/status` 的 `compileReady`：知识库对话模型已指定。为假时两个复选都不渲染，十一种模板都一样。 */
  compileReady: boolean;
  pending: boolean;
  /** 本次打开读到的账号范围（`useMyScope`）。 */
  scope: MyScopeState;
  /** 服务端拒绝的原因（信封文案）。 */
  error: string | null;
  restoreFocus(): void;
  onSubmit(input: CreateKnowledgeBaseInput): void;
  onCancel(): void;
};

/**
 * 只发所给的键：没勾的开关不带，仅自己可见不带范围键，`group` 档带 `groupId`。名称原样发送，由服务端判定。
 * `group` 档没有可选的组时为 `null`（`创建` 禁用）。
 */
function toInput(
  { name, template, raptor, graph, scope }: Values,
  groupId: string | null,
): CreateKnowledgeBaseInput | null {
  const input = { name, template, ...(raptor ? { raptor } : {}), ...(graph ? { graph } : {}) };
  if (scope === "me") return input;
  const range = scopeInput(scope, groupId);
  return range ? { ...input, ...range } : null;
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
 * `compileReady` 时渲染的 `RAPTOR` / `知识图谱` 复选，以及与范围对话框同一组的可见范围控件（初值 `仅自己可见`；
 * 没取到账号范围时只留这一档，取不到时另有一条 alert，建库照常）。按「有打开的对话框」条件挂载，关闭即卸载。
 * 请求在途时 `创建` 与 `取消` 禁用，Escape、遮罩与关闭按钮也关不掉；失败的信封文案以 `role="alert"` 留在框内。
 */
export function CreateKnowledgeBaseDialog({
  compileReady,
  pending,
  scope,
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
    scope: "me",
    groupId: null,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const nameId = useId();
  const templateId = useId();
  const set = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));
  const groupId = chosenGroup(scope, values.groupId);
  const input = toInput(values, groupId);

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
    if (pending || input === null) return;
    onSubmit(input);
  }

  return (
    <KbDialog onCancel={onCancel} pending={pending} restoreFocus={restoreFocus} title="新建知识库">
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
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">可见范围</span>
          <ScopeFields
            fallback="me-only"
            groupId={groupId}
            onChange={(next) => set({ scope: next })}
            onGroupChange={(next) => set({ groupId: next })}
            state={scope}
            value={values.scope}
          />
        </div>
        <DialogAlert message={error} />
        <DialogActions
          disabled={input === null}
          label="创建"
          onCancel={onCancel}
          pending={pending}
        />
      </form>
    </KbDialog>
  );
}
