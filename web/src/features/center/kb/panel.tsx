import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/index";
import type { ApiClient, BaseView } from "@/lib/api";
import { RemoveDialog } from "../remove-dialog.js";
import { CreateKnowledgeBaseDialog } from "./create-dialog.js";
import { KnowledgeBaseDetail } from "./detail.js";
import { KnowledgeBaseList, KnowledgeBasesEmpty, RetryAlert } from "./list.js";
import { ScopeDialog, useMyScope } from "./scope-dialog.js";
import { useKnowledgeBases } from "./use-kb.js";

const UNAVAILABLE = "知识库服务暂不可用";
const NOT_READY = "管理员尚未配置知识库嵌入模型";

/**
 * 中心页「知识库」tab（knowledge-bases「中心「知识库」tab」）：状态行、当前用户的知识库表、`新建知识库` 对话框、
 * 删库确认、范围对话框，以及点行在表下方打开的详情（入库入口、文档表与检索测试；上传上限取本 tab 读到的状态）。
 * 两个对话框共用一份账号范围，在打开它们的点击里读一次。`client` 供用例注入；缺省取会话客户端（模型 tab 的先例）。
 */
export function KnowledgeBasesPanel({ client }: { client?: ApiClient }) {
  return client ? <KnowledgeBases client={client} /> : <SessionKnowledgeBases />;
}

function SessionKnowledgeBases() {
  const { createSessionClient } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  return <KnowledgeBases client={client} />;
}

function KnowledgeBases({ client }: { client: ApiClient }) {
  const kb = useKnowledgeBases(client);
  const { view, notice, form, remove } = kb;
  const myScope = useMyScope(client);
  const addRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** 打开详情与正在设置范围的库 id；行每次从 `view.bases` 现取，库已不在列表里（删除、重取后消失）时不渲染。 */
  const [selected, setSelected] = useState<string | null>(null);
  const [scoping, setScoping] = useState<string | null>(null);
  const find = (id: string | null) =>
    view.status === "ready" ? view.bases.find((item) => item.id === id) : undefined;
  const detailBase = find(selected);
  const scopeBase = find(scoping);
  /** 对话框关闭后把焦点还给打开它的按钮；行已删除（opener 被清掉或已不在页面上）时落到 `新建知识库`。 */
  const restoreFocus = () =>
    (opener.current?.isConnected ? opener.current : addRef.current)?.focus();
  const openScope = (base: BaseView, trigger: HTMLElement) => {
    opener.current = trigger;
    myScope.load();
    setScoping(base.id);
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
                  myScope.load();
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
              onOpen={(base) => setSelected(base.id)}
              onRemove={(base, trigger) => {
                opener.current = trigger;
                kb.askRemove(base);
              }}
              onScope={openScope}
              selected={selected}
            />
          )}
          {detailBase ? (
            <KnowledgeBaseDetail
              base={detailBase}
              client={client}
              key={detailBase.id}
              limits={view.kb}
              onCount={(count) => kb.setDocumentCount(detailBase.id, count)}
              onRefetchBases={kb.refetchBases}
              onRetrieval={(retrieval) => kb.setRetrieval(detailBase.id, retrieval)}
              onScope={(trigger) => openScope(detailBase, trigger)}
            />
          ) : null}
          {form ? (
            <CreateKnowledgeBaseDialog
              compileReady={view.kb.compileReady}
              error={form.error}
              onCancel={kb.closeForm}
              onSubmit={(input) => void kb.submit(input)}
              pending={form.pending}
              restoreFocus={restoreFocus}
              scope={myScope.state}
            />
          ) : null}
        </>
      ) : null}
      {remove ? (
        <RemoveDialog
          onCancel={kb.cancelRemove}
          onConfirm={() =>
            void kb.confirmRemove(() => {
              opener.current = null;
            })
          }
          pending={remove.pending}
          restoreFocus={restoreFocus}
          title={`删除知识库 ${remove.base.name}？`}
        />
      ) : null}
      {scopeBase ? (
        <ScopeDialog
          base={scopeBase}
          client={client}
          onCancel={() => setScoping(null)}
          onSaved={(next) => {
            kb.replaceBase(next);
            setScoping(null);
          }}
          restoreFocus={restoreFocus}
          state={myScope.state}
        />
      ) : null}
    </section>
  );
}
