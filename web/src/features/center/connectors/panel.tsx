import { useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/index";
import type { ApiClient } from "@/lib/api";
import { isAdmin } from "@/lib/roles";
import { ConnectorFormDialog } from "./form-dialog.js";
import {
  AdminConnectorList,
  ConnectorsEmpty,
  MemberConnectorList,
  RemoveConnectorDialog,
} from "./list.js";
import { useConnectors } from "./use-connectors.js";

/**
 * 中心页「连接器」tab（connectors「中心「连接器」tab」）：连接器表（每行 `默认启用`；管理员另有命令或地址、探活、
 * `启用` 与行操作）、空态、`新增连接器` / `编辑连接器` 对话框与删除确认。管理界面的显隐按 `isAdmin(principal)`，
 * 不按应答形状。`client` 与 `admin` 供用例注入；缺省取会话客户端与会话 principal（模型 tab 的先例）。
 */
export function ConnectorsPanel({ client, admin }: { client?: ApiClient; admin?: boolean }) {
  return client ? <Connectors admin={admin ?? false} client={client} /> : <SessionConnectors />;
}

function SessionConnectors() {
  const { createSessionClient, principal } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  return <Connectors admin={principal !== null && isAdmin(principal)} client={client} />;
}

function Connectors({ client, admin }: { client: ApiClient; admin: boolean }) {
  const connectors = useConnectors(client, admin);
  const { list, notice, form, remove } = connectors;
  const addRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** 对话框关闭后把焦点还给打开它的按钮；行已删除（opener 被清掉或已不在页面上）时落到 `新增连接器`。 */
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
      {list.status === "loading" ? <p className="ui-muted">正在读取连接器</p> : null}
      {list.status === "failed" ? (
        <p className="ui-alert" role="alert">
          {list.message}
        </p>
      ) : null}
      {list.status === "ready" ? (
        <>
          {admin ? (
            <div>
              <Button
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  connectors.openCreate();
                }}
                ref={addRef}
                size="sm"
              >
                新增连接器
              </Button>
            </div>
          ) : null}
          <ConnectorTable admin={admin} connectors={connectors} opener={opener} ready={list} />
        </>
      ) : null}
      {form ? (
        <ConnectorFormDialog
          error={form.error}
          onCancel={connectors.closeForm}
          onSubmit={(values) => void connectors.submit(values)}
          opened={form.opened}
          pending={form.pending}
          restoreFocus={restoreFocus}
        />
      ) : null}
      {remove ? (
        <RemoveConnectorDialog
          connector={remove.connector}
          onCancel={connectors.cancelRemove}
          onConfirm={() =>
            void connectors.confirmRemove(() => {
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

type Hook = ReturnType<typeof useConnectors>;

/** 读取成功后的主体：空态，或按 `isAdmin(principal)` 选管理员表 / 普通用户表。 */
function ConnectorTable({
  connectors,
  ready,
  admin,
  opener,
}: {
  connectors: Hook;
  ready: Extract<Hook["list"], { status: "ready" }>;
  admin: boolean;
  opener: { current: HTMLElement | null };
}) {
  const { listing } = ready;
  const defaults = {
    disabled: ready.disabled,
    defaultsPending: connectors.defaultsPending,
    onToggleDefault: (name: string, enabled: boolean) =>
      void connectors.toggleDefault(name, enabled),
  };
  if (listing.connectors.length === 0) return <ConnectorsEmpty />;
  // 管理员收到三键视图的非空表时 `useConnectors` 已判为无效应答，走不到这里的普通用户分支。
  if (!admin || !listing.admin) {
    return <MemberConnectorList {...defaults} connectors={listing.connectors} />;
  }
  return (
    <AdminConnectorList
      {...defaults}
      connectors={listing.connectors}
      enabling={connectors.enabling}
      onEdit={(view, trigger) => {
        opener.current = trigger;
        connectors.openEdit(view);
      }}
      onProbe={(name) => void connectors.probe(name)}
      onRemove={(view, trigger) => {
        opener.current = trigger;
        connectors.askRemove(view);
      }}
      onToggleEnabled={(view) => void connectors.toggleEnabled(view)}
      probing={connectors.probing}
    />
  );
}
