import { type KeyboardEvent, useId } from "react";
import { KbHitList } from "@/components/kb-hit-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ApiClient, BaseView } from "@/lib/api";
import { TextField } from "../models/form-parts.js";
import { ALERT, MUTED } from "./ingest-tree.js";
import { useRetrieval } from "./use-retrieval.js";

const PLACEHOLDER = "例如 销售额口径 / 弹窗 / 工单超时";
const IDLE_TEXT = "输入问题后检索，命中切片会带出所属文档";
const EMPTY_TEXT = "没有命中，换个说法或先把相关文档入库";

type Props = {
  base: BaseView;
  client: ApiClient;
  onRetrieval(retrieval: BaseView["retrieval"]): void;
  onRefetchBases(): void;
};

/**
 * 详情文档表下方的「检索测试」（knowledge-bases「中心「知识库」tab」，s2b-kb-retrieval D8）：问句框、`相似度阈值` 与
 * `向量权重` 两个 0–1 数字框、`检索` 按钮与结果区。调用方只在库 `ready` 时渲染它。只有问句框的 Enter 等同点 `检索`
 *（demo 只给它绑了 Enter），输入法组合中的 Enter 不算。不渲染 demo 面板头的 `召回 → 重排 → 引用` 标签（重排是可选的），
 * 命中不显示来源路径与切片序号（owner 授权偏离 demo）。
 */
export function RetrievalPanel({ base, client, onRetrieval, onRefetchBases }: Props) {
  const state = useRetrieval(client, base, { onRetrieval, onRefetchBases });
  const titleId = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    state.submit();
  };

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2 pt-2">
      <h4 className="m-0 text-sm font-medium" id={titleId}>
        检索测试
      </h4>
      <div className="flex min-w-0 gap-2">
        <Input
          aria-label="检索问句"
          className="min-w-0 flex-1"
          onChange={(event) => state.setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={PLACEHOLDER}
          value={state.question}
        />
        <Button
          aria-busy={state.pending ? true : undefined}
          disabled={!state.canSubmit}
          onClick={state.submit}
          type="button"
        >
          {state.pending ? "正在检索" : "检索"}
        </Button>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:max-w-sm">
        <UnitField
          error={state.errors.threshold}
          label="相似度阈值"
          onChange={state.setThreshold}
          value={state.threshold}
        />
        <UnitField
          error={state.errors.vectorWeight}
          label="向量权重"
          onChange={state.setVectorWeight}
          value={state.vectorWeight}
        />
      </div>
      <Outcome outcome={state.outcome} />
    </section>
  );
}

function UnitField({
  label,
  error,
  value,
  onChange,
}: {
  label: string;
  error: string | undefined;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <TextField error={error} label={label}>
      {(field) => (
        <Input
          {...field}
          inputMode="decimal"
          max={1}
          min={0}
          onChange={(event) => onChange(event.target.value)}
          step={0.01}
          type="number"
          value={value}
        />
      )}
    </TextField>
  );
}

function Outcome({ outcome }: { outcome: ReturnType<typeof useRetrieval>["outcome"] }) {
  switch (outcome.status) {
    case "idle":
      return <p className={MUTED}>{IDLE_TEXT}</p>;
    case "cleared":
      return null;
    case "failed":
      return (
        <p className={`${ALERT} rounded-lg bg-destructive/10 px-2.5 py-2`} role="alert">
          {outcome.message}
        </p>
      );
    case "hits":
      return outcome.hits.length === 0 ? (
        <p className={MUTED}>{EMPTY_TEXT}</p>
      ) : (
        <KbHitList hits={outcome.hits} numbered />
      );
  }
}
