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
 * `kb_rebuilding`、`kb_chat_model_locked`）是客户端判定的兜底：照样显示信封文案，并重读一次设置，让确认框、下拉锁定
 * 与重建状态按新的设置显示（`kb_rebuild_required` 且重读后有知识库时改为弹确认框）。
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

type BusyKey = "chat" | "probe" | "retry";
const BUSY_KEYS: readonly BusyKey[] = ["chat", "probe", "retry"];
/** 这几个 409 说明读到的设置已过期（别人建了知识库、开了编译或发起了重建）：显示信封文案之后重读一次。 */
const STALE_CODES = new Set(["kb_rebuild_required", "kb_rebuilding", "kb_chat_model_locked"]);

function isStale(error: unknown): boolean {
  return error instanceof ApiError && STALE_CODES.has(error.code);
}

/**
 * 读到时还没有知识库、保存时已有（409 `kb_rebuild_required`）：重读后仍有知识库就按重读的数目弹确认，确认即带
 * `confirmRebuild:true` 再保存一次；重读失败或仍没有知识库时只显示信封文案。确认过的保存不再回到确认框（调用方判定）。
 */
function asksConfirm(error: unknown, fresh: KbSettingsView | null): boolean {
  return (
    error instanceof ApiError &&
    error.code === "kb_rebuild_required" &&
    fresh !== null &&
    fresh.bases > 0
  );
}

export function useKbSettings(client: ApiClient) {
  const [state, setState] = useState<ViewState>({ status: "hidden" });
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<BusyKey>>(new Set());
  /** 各操作在途的次数：判定读 ref，不读某次渲染的闭包（保存后的自动探活在别的渲染里发起）。 */
  const inFlight = useRef<Record<BusyKey, number>>({ chat: 0, probe: 0, retry: 0 });
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

  /**
   * 重读设置而不经 `loading`（打开的对话框不卸载），返回读到的视图。失败返回 null 并保留当前视图：触发重读的那次
   * 错误已经显示，`重试` 的入口只在首次读取失败时出现。
   */
  const refresh = async (): Promise<KbSettingsView | null> => {
    const own = ++sequence.current;
    try {
      const view = await client.getKbSettings();
      if (own === sequence.current) setState({ status: "ready", view });
      return view;
    } catch {
      return null;
    }
  };

  const track = (key: BusyKey, delta: 1 | -1) => {
    inFlight.current[key] += delta;
    setBusy(new Set(BUSY_KEYS.filter((each) => inFlight.current[each] > 0)));
  };

  /** 发起一次操作并采用应答的视图；失败显示在段内，读到的设置已过期时再重读。 */
  const perform = async (key: BusyKey, work: () => Promise<KbSettingsView>) => {
    setNotice(null);
    track(key, 1);
    try {
      adopt(await work());
    } catch (error) {
      setNotice(messageOf(error));
      if (isStale(error)) await refresh();
    } finally {
      track(key, -1);
    }
  };

  /** 按钮类操作：同一操作在途时不再发起。 */
  const run = (key: BusyKey, work: () => Promise<KbSettingsView>) => {
    if (inFlight.current[key] === 0) void perform(key, work);
  };

  /** 保存被拒：读到的设置已过期时先重读；按重读结果改弹确认框，否则在对话框内显示信封文案。 */
  const saveFailed = async (error: unknown, input: EmbeddingInput, confirmed: boolean) => {
    const fresh = isStale(error) ? await refresh() : null;
    setForm(
      !confirmed && asksConfirm(error, fresh)
        ? { pending: false, error: null, confirm: input }
        : { pending: false, error: messageOf(error), confirm: null },
    );
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
      await saveFailed(error, input, confirmed);
      return;
    }
    setForm(null);
    adopt(view);
    // 不看「探活」按钮是否在途：在途的那次探的是旧身份（服务端丢弃它的结果），新身份要另探一次。
    if (probesAfterSave(input, previous)) await perform("probe", () => client.probeKbEmbedding());
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
      run("chat", () => client.updateKbSettings({ chatModelId }));
    },
    probe() {
      run("probe", () => client.probeKbEmbedding());
    },
    retryRebuild() {
      run("retry", () => client.retryKbRebuild());
    },
  };
}
