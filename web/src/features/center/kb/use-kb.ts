import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiClient,
  ApiError,
  type BaseView,
  type CreateKnowledgeBaseInput,
  type KbStatus,
  REQUEST_FAILED_MESSAGE,
} from "@/lib/api";

/**
 * 「知识库」tab 的数据与操作（knowledge-bases「中心「知识库」tab」，s2a-kb-ragflow 任务 15.3）。挂载与 `重试` 都先读
 * `getKbStatus`，开启且可用时再读 `listKnowledgeBases`：
 *
 * - 状态为 `available:false`、读取失败或（与 tab 显隐不一致的）`enabled:false`：`unavailable`，面板只显示不可用提示
 *   与 `重试`，不读列表。
 * - 列表读取失败：`failed`，显示信封文案与 `重试`。
 * - 建库恰调用一次 `createKnowledgeBase`，成功以 201 的视图追加到列表末尾（列表按 `created_at` 升序），失败留在
 *   对话框内；删库确认后恰调用一次 `deleteKnowledgeBase`，成功即从列表去掉该行，失败在页顶提示。都不重取列表：
 *   列表的编译状态要读 RAGFlow，201 的视图本身就是权威的（服务端不为它读 RAGFlow）。
 * - 详情的检索测试成功后经 `setRetrieval` 改该行的检索参数；失败且参数有变时经 `refetchBases` 静默重取列表
 *  （s2b-kb-retrieval D8）：只读 `listKnowledgeBases`，视图保持 `ready`，详情不卸载。静默重取整表覆盖 `bases`，
 *   它的应答可能读于之后的本地改动之前，所以本地改动列表（`setRetrieval`（检索成功）、`setDocumentCount`、新建成功、
 *   删除成功）时若有在途重取，就再发一次，旧应答按序号丢弃。检索成功不论行值是否变化都作废：成功意味着服务端有一次
 *   晚于在途读取的写入。文档数只在真的变了时作废：详情每次读文档（含 3 秒刷新）都会报一次文档数，不变也作废会让
 *   比刷新间隔慢的重取永远落不了地。
 */

type EnabledStatus = Extract<KbStatus, { enabled: true }>;

type ViewState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "failed"; message: string }
  | { status: "ready"; kb: EnabledStatus; bases: BaseView[] };

type FormState = { pending: boolean; error: string | null };
type RemoveState = { base: BaseView; pending: boolean };

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

/** 一次读取：先读状态，开启且可用时再读列表。读状态之后已不是最新一次读取（`latest` 为假）时不再读列表，返回 null。 */
async function readView(client: ApiClient, latest: () => boolean): Promise<ViewState | null> {
  let kb: KbStatus;
  try {
    kb = await client.getKbStatus();
  } catch {
    return { status: "unavailable" };
  }
  if (!latest()) return null;
  if (!kb.enabled || !kb.available) return { status: "unavailable" };
  try {
    return { status: "ready", kb, bases: await client.listKnowledgeBases() };
  } catch (error) {
    return { status: "failed", message: messageOf(error) };
  }
}

