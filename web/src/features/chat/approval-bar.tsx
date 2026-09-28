// Approval bars adapted from resource/workbuddy-live-demo.html:2407-2418 (approvalHTMLFor); the demo
// progress bar and bare seconds are not rendered: one countdown sentence derived from `expiresAt`.
import { useEffect, useId, useState } from "react";
import { Button, Icon, Tag } from "../../ui/index.js";
import type { ChatApprovalView } from "./stream-approvals.js";

type ApprovalAnswer = "allow" | "deny";

type ApprovalBarsProps = {
  approvals: ChatApprovalView[];
  /** Resolves `true` when the answer failed and the bar may be answered again; never rejects. */
  onAnswer(approvalId: number, decision: ApprovalAnswer): Promise<boolean>;
};

const SETTLED_HEADER = {
  allow: "已允许执行",
  timeout: "已允许执行",
  deny: "已拒绝执行",
} as const;

const SETTLED_TONE = { allow: "allow", timeout: "allow", deny: "deny" } as const;

function ApprovalBar({
  approval,
  now,
  onAnswer,
}: {
  approval: ChatApprovalView;
  now: number;
  onAnswer: ApprovalBarsProps["onAnswer"];
}) {
  const headerId = useId();
  // Only the request in flight disables the bar; the header waits for approval.resolved or a snapshot.
  const [sent, setSent] = useState(false);
  const { decision } = approval;
  const answer = (choice: ApprovalAnswer) => {
    setSent(true);
    void onAnswer(approval.id, choice).then((retry) => {
      if (retry) {
        setSent(false);
      }
    });
  };
  const tone = decision === null ? "" : ` chat-approval--${SETTLED_TONE[decision]}`;
  const seconds = Math.max(0, Math.ceil((approval.expiresAt - now) / 1000));
  return (
    <fieldset aria-labelledby={headerId} className={`chat-approval${tone}`}>
      <div className="chat-approval-head">
        <Icon name="shield" size={14} />
        <span id={headerId}>{decision === null ? "需要你的确认" : SETTLED_HEADER[decision]}</span>
        <Tag className="chat-approval-tool">{approval.tool}</Tag>
      </div>
      <p className="chat-approval-body">{approval.title}</p>
      {decision === null ? (
        <>
          <p className="chat-approval-countdown">{`（${seconds}s 内未操作将自动允许）`}</p>
          <div className="chat-approval-ops">
            <Button disabled={sent} onClick={() => answer("allow")} size="sm" variant="primary">
              允许
            </Button>
            <Button disabled={sent} onClick={() => answer("deny")} size="sm" variant="secondary">
              拒绝
            </Button>
          </div>
        </>
      ) : null}
    </fieldset>
  );
}

/**
 * One bar per approval of an assistant message, in the given (ascending id) order. A list holding
 * any pending approval runs a single one-second tick; `now` is read at render time.
 */
export function ApprovalBars({ approvals, onAnswer }: ApprovalBarsProps) {
  const hasPending = approvals.some((approval) => approval.decision === null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasPending) {
      return;
    }
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [hasPending]);
  if (approvals.length === 0) {
    return null;
  }
  const now = Date.now();
  return (
    <div className="chat-approvals">
      {approvals.map((approval) => (
        <ApprovalBar approval={approval} key={approval.id} now={now} onAnswer={onAnswer} />
      ))}
    </div>
  );
}
