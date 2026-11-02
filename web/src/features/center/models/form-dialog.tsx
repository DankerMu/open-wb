import { useId, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MODEL_EFFORTS, type ModelView } from "@/lib/api";
import { BaseUrlField, FormDialogShell, KeyField, TextField } from "./form-parts.js";
import {
  type FieldErrors,
  initialValues,
  type ModelEffort,
  type ModelFormValues,
  validateModelForm,
} from "./validate.js";

const EFFORTS_NOTE = "不勾选即不声明强度集合，界面列全部档位";

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
  const set = (patch: Partial<ModelFormValues>) =>
    setValues((current) => ({ ...current, ...patch }));

  function submit() {
    const found = validateModelForm(values, opened);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(values);
  }

  function toggleEffort(effort: ModelEffort, checked: boolean) {
    const others = values.efforts.filter((candidate) => candidate !== effort);
    set({ efforts: checked ? [...others, effort] : others });
  }

  return (
    <FormDialogShell
      error={error}
      onCancel={onCancel}
      onSubmit={submit}
      pending={pending}
      restoreFocus={restoreFocus}
      title={opened ? "编辑模型" : "新增模型"}
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
        <CheckField checked={values.vision} label="看图" onChange={(vision) => set({ vision })} />
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
      <BaseUrlField
        error={errors.baseUrl}
        onChange={(baseUrl) => set({ baseUrl })}
        value={values.baseUrl}
      />
      <KeyField
        error={errors.apiKey}
        keep={opened !== null}
        onChange={(apiKey) => set({ apiKey })}
        value={values.apiKey}
      />
    </FormDialogShell>
  );
}
