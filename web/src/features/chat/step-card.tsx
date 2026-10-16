// 步骤卡：工具调用组展开后每个步骤一张（design D4）。应用层组件，内容规则不变——卡头图标、步骤名、
// 状态徽章，来自 `detail` 的一行摘要，`原始输出` 折叠里 detail 与 output 两块（原文，不做路径改写）。
// 唯一的增加是确认小标记（chat-web「步骤卡的确认标记」，change chat-interleaved-segments D12）：配上本步骤的
// 审批 `timeout` 标 `超时自动允许`、`deny`（含停止、崩溃、对账结算出的）标 `已拒绝`，`allow` 与未作答不标；
// 纯文本、在状态徽章之前、不进徽章（徽章的可访问名由 `aria-label` 给出，文本也只有状态字样）。
import { Icon } from "../../components/icon.js";
import { SESSION_STATUS_LABEL } from "./status-label.js";
import { summarizeStepDetail } from "./step-summary.js";
import type { ChatApprovalView } from "./stream-approvals.js";
import type { ChatStepView } from "./stream-steps.js";

type Decision = ChatApprovalView["decision"];

const MARK: Record<NonNullable<Decision>, { text: string; tone: string } | null> = {
  allow: null,
  deny: { text: "已拒绝", tone: "text-(--wb-status-error-text)" },
  timeout: { text: "超时自动允许", tone: "text-(--wb-status-warning-text)" },
};

const STATUS_TONE: Record<ChatStepView["status"], string> = {
  running: "text-(--wb-brand-primary-deep) animate-pulse motion-reduce:animate-none",
  done: "text-(--wb-status-success-text)",
  failed: "text-(--wb-status-error-text)",
  stopped: "text-(--wb-text-secondary)",
};

const RAW_BLOCK =
  "mt-1.5 mb-0 max-h-48 overflow-auto font-mono text-xs leading-[1.55] wrap-anywhere whitespace-pre-wrap text-(--wb-text-secondary)";

/** `decision` 是配上本步骤的审批的结算结果；没有配上或尚未作答为 null。 */
export function StepCard({ decision, step }: { decision: Decision; step: ChatStepView }) {
  const label = SESSION_STATUS_LABEL[step.status];
  const summary = summarizeStepDetail(step.detail);
  const mark = decision === null ? null : MARK[decision];
  return (
    <section
      aria-label={step.name}
      className="flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-lg border border-(--wb-border-default) bg-(--wb-bg-secondary)"
      data-slot="step-card"
    >
      <div className="flex items-center gap-2 bg-(--wb-bg-hover-light) px-3 py-2">
        <span className="inline-flex flex-none text-(--wb-icon-muted)">
          <Icon name={step.name === "bash" ? "terminal" : "wrench"} size={14} />
        </span>
        <strong className="mr-auto min-w-0 truncate text-[13px] font-semibold text-(--wb-text-primary)">
          {step.name}
        </strong>
        {mark === null ? null : (
          <span
            className={`flex-none text-[11.5px] leading-4 ${mark.tone}`}
            data-slot="step-approval-mark"
          >
            {mark.text}
          </span>
        )}
        <p
          aria-label={`${step.name} ${label}`}
          className={`m-0 flex-none font-mono text-[11.5px] leading-4 ${STATUS_TONE[step.status]}`}
          data-status={step.status}
          role="status"
        >
          {label}
        </p>
      </div>
      {summary === "" ? null : (
        <p
          className="m-0 truncate px-3 text-[12.5px] text-(--wb-text-secondary) last:pb-2"
          data-slot="step-summary"
        >
          {summary}
        </p>
      )}
      {step.detail === "" && step.output === "" ? null : (
        <details className="min-w-0 px-3 pb-2">
          <summary className="cursor-pointer text-xs text-(--wb-text-secondary)">原始输出</summary>
          {step.detail === "" ? null : (
            <pre className={RAW_BLOCK} data-slot="step-detail">
              {step.detail}
            </pre>
          )}
          {step.output === "" ? null : (
            <pre className={RAW_BLOCK} data-slot="step-output">
              {step.output}
            </pre>
          )}
        </details>
      )}
    </section>
  );
}
