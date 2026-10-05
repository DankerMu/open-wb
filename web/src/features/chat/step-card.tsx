// 步骤卡：工具调用组展开后每个步骤一张（design D4）。应用层组件，内容规则不变——卡头图标、步骤名、
// 状态徽章，来自 `detail` 的一行摘要，`原始输出` 折叠里 detail 与 output 两块（原文，不做路径改写）。
import { Icon } from "../../ui/index.js";
import { SESSION_STATUS_LABEL } from "./status-label.js";
import { summarizeStepDetail } from "./step-summary.js";
import type { ChatStepView } from "./stream-steps.js";

const STATUS_TONE: Record<ChatStepView["status"], string> = {
  running: "text-(--wb-brand-primary-deep) animate-pulse motion-reduce:animate-none",
  done: "text-(--wb-status-success-text)",
  failed: "text-(--wb-status-error-text)",
  stopped: "text-(--wb-text-secondary)",
};

const RAW_BLOCK =
  "mt-1.5 mb-0 max-h-48 overflow-auto font-mono text-xs leading-[1.55] wrap-anywhere whitespace-pre-wrap text-(--wb-text-secondary)";

export function StepCard({ step }: { step: ChatStepView }) {
  const label = SESSION_STATUS_LABEL[step.status];
  const summary = summarizeStepDetail(step.detail);
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
        <strong className="min-w-0 truncate text-[13px] font-semibold text-(--wb-text-primary)">
          {step.name}
        </strong>
        <p
          aria-label={`${step.name} ${label}`}
          className={`m-0 ml-auto flex-none font-mono text-[11.5px] leading-4 ${STATUS_TONE[step.status]}`}
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
