// 会话「知识库检索」卡（chat-web「会话知识库检索卡」，change s2c-kb-session D10、G11、G12）：一条消息的检索块
// （message-segments.ts 的 `kind:"kb"`，即全部 `kb_search` 步骤）渲染为一张卡。行为在这里定：
// - 卡头：图标、标题接 ` · ` 与 `ok` 的库名（去重、首次出现次序；单行省略，`title` 给全文）、`（n 轮）`、
//   状态（任一 running → `检索中`；否则全部 failed → `检索失败`；其余 `检索完成`，`stopped` 不算失败）。
// - 每个步骤一行：`第 k 轮`、意图（`kbHits.intent`，否则 detail 的 `question`，都没有为空）、有 `kbHits` 时
//   `命中 m 条`、确认标记（step-card.tsx 的同一张表，配对规则同工具段）、行状态。卡收起与否标记都可见。
// - 只有带 `kbHits` 的行是展开按钮（快照恢复的行 `kbHits` 为 null，不可展开，行内无 button）；展开态按步骤 id
//   存在本组件里，React key 是块键，所以流式增长与快照原地重装都不丢展开态。首次出现时全部收起。
// - 展开内容按 `bases` 次序逐库：标签 `name ?? kbId`，非 `ok` 给一句说明，`ok` 用共享命中列表（纯文本切片）。
//   卡自身只用 `--wb-*` 颜色；窄视口下意图与库标签换行（`min-w-0` + `wrap-anywhere`），卡内不横向溢出。
import { useState } from "react";
import { Icon } from "../../components/icon.js";
import { KbHitList } from "../../components/kb-hit-list.js";
import { SESSION_STATUS_LABEL } from "./status-label.js";
import { MARK, STATUS_TONE } from "./step-card.js";
import type { ChatApprovalView } from "./stream-approvals.js";
import type { ChatKbHits } from "./stream-kb-hits.js";
import type { ChatStepView } from "./stream-steps.js";

type KbBase = ChatKbHits["bases"][number];
type Decision = ChatApprovalView["decision"];

const BASE_NOTE: Record<Exclude<KbBase["status"], "ok">, string> = {
  not_found: "未找到该知识库",
  not_ready: "正在重建，本轮未检索",
  failed: "检索失败",
};

const MUTED = "flex-none text-xs text-(--wb-text-secondary)";
const BADGE = "flex-none text-[11.5px] leading-4";
const LINE = "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5";

/** 各轮 `ok` 库的名字，按首次出现去重。 */
function okNames(steps: readonly ChatStepView[]): string[] {
  const bases = steps.flatMap((step) => step.kbHits?.bases ?? []);
  return [
    ...new Set(bases.flatMap((base) => (base.status === "ok" && base.name ? [base.name] : []))),
  ];
}

function cardStatus(steps: readonly ChatStepView[]): string {
  if (steps.some((step) => step.status === "running")) return "检索中";
  return steps.every((step) => step.status === "failed") ? "检索失败" : "检索完成";
}

/** `kbHits.intent` 非空用它；否则 detail 为 JSON 对象且 `question` 为字符串时用它；都不成立为空，解析失败不抛。 */
function intentOf(step: ChatStepView): string {
  if (step.kbHits?.intent) return step.kbHits.intent;
  try {
    // 非对象、数组与缺键都解构出 undefined；`null` 解构时抛错，同解析失败一样落到 catch。
    const { question } = JSON.parse(step.detail) as { question?: unknown };
    return typeof question === "string" ? question : "";
  } catch {
    return "";
  }
}

