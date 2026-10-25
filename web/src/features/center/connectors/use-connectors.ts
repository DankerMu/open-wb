import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiClient,
  ApiError,
  type ConnectorListing,
  type ConnectorView,
  REQUEST_FAILED_MESSAGE,
} from "@/lib/api";
import {
  type ConnectorFormValues,
  editOverrides,
  probesAfterSave,
  toCreateInput,
  toUpdateInput,
} from "./validate.js";

/**
 * 「连接器」tab 的数据与操作（connectors「中心「连接器」tab」，s1d-connectors 任务 6.3）。挂载恰一次
 * `listConnectors` 与 `getConnectorDefaults`（任一失败即页内错误）。`admin` 来自 `isAdmin(principal)`：管理员却收到
 * 三键视图的非空表视为无效应答。
 *
 * - `默认启用`（所有人）：照 `skills/use-skills.ts`——切换时先改成切换后的完整停用列表（含列表外的名称），恰一次
 *   `putConnectorDefaults`；在途期间全部 `默认启用` 开关不可切换（`aria-disabled`，由在途守卫拦下点击）；成功以应答
 *   替换，失败还原并在页顶提示。不重取列表。
 * - 管理员的写操作（`启用` 开关、新增 / 编辑、删除）与探活结算后（满足条件时先探活）再取一次列表——页面只按
 *   `listConnectors` 的结果显示。收到非信封的 500（发布失败，行已写入）：关闭对话框、不自动探活、重取列表，页顶提示
 *   `REQUEST_FAILED_MESSAGE`；新增 / 编辑的其它 `ApiError` 留在对话框内，其余显示在页顶。
 */

type ListState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; listing: ConnectorListing; disabled: string[] };

/** 打开的表单对话框：`opened` 为 null 是新增，否则是编辑该视图（打开那一刻的）。 */
type FormState = { opened: ConnectorView | null; pending: boolean; error: string | null };
type RemoveState = { connector: ConnectorView; pending: boolean };