export function useKnowledgeBases(client: ApiClient) {
  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [remove, setRemove] = useState<RemoveState | null>(null);
  /** 只采用最后一次读取的结果；卸载时递增，丢弃在途的应答。 */
  const sequence = useRef(0);
  /** 静默重取的序号：只采用最后一次重取；整表读取开始与卸载时也递增，丢弃在途的重取。 */
  const refetching = useRef(0);
  /** 最后一次静默重取还没落地。 */
  const refetchPending = useRef(false);
  /** 最近一次渲染的视图：文档数据此判断是否真的改了行。 */
  const viewRef = useRef(view);
  viewRef.current = view;
  /** 在途标记：同一帧里的第二次提交还看不到重渲染，靠它拦下。 */
  const creating = useRef(false);

  const load = useCallback(async () => {
    const own = ++sequence.current;
    refetching.current += 1;
    refetchPending.current = false;
    const latest = () => own === sequence.current;
    setView({ status: "loading" });
    const next = await readView(client, latest);
    if (next && latest()) setView(next);
  }, [client]);

  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
      refetching.current += 1;
    };
  }, [load]);

  const updateBases = (next: (bases: BaseView[]) => BaseView[]) =>
    setView((current) =>
      current.status === "ready" ? { ...current, bases: next(current.bases) } : current,
    );
  const rowDiffers = (current: ViewState, id: string, differs: (item: BaseView) => boolean) =>
    current.status === "ready" && current.bases.some((item) => item.id === id && differs(item));
  /** 列表该行有变化（`differs` 为真）时才换上 `patch`，否则不改状态。 */
  const patchBase = (id: string, differs: (item: BaseView) => boolean, patch: Partial<BaseView>) =>
    setView((current) =>
      current.status === "ready" && rowDiffers(current, id, differs)
        ? {
            ...current,
            bases: current.bases.map((item) => (item.id === id ? { ...item, ...patch } : item)),
          }
        : current,
    );

  /** 静默重取列表：不回到读取中、不重读状态；成功只换 `bases`，失败不改视图也不写提示。 */
  const refetchBases = () => {
    const own = ++refetching.current;
    refetchPending.current = true;
    const settle = (apply: () => void) => {
      if (own !== refetching.current) return;
      refetchPending.current = false;
      apply();
    };
    client.listKnowledgeBases().then(
      (bases) => settle(() => updateBases(() => bases)),
      // 失败保持现有列表：检索测试的 alert 已告知这次失败。
      () => settle(() => undefined),
    );
  };
  /** 本地改了列表：在途的静默重取可能读于这次改动之前，再发一次，旧应答按序号丢弃。 */
  const invalidateRefetch = () => {
    if (refetchPending.current) refetchBases();
  };

  return {
    view,
    notice,
    form,
    remove,

    /** `重试`：重取状态与列表。 */
    reload() {
      setNotice(null);
      void load();
    },

    openCreate() {
      setNotice(null);
      setForm({ pending: false, error: null });
    },
    closeForm() {
      setForm((current) => (current?.pending ? current : null));
    },
    /** 恰调用一次 `createKnowledgeBase`；在途时忽略。 */
    async submit(input: CreateKnowledgeBaseInput) {
      if (!form || form.pending || creating.current) return;
      creating.current = true;
      setForm({ pending: true, error: null });
      try {
        const created = await client.createKnowledgeBase(input);
        setForm(null);
        updateBases((bases) => [...bases, created]);
        invalidateRefetch();
      } catch (error) {
        setForm({ pending: false, error: messageOf(error) });
      } finally {
        creating.current = false;
      }
    },

    /** 详情读到或改动文档表后，列表该行的文档数跟上；相同时不改状态，变了才作废在途的静默重取。 */
    setDocumentCount(id: string, documents: number) {
      const differs = (item: BaseView) => item.documents !== documents;
      const changes = rowDiffers(viewRef.current, id, differs);
      patchBase(id, differs, { documents });
      if (changes) invalidateRefetch();
    },

    /** 检索测试成功后，列表该行的检索参数取应答的 `retrieval`（相同时不改状态），并作废在途的静默重取。 */
    setRetrieval(id: string, retrieval: BaseView["retrieval"]) {
      patchBase(
        id,
        (item) =>
          item.retrieval.threshold !== retrieval.threshold ||
          item.retrieval.vectorWeight !== retrieval.vectorWeight,
        { retrieval },
      );
      invalidateRefetch();
    },

    refetchBases,

    askRemove(base: BaseView) {
      setNotice(null);
      setRemove({ base, pending: false });
    },
    cancelRemove() {
      setRemove((current) => (current?.pending ? current : null));
    },
    /** 恰调用一次 `deleteKnowledgeBase`。行已删除时先调 `onGone`，调用方据此不再把焦点还给该行。 */
    async confirmRemove(onGone?: () => void) {
      if (!remove || remove.pending) return;
      const { base } = remove;
      setRemove({ base, pending: true });
      try {
        await client.deleteKnowledgeBase(base.id);
      } catch (error) {
        setRemove(null);
        setNotice(messageOf(error));
        return;
      }
      onGone?.();
      setRemove(null);
      updateBases((bases) => bases.filter((item) => item.id !== base.id));
      invalidateRefetch();
    },
  };
}
