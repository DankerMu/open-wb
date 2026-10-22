import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError, type ModelView, REQUEST_FAILED_MESSAGE } from "@/lib/api";
import { type ModelFormValues, probesAfterSave, toCreateInput, toUpdateInput } from "./validate.js";

/**
 * 模型 tab 的数据与操作（model-registry「模型 tab」，s1d-model-registry 任务 10.2 / 10.3）。挂载即取一次列表；
 * 每次操作结算后（满足条件时先探活）再取一次列表渲染——页面只按 `listModels` 的结果显示，不拼接写操作的返回值。
 *
 * 错误分流：
 * - 四个写操作（新增、编辑、删除、设缺省）收到非信封的 500（发布失败，行已写入）：关闭对话框、不自动探活、
 *   重取列表，页顶提示 `REQUEST_FAILED_MESSAGE`；
 * - 新增 / 编辑的其它 `ApiError` 留在对话框内显示；删除的显示在该行（缺省行的 409）；设缺省的显示在页顶；
 * - 探活（行按钮或保存后自动）失败显示在页顶，照样重取。
 */

type ListState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; models: ModelView[] };

/** 打开的表单对话框：`opened` 为 null 是新增，否则是编辑该视图（打开那一刻的）。 */
type FormState = { opened: ModelView | null; pending: boolean; error: string | null };
type RemoveState = { model: ModelView; pending: boolean };

/** `api.ts` 对非信封错误的构造：`request_failed` 加原状态码。 */
function isPublishFailure(error: unknown): boolean {
  return error instanceof ApiError && error.status === 500 && error.code === "request_failed";
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

function toggled(set: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export function useModels(client: ApiClient) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [probing, setProbing] = useState<ReadonlySet<string>>(new Set());
  const [defaulting, setDefaulting] = useState<ReadonlySet<string>>(new Set());
  const [form, setForm] = useState<FormState | null>(null);
  const [remove, setRemove] = useState<RemoveState | null>(null);
  const sequence = useRef(0);
  const loaded = useRef(false);

  /**
   * 只采用最后一次发出的列表请求的结果。还没有表时失败即页内错误（不渲染表与 `新增模型`）；已有表时
   * 失败只在页顶提示，表保留。
   */
  const reload = useCallback(async () => {
    const own = ++sequence.current;
    try {
      const models = await client.listModels();
      if (own !== sequence.current) return;
      loaded.current = true;
      setList({ status: "ready", models });
    } catch (error) {
      if (own !== sequence.current) return;
      if (loaded.current) setNotice(messageOf(error));
      else setList({ status: "failed", message: messageOf(error) });
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 用户发起一次新操作：清掉上一次的页顶提示与行内错误。 */
  const begin = () => {
    setNotice(null);
    setRowErrors({});
  };

  /** 探活一次；失败在页顶提示。不重取（调用方在之后统一重取）。 */
  const probeOnce = async (id: string) => {
    setProbing((current) => toggled(current, id, true));
    try {
      await client.probeModel(id);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setProbing((current) => toggled(current, id, false));
    }
  };

  return {
    list,
    notice,
    rowErrors,
    probing,
    defaulting,
    form,
    remove,

    openCreate() {
      begin();
      setForm({ opened: null, pending: false, error: null });
    },
    openEdit(model: ModelView) {
      begin();
      setForm({ opened: model, pending: false, error: null });
    },
    closeForm() {
      setForm((current) => (current?.pending ? current : null));
    },

    /** 恰调用一次 `createModel` / `updateModel`；成功即关闭对话框，随后（满足条件时）探活、再重取。 */
    async submit(values: ModelFormValues) {
      if (!form || form.pending) return;
      const { opened } = form;
      setForm({ opened, pending: true, error: null });
      let saved: ModelView;
      try {
        saved = opened
          ? await client.updateModel(opened.id, toUpdateInput(values))
          : await client.createModel(toCreateInput(values));
      } catch (error) {
        if (!isPublishFailure(error)) {
          setForm({ opened, pending: false, error: messageOf(error) });
          return;
        }
        setForm(null);
        setNotice(REQUEST_FAILED_MESSAGE);
        await reload();
        return;
      }
      setForm(null);
      if (probesAfterSave(saved, opened, values)) await probeOnce(saved.id);
      await reload();
    },

    askRemove(model: ModelView) {
      begin();
      setRemove({ model, pending: false });
    },
    cancelRemove() {
      setRemove((current) => (current?.pending ? current : null));
    },
    /**
     * 恰调用一次 `deleteModel`。行已删除（成功，或发布失败的 500）时先调 `onGone`——调用方据此不再把焦点还给
     * 那一行的按钮（重取可能晚于确认框关闭才结算）；409 等其它错误时行还在，`onGone` 不调。
     */
    async confirmRemove(onGone?: () => void) {
      if (!remove || remove.pending) return;
      const { model } = remove;
      setRemove({ model, pending: true });
      try {
        await client.deleteModel(model.id);
      } catch (error) {
        if (!isPublishFailure(error)) {
          setRemove(null);
          setRowErrors({ [model.id]: messageOf(error) });
          return;
        }
        setNotice(REQUEST_FAILED_MESSAGE);
      }
      onGone?.();
      setRemove(null);
      await reload();
    },

    async setDefault(id: string) {
      if (defaulting.has(id)) return;
      begin();
      setDefaulting((current) => toggled(current, id, true));
      try {
        await client.setDefaultModel(id);
      } catch (error) {
        setDefaulting((current) => toggled(current, id, false));
        if (!isPublishFailure(error)) {
          setNotice(messageOf(error));
          return;
        }
        setNotice(REQUEST_FAILED_MESSAGE);
      }
      setDefaulting((current) => toggled(current, id, false));
      await reload();
    },

    async probe(id: string) {
      if (probing.has(id)) return;
      begin();
      await probeOnce(id);
      await reload();
    },
  };
}
