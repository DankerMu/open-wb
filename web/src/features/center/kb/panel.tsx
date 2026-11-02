import { useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/index";
import type { ApiClient } from "@/lib/api";
import { CreateKnowledgeBaseDialog } from "./create-dialog.js";
import { KnowledgeBaseList, KnowledgeBasesEmpty, RemoveKnowledgeBaseDialog } from "./list.js";
import { useKnowledgeBases } from "./use-kb.js";

const UNAVAILABLE = "知识库服务暂不可用";
const NOT_READY = "管理员尚未配置知识库嵌入模型";

/**
 * 中心页「知识库」tab（knowledge-bases「中心「知识库」tab」）：状态行、当前用户的知识库表、`新建知识库` 对话框与
 * 删库确认。`client` 供用例注入；缺省取会话客户端（模型 tab 的先例）。详情、入库与上传归 s2a-kb-ragflow 组 16。
 */
export function KnowledgeBasesPanel({ client }: { client?: ApiClient }) {
  return client ? <KnowledgeBases client={client} /> : <SessionKnowledgeBases />;
}

function SessionKnowledgeBases() {
  const { createSessionClient } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  return <KnowledgeBases client={client} />;
}

/** 页内错误与 `重试`（重取状态与列表）。 */
function RetryAlert({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="ui-alert" role="alert">
        {message}
      </p>
      <Button onClick={onRetry} size="sm" type="button" variant="secondary">
        重试
      </Button>
    </div>
  );
}

function KnowledgeBases({ client }: { client: ApiClient }) {
  const kb = useKnowledgeBases(client);
  const { view, notice, form, remove } = kb;
  const addRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** 对话框关闭后把焦点还给打开它的按钮；行已删除（opener 被清掉或已不在页面上）时落到 `新建知识库`。 */
  const restoreFocus = () => {
    const target = opener.current?.isConnected ? opener.current : addRef.current;
    target?.focus();
  };

  return (
    <section className="flex min-w-0 flex-col gap-3 pt-4">
      {notice ? (
        <p className="ui-alert" role="alert">
          {notice}
        </p>
      ) : null}
      {view.status === "loading" ? <p className="ui-muted">正在读取知识库</p> : null}
      {view.status === "unavailable" ? (
        <RetryAlert message={UNAVAILABLE} onRetry={kb.reload} />
      ) : null}
      {view.status === "failed" ? <RetryAlert message={view.message} onRetry={kb.reload} /> : null}
      {view.status === "ready" ? (
        <>
          {view.kb.embeddingReady ? (
            <div>
              <Button
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  kb.openCreate();
                }}
                ref={addRef}
                size="sm"
              >
                新建知识库
              </Button>
            </div>
          ) : (
            <p className="ui-muted">{NOT_READY}</p>
          )}
          {view.bases.length === 0 ? (
            <KnowledgeBasesEmpty />
          ) : (
            <KnowledgeBaseList
              bases={view.bases}
              onRemove={(base, trigger) => {
                opener.current = trigger;
                kb.askRemove(base);
              }}
            />
          )}
          {form ? (
            <CreateKnowledgeBaseDialog
              compileReady={view.kb.compileReady}
              error={form.error}
              onCancel={kb.closeForm}
              onSubmit={(input) => void kb.submit(input)}
              pending={form.pending}
              restoreFocus={restoreFocus}
            />
          ) : null}
        </>
      ) : null}
      {remove ? (
        <RemoveKnowledgeBaseDialog
          base={remove.base}
          onCancel={kb.cancelRemove}
          onConfirm={() =>
            void kb.confirmRemove(() => {
              opener.current = null;
            })
          }
          pending={remove.pending}
          restoreFocus={restoreFocus}
        />
      ) : null}
    </section>
  );
}
