import { useMemo, useRef } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/index";
import type { ApiClient } from "@/lib/api";
import { ExpertFormDialog } from "./form-dialog.js";
import { ExpertBrowser, RemoveExpertDialog } from "./list.js";
import { useExperts } from "./use-experts.js";

/**
 * 中心页「专家」tab（experts「中心「专家」tab」）：分类 chip、搜索、卡片网格、`新建专家` / `编辑专家` 对话框与删除
 * 确认。`开始会话` 只以 `navigate("/", {state: {expertId}})` 回到欢迎态，不发任何会话请求（欢迎态读取该 state
 * 归任务组 9）。`client` 供用例注入；缺省取会话客户端（`useAuth().createSessionClient()`，模型 tab 的先例）。
 */
export function ExpertsPanel({ client }: { client?: ApiClient }) {
  return client ? <Experts client={client} /> : <SessionExperts />;
}

function SessionExperts() {
  const { createSessionClient } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  return <Experts client={client} />;
}

function Experts({ client }: { client: ApiClient }) {
  const experts = useExperts(client);
  const { list, notice, form, remove } = experts;
  const navigate = useNavigate();
  const createRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** 对话框关闭后把焦点还给打开它的按钮；卡片已不在页面上时落到 `新建专家`。 */
  const restoreFocus = () => {
    const target = opener.current?.isConnected ? opener.current : createRef.current;
    target?.focus();
  };

  return (
    <section className="flex min-w-0 flex-col gap-3 pt-4">
      {notice ? (
        <p className="ui-alert" role="alert">
          {notice}
        </p>
      ) : null}
      {list.status === "loading" ? <p className="ui-muted">正在读取专家</p> : null}
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
                experts.openCreate();
              }}
              ref={createRef}
              size="sm"
            >
              新建专家
            </Button>
          </div>
          <ExpertBrowser
            experts={list.experts}
            onEdit={(expert, trigger) => {
              opener.current = trigger;
              experts.openEdit(expert);
            }}
            onRemove={(expert, trigger) => {
              opener.current = trigger;
              experts.askRemove(expert);
            }}
            onStart={(expert) => navigate("/", { state: { expertId: expert.id } })}
          />
        </>
      ) : null}
      {form ? (
        <ExpertFormDialog
          error={form.error}
          onCancel={experts.closeForm}
          onSubmit={(values) => void experts.submit(values)}
          opened={form.opened}
          pending={form.pending}
          restoreFocus={restoreFocus}
          skillNames={form.skillNames}
        />
      ) : null}
      {remove ? (
        <RemoveExpertDialog
          expert={remove.expert}
          onCancel={experts.cancelRemove}
          onConfirm={() => void experts.confirmRemove()}
          pending={remove.pending}
          restoreFocus={restoreFocus}
        />
      ) : null}
    </section>
  );
}
