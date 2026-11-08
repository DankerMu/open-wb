import { useEffect, useRef, useState } from "react";
import type { ApiClient, BaseView, RetrievalHit } from "@/lib/api";
import { messageOf } from "./ingest-tree.js";

/**
 * 检索测试的状态（knowledge-bases「中心「知识库」tab」的检索测试，s2b-kb-retrieval D8）。问句与两个数字都存原始字符串，
 * 挂载时从 `base.retrieval` 初始化一次；之后 `base` 变化不覆盖输入（换库由详情的 `key` 重新挂载）。
 *
 * - 「面板初值」只有成功应答的 `retrieval` 能替换；「参数有变」在提交时取发出的两个数值，与它、以及列表里该库
 *   当前的 `retrieval`（`base` prop，静默重取会改它）各做数值比较，任一不同即为有变。
 * - 成功：两个数字改写为应答值（问句保留），并经 `onRetrieval` 同步列表；失败：清掉命中只显示信封文案，
 *   参数有变时经 `onRefetchBases` 静默重取列表（写回可能已成功）。
 * - 请求不 abort：卸载后或有更新的提交时丢弃面板本地的状态更新，但两个回调照常调用，它们按库 id 更新父组件的列表。
 */

const RANGE_REASON = "填 0 到 1 之间的数字";

type Retrieval = BaseView["retrieval"];

const differs = (a: Retrieval, b: Retrieval) =>
  a.threshold !== b.threshold || a.vectorWeight !== b.vectorWeight;

/** `idle` 还没检索；`cleared` 上次失败后再次提交，alert 已清掉。 */
type Outcome =
  | { status: "idle" }
  | { status: "cleared" }
  | { status: "hits"; hits: RetrievalHit[] }
  | { status: "failed"; message: string };

/** 去空白后非空、是有限数且在 0 与 1 之间（含两端）的数值；否则 null。只看字符串，不读输入框的 `validity`。 */
function unitValue(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

type Callbacks = { onRetrieval(retrieval: Retrieval): void; onRefetchBases(): void };

export function useRetrieval(client: ApiClient, base: BaseView, callbacks: Callbacks) {
  const [question, setQuestion] = useState("");
  const [threshold, setThreshold] = useState(() => String(base.retrieval.threshold));
  const [vectorWeight, setVectorWeight] = useState(() => String(base.retrieval.vectorWeight));
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ status: "idle" });
  const baseline = useRef(base.retrieval);
  /** 只有最后一次提交、且面板仍挂载时才改面板本地的状态。 */
  const sequence = useRef(0);
  /** 在途标记：同一帧里的第二次提交还看不到重渲染，靠它拦下。 */
  const inflight = useRef(false);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );

  const sent = { threshold: unitValue(threshold), vectorWeight: unitValue(vectorWeight) };
  const ready = question.trim() !== "" && sent.threshold !== null && sent.vectorWeight !== null;

  const settle = (own: number, apply: () => void) => {
    inflight.current = false;
    if (own !== sequence.current) return;
    setPending(false);
    apply();
  };

  /** 按钮与问句框的 Enter 共用：无效或在途时不发请求。 */
  const submit = () => {
    const t = sent.threshold;
    const w = sent.vectorWeight;
    if (!ready || inflight.current || t === null || w === null) return;
    inflight.current = true;
    const own = ++sequence.current;
    const sentValues = { threshold: t, vectorWeight: w };
    const changed = differs(sentValues, baseline.current) || differs(sentValues, base.retrieval);
    const { onRetrieval, onRefetchBases } = callbacksRef.current;
    setPending(true);
    setOutcome((current) => (current.status === "failed" ? { status: "cleared" } : current));
    client.retrieveFromKnowledgeBase(base.id, { question, threshold: t, vectorWeight: w }).then(
      (result) => {
        onRetrieval(result.retrieval);
        settle(own, () => {
          baseline.current = result.retrieval;
          setThreshold(String(result.retrieval.threshold));
          setVectorWeight(String(result.retrieval.vectorWeight));
          setOutcome({ status: "hits", hits: result.hits });
        });
      },
      (error: unknown) => {
        if (changed) onRefetchBases();
        settle(own, () => setOutcome({ status: "failed", message: messageOf(error) }));
      },
    );
  };

  return {
    question,
    threshold,
    vectorWeight,
    setQuestion,
    setThreshold,
    setVectorWeight,
    /** 两个数字字段各自的原因；问句空白只禁用按钮、不显示原因。 */
    errors: {
      threshold: sent.threshold === null ? RANGE_REASON : undefined,
      vectorWeight: sent.vectorWeight === null ? RANGE_REASON : undefined,
    },
    canSubmit: ready && !pending,
    pending,
    outcome,
    submit,
  };
}
