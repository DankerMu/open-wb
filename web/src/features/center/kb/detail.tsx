import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ApiClient, BaseView, KbStatus } from "@/lib/api";
import { DocumentsTable } from "./documents-table.js";
import { IngestDialog, type IngestOutcome, IngestResults } from "./ingest-dialog.js";
import { RetryAlert } from "./list.js";
import { UploadButton } from "./upload-button.js";
import { useKbDocuments } from "./use-documents.js";

const LOADING = "正在读取文档";
const EMPTY_TEXT = "该知识库暂无文档";

type UploadLimits = Pick<Extract<KbStatus, { enabled: true }>, "uploadMaxFiles" | "uploadMaxBytes">;

/**
 * 知识库详情（knowledge-bases「中心「知识库」tab」的详情，s2a-kb-ragflow 任务 16.3、16.5）：列表下方、标题为
 * `<库名> · 文档` 的区域，内容是两个入库入口与文档表；读取失败显示信封文案与 `重试`。调用方按库 id 设 `key`，换库即
 * 重新挂载。移出成功后行按钮已不在，焦点落到标题。
 *
 * `从工作空间入库` 与 `上传文件` 只在知识库 `ready` 时渲染，共用一处入库结果；一批上传在途时 `从工作空间入库` 禁用
 *（对话框是模态的，打开时也点不到 `上传文件`），两者因此不会交错改写结果。两者成功后重取一次文档列表，写端点返回的
 * `queued` 由此进入 3 秒刷新。
 */
export function KnowledgeBaseDetail({
  base,
  client,
  limits,
  onCount,
}: {
  base: BaseView;
  client: ApiClient;
  limits: UploadLimits;
  onCount(count: number): void;
}) {
  const docs = useKbDocuments(client, base.id, onCount);
  const { view } = docs;
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const ingestRef = useRef<HTMLButtonElement>(null);
  const [ingesting, setIngesting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [outcome, setOutcome] = useState<IngestOutcome | null>(null);

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2 pt-2">
      <h3
        className="m-0 text-sm font-medium [overflow-wrap:anywhere]"
        id={titleId}
        ref={titleRef}
        tabIndex={-1}
      >
        {base.name} · 文档
      </h3>
      {base.state === "ready" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={uploading} onClick={() => setIngesting(true)} ref={ingestRef} size="sm">
            从工作空间入库
          </Button>
          <UploadButton
            baseId={base.id}
            client={client}
            maxBytes={limits.uploadMaxBytes}
            maxFiles={limits.uploadMaxFiles}
            busy={uploading}
            onBusy={setUploading}
            onOutcome={setOutcome}
            onUploaded={docs.refetch}
          />
        </div>
      ) : null}
      <IngestResults outcome={outcome} />
      {view.status === "loading" ? <p className="ui-muted">{LOADING}</p> : null}
      {view.status === "failed" ? (
        <RetryAlert message={view.message} onRetry={docs.reload} />
      ) : null}
      {view.status === "ready" && view.documents.length === 0 ? (
        <p className="ui-muted">{EMPTY_TEXT}</p>
      ) : null}
      {view.status === "ready" && view.documents.length > 0 ? (
        <DocumentsTable
          documents={view.documents}
          onReingest={(id) => void docs.reingest(id)}
          onRemove={(id) =>
            void docs.remove(id).then((gone) => {
              if (gone) titleRef.current?.focus();
            })
          }
          pending={docs.pending}
          rowErrors={docs.rowErrors}
          spaces={docs.spaces}
          state={base.state}
        />
      ) : null}
      {ingesting ? (
        <IngestDialog
          baseId={base.id}
          client={client}
          maxFiles={limits.uploadMaxFiles}
          onCancel={() => setIngesting(false)}
          onRetryWorkspaces={docs.retryWorkspaces}
          onDone={({ rejected }) => {
            setIngesting(false);
            setOutcome({
              notice: null,
              failures: rejected.map((item) => ({ name: item.path, message: item.message })),
            });
            docs.refetch();
          }}
          restoreFocus={() => ingestRef.current?.focus()}
          workspaces={docs.workspaces}
        />
      ) : null}
    </section>
  );
}
