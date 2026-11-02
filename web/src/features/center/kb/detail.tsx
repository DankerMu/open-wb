import { useId, useRef } from "react";
import type { ApiClient, BaseView } from "@/lib/api";
import { DocumentsTable } from "./documents-table.js";
import { RetryAlert } from "./list.js";
import { useKbDocuments } from "./use-documents.js";

const LOADING = "正在读取文档";
const EMPTY_TEXT = "该知识库暂无文档";

/**
 * 知识库详情（knowledge-bases「中心「知识库」tab」的详情，s2a-kb-ragflow 任务 16.3）：列表下方、标题为
 * `<库名> · 文档` 的区域，内容是文档表；读取失败显示信封文案与 `重试`。调用方按库 id 设 `key`，换库即重新挂载。
 * 移出成功后行按钮已不在，焦点落到标题。`从工作空间入库` 与 `上传文件` 归组 16 剩余部分。
 */
export function KnowledgeBaseDetail({
  base,
  client,
  onCount,
}: {
  base: BaseView;
  client: ApiClient;
  onCount(count: number): void;
}) {
  const docs = useKbDocuments(client, base.id, onCount);
  const { view } = docs;
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

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
    </section>
  );
}
