// 审批的两种呈现（design D7）：待决审批是输入框上方停靠区里的提问卡（composer-dock.tsx 叠放），已结算
// 审批是所属助手消息内的记录（message-thread.tsx 按 D4 的块次序挂载）。二者只读归约出的 `approvals`：
// 工具名徽章是 `tool` 字段（不解析 `title`），正文是 `title` 全文、保留换行。
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "../../ui/index.js";
import type { ChatApprovalView } from "./stream-approvals.js";
import { useClipped } from "./use-clipped.js";

type ApprovalAnswer = "allow" | "deny";

/**
 * 作答：resolve 为要在卡内显示的错误文案（此时卡可再次作答），无需提示时为 `null`（已受理、409 已对账、
 * 或结果已不属于当前会话）；从不 reject。
 */
export type AnswerApproval = (
  approvalId: number,
  decision: ApprovalAnswer,
) => Promise<string | null>;

const TITLE_TEXT =
  "m-0 text-[12.5px] leading-[1.6] wrap-anywhere whitespace-pre-wrap text-(--wb-text-secondary)";

function ToolBadge({ id, tool }: { id?: string; tool: string }) {
  return (
    <span
      className="min-w-0 truncate rounded-full border border-(--wb-border-default) bg-(--wb-bg-primary) px-2 py-px font-mono text-[11.5px] leading-4 font-normal text-(--wb-text-secondary)"
      data-slot="approval-tool"
      id={id}
      title={tool}
    >
      {tool}
    </span>
  );
}

/**
 * 一张待决提问卡。`title` 正文有自己的限高并在卡内滚动，倒计时句与按钮在它之外，长 `title` 不会把按钮
 * 挤出停靠区。点击后本卡两个按钮立即禁用；卡头不做乐观改动——`approval.resolved` 或权威快照显示已结算
 * 后停靠区不再渲染它。作答失败的文案以 `role="alert"` 留在卡内，下一次点击时清除。
 *
 * 同意安全：`title` 来自助手一侧。正文被限高裁掉时（`scrollHeight > clientHeight`，随正文变化与元素尺寸
 * 变化重量）卡内多一行可见提示，正文可由键盘聚焦滚动；`Date.now()` 早于 `ignoreClicksUntil` 的点击不作答
 * （卡刚移过位，见 composer-dock.tsx）。
 *
 * 多张卡的名称与按钮名都相同：卡以 `aria-describedby` 依次关联自己的工具徽章与正文，读屏靠这段描述区分。
 * 卡消失后的焦点归停靠区管（design D2）：卡只在作答那一刻上报「焦点在本卡内」（`onAnswerFocused`）——
 * 作答后按钮禁用，浏览器随即把焦点收走，等卡卸载时再看就晚了；停靠区按 `data-approval-id` 认卡，
 * 卡内第一个按钮是 `允许`。
 */
