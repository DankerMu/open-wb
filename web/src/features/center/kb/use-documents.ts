import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiClient, ApiError, type DocumentView, REQUEST_FAILED_MESSAGE } from "@/lib/api";

/**
 * 知识库详情的数据与行操作（knowledge-bases「中心「知识库」tab」的详情与刷新，s2a-kb-ragflow 任务 16.3，design D12、
 * D19）。一次挂载对应一个知识库（调用方按库 id 设 `key`），挂载时读一次 `listKbDocuments` 与 `listWorkspaces`：
 *
 * - **刷新**：最近一次列表里有 `queued` / `parsing` 且页面可见时，3 秒后重取一次，每次应答后重新计时；页面隐藏时
 *   停，恢复可见后重新计时 3 秒。`unparsed` 不触发。重取失败即 `failed`，刷新随之停止。
 * - **重新入库**：恰调用一次 `reingestKbDocument`，成功后重取一次列表（写端点返回的 `queued` 由此进入刷新）。
 *   入库与上传（16.5）成功后由详情调 `refetch`，同样重取一次。
 * - **移出**：恰调用一次 `removeKbDocument`，成功即从表里去掉该行，不重取。
 * - 两者失败（含 409 `kb_document_busy`）都在该行内显示信封文案，行不变；行内错误跨刷新保留，该行下一次操作时清掉。
 * - 只采用最后一次读取的结果：卸载与每次读取都递增序号，丢弃在途的旧应答；移出之前发出、之后到达的应答里去掉
 *   已移出的行。
 * - 工作空间表：来源列取其中的名字，读取失败或不在列表里时只显示路径；`从工作空间入库` 用它选空间，读取失败时
 *   对话框显示信封文案与 `重试`（`retryWorkspaces`），不在详情里报错。
 */

const REFRESH_MS = 3_000;
const REFRESHING: ReadonlySet<DocumentView["status"]> = new Set(["queued", "parsing"]);

/** 当前用户的工作空间：读取中、读取失败（信封文案）或已读到。 */
export type WorkspacesView =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; workspaces: readonly { id: string; name: string }[] };

type DocumentsView =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; documents: DocumentView[] };

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export function useKbDocuments(
  client: ApiClient,
  baseId: string,
  /** 每次得到文档表（读取或移出后）报告文档数，供列表的「文档」列跟上。 */
  onCount: (count: number) => void,
) {
  const [view, setView] = useState<DocumentsView>({ status: "loading" });
  const [workspaces, setWorkspaces] = useState<WorkspacesView>({ status: "loading" });
  const spacesSequence = useRef(0);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const sequence = useRef(0);
  /** 在途标记：同一帧里的第二次点击还看不到 `pending` 的重渲染，靠它拦下。 */
  const inflight = useRef(new Set<string>());
  const removed = useRef(new Set<string>());
  const countRef = useRef(onCount);
  countRef.current = onCount;

  /** `quiet` 的读取（刷新与重新入库后的重取）不回到读取中，表保留到应答到达。 */
  const load = useCallback(
    async (quiet: boolean) => {
      const own = ++sequence.current;
      if (!quiet) setView({ status: "loading" });
      try {
        const listed = await client.listKbDocuments(baseId);
        const documents = listed.filter((item) => !removed.current.has(item.id));
        if (own === sequence.current) setView({ status: "ready", documents });
      } catch (error) {
        if (own === sequence.current) setView({ status: "failed", message: messageOf(error) });
      }
    },
    [client, baseId],
  );

  useEffect(() => {
    void load(false);
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  const readWorkspaces = useCallback(() => {
    const own = ++spacesSequence.current;
    setWorkspaces({ status: "loading" });
    client.listWorkspaces().then(
      ({ workspaces: listed }) => {
        const ready = listed.map(({ id, name }) => ({ id, name }));
        if (own === spacesSequence.current) setWorkspaces({ status: "ready", workspaces: ready });
      },
      (error: unknown) => {
        if (own === spacesSequence.current) {
          setWorkspaces({ status: "failed", message: messageOf(error) });
        }
      },
    );
  }, [client]);

  useEffect(() => {
    readWorkspaces();
    return () => {
      spacesSequence.current += 1;
    };
  }, [readWorkspaces]);

  const spaces = useMemo<ReadonlyMap<string, string>>(
    () =>
      new Map(
        workspaces.status === "ready"
          ? workspaces.workspaces.map(({ id, name }) => [id, name])
          : [],
      ),
    [workspaces],
  );

  useEffect(() => {
    if (view.status === "ready") countRef.current(view.documents.length);
  }, [view]);

  const refreshing =
    view.status === "ready" && view.documents.some((item) => REFRESHING.has(item.status));

  // 依赖 `view`：每次应答（新的 view）都重新计时。
  useEffect(() => {
    if (!refreshing || view.status !== "ready") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer =
        document.visibilityState === "visible"
          ? setTimeout(() => void load(true), REFRESH_MS)
          : undefined;
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [refreshing, view, load]);

  /** 一次行操作：在途时忽略；开始时清掉该行的错误，失败时写回。返回是否成功。 */
  const rowAction = async (id: string, run: () => Promise<void>): Promise<boolean> => {
    if (inflight.current.has(id)) return false;
    inflight.current.add(id);
    setPending((current) => toggled(current, id, true));
    setRowErrors(({ [id]: _, ...rest }) => rest);
    try {
      await run();
      return true;
    } catch (error) {
      setRowErrors((current) => ({ ...current, [id]: messageOf(error) }));
      return false;
    } finally {
      inflight.current.delete(id);
      setPending((current) => toggled(current, id, false));
    }
  };

  return {
    view,
    spaces,
    /** `从工作空间入库` 的空间表：读取中、失败（信封文案）或已读到。 */
    workspaces,
    /** 空间表读取失败时的 `重试`。 */
    retryWorkspaces: readWorkspaces,
    rowErrors,
    pending,

    /** `重试`：重取文档列表。 */
    reload() {
      void load(false);
    },

    /** 入库与上传成功后重取一次，表保留到应答到达；返回的 `queued` 由此进入刷新。 */
    refetch() {
      void load(true);
    },

    async reingest(id: string) {
      if (await rowAction(id, () => client.reingestKbDocument(baseId, id).then(() => undefined))) {
        await load(true);
      }
    },

    /** 成功返回 true：该行已不在表里。 */
    async remove(id: string): Promise<boolean> {
      const done = await rowAction(id, () => client.removeKbDocument(baseId, id));
      if (!done) return false;
      removed.current.add(id);
      setView((current) =>
        current.status === "ready"
          ? { ...current, documents: current.documents.filter((item) => item.id !== id) }
          : current,
      );
      return true;
    },
  };
}
