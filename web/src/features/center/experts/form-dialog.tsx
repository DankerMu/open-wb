import { type FormEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { EXPERT_CATEGORIES, type ExpertCategory, type ExpertView } from "@/lib/api";
import { useEscapeFallback } from "../../../components/escape-fallback.js";
import {
  type ExpertFormValues,
  type FieldErrors,
  initialValues,
  validateExpertForm,
} from "./validate.js";

const TAGS_PLACEHOLDER = "以逗号分隔，最多 5 个";
const NO_SKILLS = "没有可选的技能";
const ERROR_TEXT = "m-0 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";

type FormDialogProps = {
  /** null 是新建；否则是编辑该视图（打开那一刻的）。 */
  opened: ExpertView | null;
  /** 技能清单的名称：读取中为 null，读取失败为空表。 */
  skillNames: readonly string[] | null;
  pending: boolean;
  /** 服务端拒绝的原因（`ApiError.message`）；客户端校验的原因显示在各字段旁。 */
  error: string | null;
  restoreFocus(): void;
  onSubmit(values: ExpertFormValues): void;
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

function SkillOption({
  name,
  checked,
  onChange,
}: {
  name: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox checked={checked} id={id} onCheckedChange={(next) => onChange(next === true)} />
      <Label className="font-normal [overflow-wrap:anywhere]" htmlFor={id}>
        {name}
      </Label>
    </div>
  );
}

/**
 * 技能多选的选项：技能清单的名称（按返回次序），再加上该专家已有、却不在清单里的名称（按已有次序）——
 * 后者初始已勾，取消即从提交里去掉。
 */
function skillOptions(skillNames: readonly string[] | null, opened: ExpertView | null): string[] {
  const listed = skillNames ?? [];
  const extra = (opened?.skills ?? []).filter((name) => !listed.includes(name));
  return [...listed, ...extra];
}

/**
 * `新建专家` / `编辑专家` 对话框（experts「中心「专家」tab」）。按「有打开的对话框」条件挂载：关闭即卸载，表单
 * 状态随之丢弃。提交前逐字段校验，有原因就不发请求。请求在途时 `保存` 与 `取消` 禁用，Escape、遮罩与关闭按钮也
 * 关不掉（结果总落在打开的对话框上）。
 */
export function ExpertFormDialog({
  opened,
  skillNames,
  pending,
  error,
  restoreFocus,
  onSubmit,
  onCancel,
}: FormDialogProps) {
  const [values, setValues] = useState(() => initialValues(opened));
  const [errors, setErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const skillsErrorId = useId();
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: !pending, onOpenChange });
  const set = (patch: Partial<ExpertFormValues>) =>
    setValues((current) => ({ ...current, ...patch }));
  const options = skillOptions(skillNames, opened);

  // 两个按钮在请求发出的那次提交里被禁用：焦点若因此落到 body，移回表单的第一个输入框。
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
    const found = validateExpertForm(values);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(values);
  }

  function toggleSkill(name: string, checked: boolean) {
    const others = values.skills.filter((candidate) => candidate !== name);
    set({ skills: checked ? [...others, name] : others });
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
          <DialogTitle className="leading-5">{opened ? "编辑专家" : "新建专家"}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" noValidate onSubmit={submit} ref={formRef}>
          <Field error={errors.name} label="名称">
            {(field) => (
              <Input
                {...field}
                autoComplete="off"
                onChange={(event) => set({ name: event.target.value })}
                value={values.name}
              />
            )}
          </Field>
          <Field error={undefined} label="分类">
            {(field) => (
              <Select
                onValueChange={(category) => set({ category: category as ExpertCategory })}
                value={values.category}
              >
                <SelectTrigger {...field} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPERT_CATEGORIES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field error={errors.tags} label="标签">
            {(field) => (
              <Input
                {...field}
                autoComplete="off"
                onChange={(event) => set({ tags: event.target.value })}
                placeholder={TAGS_PLACEHOLDER}
                value={values.tags}
              />
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
          <Field error={errors.prompt} label="提示词">
            {(field) => (
              <Textarea
                {...field}
                className="min-h-32"
                onChange={(event) => set({ prompt: event.target.value })}
                value={values.prompt}
              />
            )}
          </Field>
          <fieldset
            aria-describedby={errors.skills ? skillsErrorId : undefined}
            className="m-0 flex flex-col gap-1.5 border-0 p-0"
          >
            <legend className="mb-1.5 text-sm font-medium">技能</legend>
            {options.length > 0 ? (
              <div className="flex max-h-40 flex-col gap-2 overflow-y-auto">
                {options.map((name) => (
                  <SkillOption
                    checked={values.skills.includes(name)}
                    key={name}
                    name={name}
                    onChange={(checked) => toggleSkill(name, checked)}
                  />
                ))}
              </div>
            ) : skillNames !== null ? (
              <p className="ui-muted m-0 text-xs">{NO_SKILLS}</p>
            ) : null}
            {errors.skills ? (
              <p className={ERROR_TEXT} id={skillsErrorId}>
                {errors.skills}
              </p>
            ) : null}
          </fieldset>
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