export function ApprovalPromptCard({
  approval,
  ignoreClicksUntil,
  now,
  onAnswer,
  onAnswerFocused,
}: {
  approval: ChatApprovalView;
  /** 这个时刻（注入时钟的毫秒时间）之前的作答点击被忽略：不发请求、不改任何状态。 */
  ignoreClicksUntil: number;
  /** 注入时钟的毫秒时间；停靠区每秒重读一次。 */
  now: number;
  onAnswer: AnswerApproval;
  /** 一次被受理的作答点击发生时焦点在本卡内。 */
  onAnswerFocused(approvalId: number): void;
}) {
  const headerId = useId();
  const toolId = useId();
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const titleRef = useRef<HTMLParagraphElement>(null);
  // 正文变了就重量；元素本身不换。
  const clipped = useClipped(titleRef, [approval.title]);
  const answer = (choice: ApprovalAnswer) => {
    if (Date.now() < ignoreClicksUntil) return;
    if (cardRef.current?.contains(document.activeElement)) onAnswerFocused(approval.id);
    setSent(true);
    setFailure(null);
    void onAnswer(approval.id, choice).then((message) => {
      if (message !== null) {
        setFailure(message);
        setSent(false);
      }
    });
  };
  const seconds = Math.max(0, Math.ceil((approval.expiresAt - now) / 1000));
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset 的禁用语义与默认边框都用不上，这里只要分组。
    <div
      aria-describedby={`${toolId} ${titleId}`}
      aria-labelledby={headerId}
      className="flex min-w-0 flex-none flex-col gap-2 rounded-xl border border-l-[3px] border-(--wb-border-default) border-l-(--wb-status-warning) bg-(--wb-status-warning-soft-bg) px-4 py-3"
      data-approval-id={approval.id}
      data-slot="approval-prompt"
      ref={cardRef}
      role="group"
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-(--wb-status-warning-text)">
        <Icon name="shield" size={14} />
        <span className="flex-none" id={headerId}>
          需要你的确认
        </span>
        <ToolBadge id={toolId} tool={approval.tool} />
      </div>
      <p
        className={`${TITLE_TEXT} max-h-30 overflow-y-auto narrow:max-h-24`}
        data-slot="approval-title"
        id={titleId}
        ref={titleRef}
        tabIndex={clipped ? 0 : undefined}
      >
        {approval.title}
      </p>
      {clipped ? (
        <p
          className="m-0 text-xs font-medium text-(--wb-status-warning-text)"
          data-slot="approval-overflow"
        >
          内容较长，请滚动查看全部
        </p>
      ) : null}
      <p className="m-0 text-[12.5px] text-(--wb-text-secondary)" data-slot="approval-countdown">
        {`（${seconds}s 内未操作将自动允许）`}
      </p>
      {failure === null ? null : (
        <p className="m-0 text-xs text-(--wb-status-error-text)" role="alert">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2.5">
        <Button disabled={sent} onClick={() => answer("allow")} size="sm" type="button">
          允许
        </Button>
        <Button
          disabled={sent}
          onClick={() => answer("deny")}
          size="sm"
          type="button"
          variant="outline"
        >
          拒绝
        </Button>
      </div>
    </div>
  );
}

type Decision = NonNullable<ChatApprovalView["decision"]>;

const RECORD_NAME: Record<Decision, string> = {
  allow: "已允许执行",
  deny: "已拒绝执行",
  timeout: "超时自动允许",
};

const RECORD_TONE: Record<Decision, string> = {
  allow: "text-(--wb-status-success-text)",
  deny: "text-(--wb-status-error-text)",
  timeout: "text-(--wb-status-warning-text)",
};

function ApprovalRecord({
  approval,
  decision,
}: {
  approval: ChatApprovalView;
  decision: Decision;
}) {
  const headerId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: 同提问卡，只要分组。
    <div
      aria-labelledby={headerId}
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-(--wb-border-default) bg-(--wb-bg-secondary) px-3 py-2"
      data-slot="approval-record"
      role="group"
    >
      <div
        className={`flex min-w-0 items-center gap-2 text-[12.5px] font-semibold ${RECORD_TONE[decision]}`}
      >
        <Icon name="shield" size={12} />
        <span className="flex-none" id={headerId}>
          {RECORD_NAME[decision]}
        </span>
        <ToolBadge tool={approval.tool} />
      </div>
      <p className={TITLE_TEXT} data-slot="approval-title">
        {approval.title}
      </p>
    </div>
  );
}

/** 一条助手消息的已结算审批记录，按给定（id 升序）次序各一条；没有已结算审批时不渲染。 */
export function ApprovalRecords({ approvals }: { approvals: readonly ChatApprovalView[] }) {
  const settled = approvals.filter((approval) => approval.decision !== null);
  if (settled.length === 0) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" data-slot="approval-records">
      {settled.map((approval) =>
        approval.decision === null ? null : (
          <ApprovalRecord approval={approval} decision={approval.decision} key={approval.id} />
        ),
      )}
    </div>
  );
}
