import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiClient,
  ApiError,
  type KbSettingsView,
  REQUEST_FAILED_MESSAGE,
  type UpdateKbSettingsInput,
} from "@/lib/api";

/**
 * 模型 tab「知识库模型」段的数据与操作（model-registry「模型 tab」，s2a-kb-ragflow 任务 17.3）。挂载即读一次
 * `GET /api/kb/status`：只看 `enabled`（不看 `available`，ragflow-backend「知识库可用性」），读取失败或在途视为关闭、
 * 整段不渲染；开启才读设置。四个写操作（保存、选对话模型、探活、重试重建）的应答都是设置读视图，直接采用，不再重读。
 *
 * 错误分流：嵌入模型保存的错误留在对话框内；其余显示在段内 `role="alert"`。服务端的 409（`kb_rebuild_required`、
 * `kb_rebuilding`、`kb_chat_model_locked`）是客户端判定的兜底，照样显示信封文案。
 */

export type EmbeddingInput = NonNullable<UpdateKbSettingsInput["embedding"]>;
type Embedding = KbSettingsView["embedding"];

type ViewState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; view: KbSettingsView };

/** 打开的嵌入模型对话框；`confirm` 非 null 即确认框打开，持有待确认的那次保存。 */
type FormState = { pending: boolean; error: string | null; confirm: EmbeddingInput | null };

/** 嵌入身份是 `(name, baseUrl)`，只改密钥不算（ragflow-backend「嵌入模型更换与全量重建」）。 */
function identityChanged(input: EmbeddingInput, current: Embedding): boolean {
  return input.name !== current?.name || input.baseUrl !== current?.baseUrl;
}

/** 保存后是否紧接着探活：首次配置、身份变了或填了密钥（服务端在这三种情形把探活重置为 `never`）。 */
function probesAfterSave(input: EmbeddingInput, previous: Embedding): boolean {
  return previous === null || identityChanged(input, previous) || input.apiKey !== undefined;
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

export function useKbSettings(client: ApiClient) {
  const [state, setState] = useState<ViewState>({ status: "hidden" });
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<"chat" | "probe" | "retry">>(new Set());
  /** 只采用最后一次读取或写入的视图：写入的应答到达后，在途的旧读取作废。 */
  const sequence = useRef(0);

  const adopt = useCallback((view: KbSettingsView) => {
    sequence.current += 1;
    setState({ status: "ready", view });
  }, []);

  const reload = useCallback(async () => {
    const own = ++sequence.current;
    setState({ status: "loading" });
    try {
      const view = await client.getKbSettings();
      if (own === sequence.current) setState({ status: "ready", view });
    } catch {
      // 段内固定显示 `知识库服务暂不可用` 与 `重试`（model-registry「模型 tab」），不显示具体原因。
      if (own === sequence.current) setState({ status: "failed" });
    }
  }, [client]);

  useEffect(() => {
    let live = true;
    client.getKbStatus().then(
      (status) => {
        if (live && status.enabled) void reload();
      },
      () => {
        // 读取失败视为未开启（与中心页 tab 可见性同一口径）：整段不渲染。
      },
    );
    return () => {
      live = false;
    };
  }, [client, reload]);

  const current = state.status === "ready" ? state.view : null;

  /** 一个按钮类操作：在途时同一操作不再发起；失败显示在段内。 */
  const run = async (key: "chat" | "probe" | "retry", work: () => Promise<KbSettingsView>) => {
    if (busy.has(key)) return;
    setNotice(null);
    setBusy((keys) => new Set(keys).add(key));
    try {
      adopt(await work());
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setBusy((keys) => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
    }
  };

  /** 恰一次 `updateKbSettings`；成功即关闭对话框，满足条件时再恰一次探活。 */
  const send = async (input: EmbeddingInput, confirmed: boolean) => {
    const previous = current?.embedding ?? null;
    setForm({ pending: true, error: null, confirm: confirmed ? input : null });
    let view: KbSettingsView;
    try {
      view = await client.updateKbSettings(
        confirmed ? { embedding: input, confirmRebuild: true } : { embedding: input },
      );
    } catch (error) {
      setForm({ pending: false, error: messageOf(error), confirm: null });
      return;
    }
    setForm(null);
    adopt(view);
    if (probesAfterSave(input, previous)) await run("probe", () => client.probeKbEmbedding());
  };

  return {
    state,
    notice,
    form,
    busy,
    reload,

    openForm() {
      setNotice(null);
      setForm({ pending: false, error: null, confirm: null });
    },
    closeForm() {
      setForm((open) => (open?.pending ? open : null));
    },
    /** 改了嵌入身份且已有知识库：先弹确认（不发请求）；否则直接保存。 */
    async save(input: EmbeddingInput) {
      if (!form || form.pending || !current) return;
      if (identityChanged(input, current.embedding) && current.bases > 0) {
        setForm({ pending: false, error: null, confirm: input });
        return;
      }
      await send(input, false);
    },
    async confirmRebuild() {
      if (!form?.confirm || form.pending) return;
      await send(form.confirm, true);
    },
    cancelConfirm() {
      setForm((open) => (open && !open.pending ? { ...open, confirm: null } : open));
    },

    /** 改动即恰一次 `updateKbSettings({chatModelId})`。 */
    setChatModel(chatModelId: string | null) {
      if (!current || chatModelId === current.chatModelId) return;
      void run("chat", () => client.updateKbSettings({ chatModelId }));
    },
    probe() {
      void run("probe", () => client.probeKbEmbedding());
    },
    retryRebuild() {
      void run("retry", () => client.retryKbRebuild());
    },
  };
}
