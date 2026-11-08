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
 *  （s2b-kb-retrieval D8）：只读 `listKnowledgeBases`，视图保持 `ready`，详情不卸载。
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
  /** 在途标记：同一帧里的第二次提交还看不到重渲染，靠它拦下。 */
  const creating = useRef(false);

  const load = useCallback(async () => {
    const own = ++sequence.current;
    refetching.current += 1;
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
  /** 列表该行有变化（`differs` 为真）时才换上 `patch`，否则不改状态。 */
  const patchBase = (id: string, differs: (item: BaseView) => boolean, patch: Partial<BaseView>) =>
    setView((current) =>
      current.status === "ready" && current.bases.some((item) => item.id === id && differs(item))
        ? {
            ...current,
            bases: current.bases.map((item) => (item.id === id ? { ...item, ...patch } : item)),
          }
        : current,
    );

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
      } catch (error) {
        setForm({ pending: false, error: messageOf(error) });
      } finally {
        creating.current = false;
      }
    },

    /** 详情读到或改动文档表后，列表该行的文档数跟上；相同时不改状态。 */
    setDocumentCount(id: string, documents: number) {
      patchBase(id, (item) => item.documents !== documents, { documents });
    },

    /** 检索测试成功后，列表该行的检索参数取应答的 `retrieval`；相同时不改状态。 */
    setRetrieval(id: string, retrieval: BaseView["retrieval"]) {
      patchBase(
        id,
        (item) =>
          item.retrieval.threshold !== retrieval.threshold ||
          item.retrieval.vectorWeight !== retrieval.vectorWeight,
        { retrieval },
      );
    },

    /** 静默重取列表：不回到读取中、不重读状态；成功只换 `bases`，失败不改视图也不写提示。 */
    refetchBases() {
      const own = ++refetching.current;
      client.listKnowledgeBases().then(
        (bases) => {
          if (own === refetching.current) updateBases(() => bases);
        },
        () => {
          // 失败保持现有列表：检索测试的 alert 已告知这次失败。
        },
      );
    },

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
    },
  };
}