/** `api.ts` 对非信封错误的构造：`request_failed` 加原状态码。 */
function isPublishFailure(error: unknown): boolean {
  return error instanceof ApiError && error.status === 500 && error.code === "request_failed";
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

function toggled(set: ReadonlySet<string>, name: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(name);
  else next.delete(name);
  return next;
}

/** 切换后的完整停用列表：加上（关闭）或去掉（打开）`name`，去重排序；列表外的名称原样保留。 */
function toggledNames(disabled: readonly string[], name: string, enabled: boolean): string[] {
  const rest = disabled.filter((item) => item !== name);
  return [...new Set(enabled ? rest : [...rest, name])].sort();
}

/** 管理员要的是管理员视图；空表两种形状相同。 */
function usable(listing: ConnectorListing, admin: boolean): boolean {
  return !admin || listing.admin || listing.connectors.length === 0;
}

export function useConnectors(client: ApiClient, admin: boolean) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [defaultsPending, setDefaultsPending] = useState(false);
  const [enabling, setEnabling] = useState<ReadonlySet<string>>(new Set());
  const [probing, setProbing] = useState<ReadonlySet<string>>(new Set());
  const [form, setForm] = useState<FormState | null>(null);
  const [remove, setRemove] = useState<RemoveState | null>(null);
  const sequence = useRef(0);
  /** 在途标记：同一帧里的第二次点击还看不到重渲染，靠它们拦下。 */
  const defaultsInFlight = useRef(false);
  const enablingInFlight = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    const own = ++sequence.current;
    Promise.all([client.listConnectors(), client.getConnectorDefaults()]).then(
      ([listing, disabled]) => {
        if (!live || own !== sequence.current) return;
        setList(
          usable(listing, admin)
            ? { status: "ready", listing, disabled }
            : { status: "failed", message: REQUEST_FAILED_MESSAGE },
        );
      },
      (error: unknown) => {
        if (live) setList({ status: "failed", message: messageOf(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [client, admin]);

  /** 只采用最后一次发出的列表请求的结果；失败只在页顶提示，表保留。 */
  const reload = useCallback(async () => {
    const own = ++sequence.current;
    try {
      const listing = await client.listConnectors();
      if (own !== sequence.current) return;
      if (!usable(listing, admin))
        throw new ApiError(200, "request_failed", REQUEST_FAILED_MESSAGE);
      setList((current) => (current.status === "ready" ? { ...current, listing } : current));
    } catch (error) {
      if (own === sequence.current) setNotice(messageOf(error));
    }
  }, [client, admin]);

  /** 用户发起一次新操作：清掉上一次的页顶提示。 */
  const begin = () => setNotice(null);

  /** 探活一次；失败在页顶提示。不重取（调用方在之后统一重取）。 */
  const probeOnce = async (name: string) => {
    setProbing((current) => toggled(current, name, true));
    try {
      await client.probeConnector(name);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setProbing((current) => toggled(current, name, false));
    }
  };

  /** 写入失败的分流：发布失败（行已写入）在页顶提示并返回 true，调用方照样重取；其它错误交给 `other`、返回 false。 */
  const settleFailure = (error: unknown, other: (message: string) => void): boolean => {
    if (!isPublishFailure(error)) {
      other(messageOf(error));
      return false;
    }
    setNotice(REQUEST_FAILED_MESSAGE);
    return true;
  };

  return {
    list,
    notice,
    defaultsPending,
    enabling,
    probing,
    form,
    remove,

    /** 把 `name` 的 `默认启用` 切到 `enabled`：恰一次 `putConnectorDefaults`；在途时忽略。 */
    async toggleDefault(name: string, enabled: boolean) {
      if (list.status !== "ready" || defaultsPending || defaultsInFlight.current) return;
      defaultsInFlight.current = true;
      begin();
      const previous = list.disabled;
      const next = toggledNames(previous, name, enabled);
      const setDisabled = (disabled: string[]) =>
        setList((current) => (current.status === "ready" ? { ...current, disabled } : current));
      setDisabled(next);
      setDefaultsPending(true);
      try {
        setDisabled(await client.putConnectorDefaults(next));
      } catch (error) {
        setDisabled(previous);
        setNotice(messageOf(error));
      } finally {
        setDefaultsPending(false);
        defaultsInFlight.current = false;
      }
    },

    /** 切换 `启用`：恰一次 `updateConnector`，body 由该行的管理员视图构造（凭证键为 null）；结算后重取。 */
    async toggleEnabled(view: ConnectorView) {
      const { name } = view;
      if (enablingInFlight.current.has(name)) return;
      enablingInFlight.current.add(name);
      begin();
      setEnabling((current) => toggled(current, name, true));
      let refetch = true;
      try {
        await client.updateConnector(name, toUpdateInput(view, { enabled: !view.enabled }));
      } catch (error) {
        refetch = settleFailure(error, setNotice);
      }
      if (refetch) await reload();
      setEnabling((current) => toggled(current, name, false));
      enablingInFlight.current.delete(name);
    },

    openCreate() {
      begin();
      setForm({ opened: null, pending: false, error: null });
    },
    openEdit(view: ConnectorView) {
      begin();
      setForm({ opened: view, pending: false, error: null });
    },
    closeForm() {
      setForm((current) => (current?.pending ? current : null));
    },

    /** 恰调用一次 `createConnector` / `updateConnector`；成功即关闭对话框，随后（满足条件时）探活、再重取。 */
    async submit(values: ConnectorFormValues) {
      if (!form || form.pending) return;
      const { opened } = form;
      setForm({ opened, pending: true, error: null });
      let saved: ConnectorView;
      try {
        saved = opened
          ? await client.updateConnector(opened.name, toUpdateInput(opened, editOverrides(values)))
          : await client.createConnector(toCreateInput(values));
      } catch (error) {
        const published = settleFailure(error, (message) =>
          setForm({ opened, pending: false, error: message }),
        );
        if (published) {
          setForm(null);
          await reload();
        }
        return;
      }
      setForm(null);
      if (probesAfterSave(saved, opened, values)) await probeOnce(saved.name);
      await reload();
    },

    askRemove(connector: ConnectorView) {
      begin();
      setRemove({ connector, pending: false });
    },
    cancelRemove() {
      setRemove((current) => (current?.pending ? current : null));
    },
    /** 恰调用一次 `deleteConnector`。行已删除（成功或发布失败）时先调 `onGone`，调用方据此不再把焦点还给该行。 */
    async confirmRemove(onGone?: () => void) {
      if (!remove || remove.pending) return;
      const { connector } = remove;
      setRemove({ connector, pending: true });
      try {
        await client.deleteConnector(connector.name);
      } catch (error) {
        if (!settleFailure(error, setNotice)) {
          setRemove(null);
          return;
        }
      }
      onGone?.();
      setRemove(null);
      await reload();
    },

    async probe(name: string) {
      if (probing.has(name)) return;
      begin();
      await probeOnce(name);
      await reload();
    },
  };
}
