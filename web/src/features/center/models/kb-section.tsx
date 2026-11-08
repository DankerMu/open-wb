import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ApiClient, KbSettingsView, ModelView } from "@/lib/api";
import { RetryAlert } from "../kb/list.js";
import { KbModelDialog } from "./kb-model-dialog.js";
import { ProbeCell } from "./list.js";
import { useKbSettings } from "./use-kb-settings.js";

const TITLE = "知识库模型";
const UNAVAILABLE = "知识库服务暂不可用";
const NONE_LABEL = "不使用";
/** `不使用` 的选项值：拷入层 Select 不收空串；知识库对话模型的 id 不含 `@`，不会与它相撞。 */
const NONE = "@none";
const TERM = "text-muted-foreground";

/**
 * 可选的知识库对话模型：对话模型表里带上游、id 不含 `@` 的行（ragflow-backend「知识库模型设置」）。当前已指定的 id
 * 不在其中（表还在读取，或它的上游在知识库关闭期间被清空）时仍列出它，让下拉如实显示当前值。
 */
function chatChoices(models: readonly ModelView[], current: string | null): string[] {
  const ids = models
    .filter((model) => model.upstream !== null && !model.id.includes("@"))
    .map((model) => model.id);
  return current === null || ids.includes(current) ? ids : [...ids, current];
}

/** 嵌入模型：名称、上游地址、密钥是否已配置（读视图不含密钥，配置过即有）与探活状态。 */
function EmbeddingSummary({ embedding }: { embedding: KbSettingsView["embedding"] }) {
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      <dt className={TERM}>嵌入模型</dt>
      <dd className="m-0 [overflow-wrap:anywhere]">{embedding?.name ?? "未配置"}</dd>
      {embedding ? (
        <>
          <dt className={TERM}>上游地址</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">{embedding.baseUrl}</dd>
          <dt className={TERM}>密钥</dt>
          <dd className="m-0">已配置</dd>
          <dt className={TERM}>探活</dt>
          <dd className="m-0">
            <ProbeCell probe={embedding.probe} />
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * `知识库对话模型` 下拉：`不使用` 加可选的模型，改动即交给 `onChange`（恰一次请求）。已指定且有开编译的库时禁用，
 * 旁注原因（model-registry「开编译的库锁定对话模型下拉」）；在途时同样禁用。
 */
function ChatModelField({
  view,
  models,
  pending,
  onChange,
}: {
  view: KbSettingsView;
  models: readonly ModelView[];
  pending: boolean;
  onChange(chatModelId: string | null): void;
}) {
  const id = useId();
  const locked = view.chatModelId !== null && view.compileBases > 0;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>知识库对话模型</Label>
      <Select
        disabled={locked || pending}
        onValueChange={(value) => onChange(value === NONE ? null : value)}
        value={view.chatModelId ?? NONE}
      >
        <SelectTrigger className="w-full sm:w-72" id={id}>
          <SelectValue>{view.chatModelId ?? NONE_LABEL}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{NONE_LABEL}</SelectItem>
          {chatChoices(models, view.chatModelId).map((choice) => (
            <SelectItem key={choice} value={choice}>
              {choice}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {locked ? (
        <p className="ui-muted text-xs">
          {`已有 ${view.compileBases} 个开启 RAPTOR 或知识图谱的知识库，不能更换或取消`}
        </p>
      ) : null}
    </div>
  );
}

/** 知识库数、文档数与重建状态；有重建失败的库时给 `重试失败的重建`。 */
function BaseCounts({
  view,
  retrying,
  onRetry,
}: {
  view: KbSettingsView;
  retrying: boolean;
  onRetry(): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span>{`知识库 ${view.bases} 个，文档 ${view.documents} 份`}</span>
      {view.rebuilding > 0 ? <span>{`重建中 ${view.rebuilding} 个`}</span> : null}
      {view.rebuildFailed > 0 ? (
        <>
          <span className="text-(--wb-status-error-text)">{`重建失败 ${view.rebuildFailed} 个`}</span>
          <Button disabled={retrying} onClick={onRetry} size="sm" variant="outline">
            重试失败的重建
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * 模型表下方的「知识库模型」段（model-registry「模型 tab」，design D19）：嵌入模型与它的对话框、知识库对话模型下拉
 * （已指定且有开编译的库时禁用并旁注原因）、知识库数与文档数、重建状态与 `重试失败的重建`。知识库关闭时不渲染。
 */
export function KbSection({ client, models }: { client: ApiClient; models: readonly ModelView[] }) {
  const kb = useKbSettings(client);
  const { state, notice, form, busy } = kb;
  const titleId = useId();
  const editRef = useRef<HTMLButtonElement>(null);
  if (state.status === "hidden") return null;
  const view = state.status === "ready" ? state.view : null;

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3 pt-4">
      <h3 className="m-0 text-sm font-medium" id={titleId}>
        {TITLE}
      </h3>
      {notice ? (
        <p className="ui-alert" role="alert">
          {notice}
        </p>
      ) : null}
      {state.status === "loading" ? <p className="ui-muted">正在读取知识库模型设置</p> : null}
      {state.status === "failed" ? (
        <RetryAlert message={UNAVAILABLE} onRetry={() => void kb.reload()} />
      ) : null}
      {view ? (
        <>
          <EmbeddingSummary embedding={view.embedding} />
          <div className="flex flex-wrap gap-1">
            <Button onClick={kb.openForm} ref={editRef} size="sm" variant="outline">
              编辑
            </Button>
            {view.embedding ? (
              <Button disabled={busy.has("probe")} onClick={kb.probe} size="sm" variant="outline">
                探活
              </Button>
            ) : null}
          </div>
          <ChatModelField
            models={models}
            onChange={kb.setChatModel}
            pending={busy.has("chat")}
            view={view}
          />
          <BaseCounts onRetry={kb.retryRebuild} retrying={busy.has("retry")} view={view} />
          {form ? (
            <KbModelDialog
              confirming={form.confirm !== null}
              error={form.error}
              kind="embedding"
              onCancel={kb.closeForm}
              onCancelConfirm={kb.cancelConfirm}
              onConfirm={() => void kb.confirmRebuild()}
              onSave={(input) => void kb.save(input)}
              pending={form.pending}
              restoreFocus={() => editRef.current?.focus()}
              settings={view}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
