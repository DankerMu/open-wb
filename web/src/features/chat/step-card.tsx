// 步骤卡（旧实现，原样从 conversation-view.tsx 移出）：新线程骨架把它挂在助手消息的插槽里，
// 工具调用组替换它之前不改。
import { Icon } from "../../ui/index.js";
import { SESSION_STATUS_LABEL } from "./status-label.js";
import { summarizeStepDetail } from "./step-summary.js";
import type { ChatStepView } from "./stream-steps.js";

export function StepCard({ step }: { step: ChatStepView }) {
  const label = SESSION_STATUS_LABEL[step.status];
  const summary = summarizeStepDetail(step.detail);
  const pulse = step.status === "running" ? " ui-pulse" : "";
  return (
    <section aria-label={step.name} className="chat-step">
      <div className="chat-step-head">
        <span className="chat-step-icon">
          <Icon name={step.name === "bash" ? "terminal" : "wrench"} size={14} />
        </span>
        <strong className="chat-step-name">{step.name}</strong>
        <p
          aria-label={`${step.name} ${label}`}
          className={`chat-step-status chat-step-status-${step.status}${pulse}`}
          role="status"
        >
          {label}
        </p>
      </div>
      {summary === "" ? null : <p className="chat-step-line">{summary}</p>}
      {step.detail === "" && step.output === "" ? null : (
        <details className="chat-step-disclosure">
          <summary className="chat-step-summary">原始输出</summary>
          {step.detail === "" ? null : <pre className="chat-step-detail">{step.detail}</pre>}
          {step.output === "" ? null : <pre className="chat-step-output">{step.output}</pre>}
        </details>
      )}
    </section>
  );
}
