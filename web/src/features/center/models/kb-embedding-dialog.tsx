import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import type { KbSettingsView } from "@/lib/api";
import { RemoveDialog } from "../remove-dialog.js";
import { BaseUrlField, FormDialogShell, KeyField, TextField } from "./form-parts.js";
import type { EmbeddingInput } from "./use-kb-settings.js";
import { BASE_URL_MESSAGE, isUpstreamBaseUrl } from "./validate.js";

const MAX_NAME_BYTES = 128;
/** 名称要拼成 `<name>@<实例>@<提供方>`，所以不能含 `@`；控制字符与服务端同一口径（`\p{Cc}`）。 */
const NOT_A_MODEL_NAME = /[\p{Cc}@]/u;
const MESSAGES = {
  name: "名称需为 1–128 字节，且不含控制字符或 @",
  keyRequired: "首次配置必须填密钥",
  keyBlank: "密钥不能只有空白",
} as const;

type Values = { name: string; baseUrl: string; apiKey: string };
type Errors = Partial<Record<keyof Values, string>>;

/** 服务端把 U+0085 与空白一起 trim（RAGFlow 按 trim 后的值写入），只有这些字符的密钥是 400。 */
function isBlankKey(key: string): boolean {
  return key.replaceAll("\u0085", "").trim() === "";
}

/**
 * 与服务端同一份规则（ragflow-backend「知识库模型设置」）：名称 1–128 字节、无控制字符、不含 `@`；地址与模型上游同一
 * 规则；首次配置必须填密钥，之后留空即保留；填了就不能只有空白。密钥是否为合法 header 值留给服务端。
 */
function validate(values: Values, configured: boolean): Errors {
  const errors: Errors = {};
  const { name, baseUrl, apiKey } = values;
  const bytes = new TextEncoder().encode(name).length;
  if (bytes === 0 || bytes > MAX_NAME_BYTES || NOT_A_MODEL_NAME.test(name)) {
    errors.name = MESSAGES.name;
  }
  if (!isUpstreamBaseUrl(baseUrl)) errors.baseUrl = BASE_URL_MESSAGE;
  if (apiKey === "") {
    if (!configured) errors.apiKey = MESSAGES.keyRequired;
  } else if (isBlankKey(apiKey)) {
    errors.apiKey = MESSAGES.keyBlank;
  }
  return errors;
}

/** 密钥留空即省略 `apiKey`（保留已存的值），从不发空串。 */
function toInput({ name, baseUrl, apiKey }: Values): EmbeddingInput {
  return apiKey === "" ? { name, baseUrl } : { name, baseUrl, apiKey };
}

type Props = {
  settings: KbSettingsView;
  pending: boolean;
  error: string | null;
  /** 确认框是否打开（`更换嵌入模型？`）。 */
  confirming: boolean;
  restoreFocus(): void;
  onSave(input: EmbeddingInput): void;
  onConfirm(): void;
  onCancelConfirm(): void;
  onCancel(): void;
};

/**
 * 知识库嵌入模型对话框（model-registry「模型 tab」的「知识库模型」段）：`名称`、`上游地址`、`密钥`。按「有打开的对话框」
 * 条件挂载，关闭即丢弃表单值（含密钥）；密钥框恒为 `type="password"`、打开时为空，已配置时 placeholder `留空保留现有密钥`。
 * 更换嵌入模型的确认框叠在它上面：取消回到表单、值还在；`重建并保存` 恰发一次带 `confirmRebuild:true` 的保存。
 */
export function KbEmbeddingDialog({
  settings,
  pending,
  error,
  confirming,
  restoreFocus,
  onSave,
  onConfirm,
  onCancelConfirm,
  onCancel,
}: Props) {
  const configured = settings.embedding !== null;
  const [values, setValues] = useState<Values>(() => ({
    name: settings.embedding?.name ?? "",
    baseUrl: settings.embedding?.baseUrl ?? "",
    apiKey: "",
  }));
  const [errors, setErrors] = useState<Errors>({});
  const saveRef = useRef<HTMLButtonElement>(null);
  const set = (patch: Partial<Values>) => setValues((current) => ({ ...current, ...patch }));

  function submit() {
    const found = validate(values, configured);
    setErrors(found);
    if (Object.keys(found).length === 0) onSave(toInput(values));
  }

  return (
    <>
      <FormDialogShell
        error={error}
        onCancel={onCancel}
        onSubmit={submit}
        // 确认框打开时请求在途的是确认框：它自己禁用按钮，表单在它下面不可达。
        pending={pending && !confirming}
        restoreFocus={restoreFocus}
        saveRef={saveRef}
        title="知识库嵌入模型"
      >
        <TextField error={errors.name} label="名称">
          {(field) => (
            <Input
              {...field}
              autoComplete="off"
              onChange={(event) => set({ name: event.target.value })}
              value={values.name}
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
          keep={configured}
          onChange={(apiKey) => set({ apiKey })}
          value={values.apiKey}
        />
      </FormDialogShell>
      {confirming ? (
        <RemoveDialog
          confirmLabel="重建并保存"
          description={`更换嵌入模型会重建全部 ${settings.bases} 个知识库（共 ${settings.documents} 份文档），重建期间不能入库。`}
          onCancel={onCancelConfirm}
          onConfirm={onConfirm}
          pending={pending}
          restoreFocus={() => saveRef.current?.focus()}
          title="更换嵌入模型？"
        />
      ) : null}
    </>
  );
}
