import { useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/index";
import type { ApiClient } from "@/lib/api";
import { ModelFormDialog } from "./form-dialog.js";
import { ModelList, RemoveModelDialog } from "./list.js";
import { useModels } from "./use-models.js";

/**
 * 中心页「模型」tab（model-registry「模型 tab」）：模型表、`新增模型` / `编辑模型` 对话框与删除确认。
 * `client` 供用例注入；缺省取会话客户端（`useAuth().createSessionClient()`，同文件页的先例）。
 */
export function ModelsPanel({ client }: { client?: ApiClient }) {
  return client ? <Models client={client} /> : <SessionModels />;
}

function SessionModels() {
  const { createSessionClient } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  return <Models client={client} />;
}

function Models({ client }: { client: ApiClient }) {
  const models = useModels(client);
  const { list, notice, form, remove } = models;
  const addRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** 对话框关闭后把焦点还给打开它的按钮；行已删除（opener 被清掉或已不在页面上）时落到 `新增模型`。 */
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
      {list.status === "loading" ? <p className="ui-muted">正在读取模型</p> : null}
      {list.status === "failed" ? (
        <p className="ui-alert" role="alert">
          {list.message}
        </p>
      ) : null}
      {list.status === "ready" ? (
        <>
          <div>
            <Button
              onClick={(event) => {
                opener.current = event.currentTarget;
                models.openCreate();
              }}
              ref={addRef}
              size="sm"
            >
              新增模型
            </Button>
          </div>
          <ModelList
            defaulting={models.defaulting}
            models={list.models}
            onEdit={(model, trigger) => {
              opener.current = trigger;
              models.openEdit(model);
            }}
            onProbe={(id) => void models.probe(id)}
            onRemove={(model, trigger) => {
              opener.current = trigger;
              models.askRemove(model);
            }}
            onSetDefault={(id) => void models.setDefault(id)}
            probing={models.probing}
            rowErrors={models.rowErrors}
          />
        </>
      ) : null}
      {form ? (
        <ModelFormDialog
          error={form.error}
          onCancel={models.closeForm}
          onSubmit={(values) => void models.submit(values)}
          opened={form.opened}
          pending={form.pending}
          restoreFocus={restoreFocus}
        />
      ) : null}
      {remove ? (
        <RemoveModelDialog
          model={remove.model}
          onCancel={models.cancelRemove}
          onConfirm={() =>
            void models.confirmRemove(() => {
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