export function KbSearchCard({
  approvals,
  steps,
}: {
  /** 所属消息的全部审批；只用来找配上各步骤的那一条。 */
  approvals: readonly ChatApprovalView[];
  steps: readonly ChatStepView[];
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const names = okNames(steps).join("、");
  const title = names === "" ? "知识库检索" : `知识库检索 · ${names}`;
  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <section
      aria-label="知识库检索"
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-(--wb-border-default) bg-(--wb-bg-secondary)"
      data-slot="kb-search-card"
    >
      <div className="flex min-w-0 items-center gap-2 bg-(--wb-bg-hover-light) px-3 py-2">
        <span className="inline-flex flex-none text-(--wb-icon-muted)">
          <Icon name="search" size={14} />
        </span>
        <strong
          className="min-w-0 truncate text-[13px] font-semibold text-(--wb-text-primary)"
          data-slot="kb-search-title"
          title={title}
        >
          {title}
        </strong>
        <span className={MUTED} data-slot="kb-search-rounds">{`（${steps.length} 轮）`}</span>
        <span className={`ml-auto ${MUTED}`} data-slot="kb-search-status">
          {cardStatus(steps)}
        </span>
      </div>
      {/* biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。 */}
      <ol className="m-0 flex list-none flex-col p-0" role="list">
        {steps.map((step, index) => (
          <Row
            decision={approvals.find((approval) => approval.stepId === step.id)?.decision ?? null}
            key={step.id}
            onToggle={() => toggle(step.id)}
            open={open.has(step.id)}
            round={index + 1}
            step={step}
          />
        ))}
      </ol>
    </section>
  );
}

type RowProps = {
  decision: Decision;
  onToggle(): void;
  open: boolean;
  round: number;
  step: ChatStepView;
};

function Row({ decision, onToggle, open, round, step }: RowProps) {
  const hits = step.kbHits;
  const line = <RowLine decision={decision} round={round} step={step} />;
  return (
    <li className="min-w-0 border-t border-(--wb-border-default)" data-slot="kb-search-row">
      {hits === null ? (
        <div className={LINE}>{line}</div>
      ) : (
        <button
          aria-expanded={open}
          className={`${LINE} w-full cursor-pointer text-left hover:bg-(--wb-bg-hover-light) focus-visible:-outline-offset-2`}
          onClick={onToggle}
          type="button"
        >
          {line}
        </button>
      )}
      {open && hits !== null ? <RowDetail hits={hits} /> : null}
    </li>
  );
}

function RowLine({ decision, round, step }: Omit<RowProps, "onToggle" | "open">) {
  const hits = step.kbHits;
  const mark = decision === null ? null : MARK[decision];
  const count = hits?.bases.reduce((sum, base) => sum + base.hits.length, 0) ?? 0;
  return (
    <>
      <span className={MUTED} data-slot="kb-search-round">{`第 ${round} 轮`}</span>
      <span
        className="min-w-0 flex-[1_1_8rem] text-[13px] wrap-anywhere text-(--wb-text-primary)"
        data-slot="kb-search-intent"
      >
        {intentOf(step)}
      </span>
      {hits === null ? null : (
        <span className={MUTED} data-slot="kb-search-count">{`命中 ${count} 条`}</span>
      )}
      {mark === null ? null : (
        <span className={`${BADGE} ${mark.tone}`} data-slot="kb-search-mark">
          {mark.text}
        </span>
      )}
      <span
        className={`${BADGE} font-mono ${STATUS_TONE[step.status]}`}
        data-slot="kb-search-row-status"
        data-status={step.status}
      >
        {SESSION_STATUS_LABEL[step.status]}
      </span>
    </>
  );
}

function RowDetail({ hits }: { hits: ChatKbHits }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 px-3 pt-1 pb-2" data-slot="kb-search-detail">
      {hits.bases.map((base) => (
        <div className="flex min-w-0 flex-col gap-1" data-slot="kb-search-base" key={base.kbId}>
          <p
            className="m-0 min-w-0 text-xs font-medium wrap-anywhere text-(--wb-text-secondary)"
            data-slot="kb-search-base-name"
          >
            {base.name ?? base.kbId}
          </p>
          {base.status === "ok" ? (
            <KbHitList hits={base.hits} numbered={false} />
          ) : (
            <p className="m-0 text-xs text-(--wb-text-tertiary)" data-slot="kb-search-base-note">
              {BASE_NOTE[base.status]}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
