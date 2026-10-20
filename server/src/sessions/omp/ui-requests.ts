/**
 * extension_ui_request classification (Issue #460): approval select or immediate cancel, the approval
 * tool name, and the extension_ui_response frame shapes. Stateless; OmpProcess alone sends them.
 * Issue #1566 (design D3): an approval has one of two closed option shapes (v18.12.3 adds a session
 * grant the host never answers with); the browser eval prelude's card, matched by its whole title,
 * is answered `Approve` by the transport; anything else is cancelled.
 * Issue #1570 (design D7): #1526's rewrite of a `write` to `xd://browser` is gone with the device
 * (omp v18.12.3 drives its browser from `eval`): every approval keeps its title verbatim.
 */
import type { OmpFrame } from "./frame.js";

const APPROVAL_PREFIX = "Allow tool: ";
const UNKNOWN_TOOL = "unknown";
const SESSION_GRANT = /^Approve .+ for this session$/u;
// The prelude's header alone (omp v18.0.10's real `browser` card has `Action:` lines).
const PRELUDE_TITLE = /^Allow tool: browser(?:\nReason: [^\n]+)?$/u;

/** Owner-facing approval request: the frame id, the full title, the tool. */
export interface ApprovalRequest {
  id: string;
  title: string;
  tool: string;
}

export type ApprovalDecision = "allow" | "deny";

/** `["Approve","Deny"]`, or exactly `["Approve","Approve <subject> for this session","Deny"]`. */
function isApprovalOptions(options: unknown): boolean {
  if (!Array.isArray(options) || options[0] !== "Approve" || options.at(-1) !== "Deny") {
    return false;
  }
  const middle: unknown = options[1];
  return (
    options.length === 2 ||
    (options.length === 3 && typeof middle === "string" && SESSION_GRANT.test(middle))
  );
}

/** Approval iff select + approval options + title prefix + first-line tool not `browser`. */
export function approvalRequest(frame: OmpFrame, id: string): ApprovalRequest | undefined {
  const { method, options, title } = frame;
  if (
    method !== "select" ||
    !isApprovalOptions(options) ||
    typeof title !== "string" ||
    !title.startsWith(APPROVAL_PREFIX)
  ) {
    return undefined;
  }
  const rest = title.slice(APPROVAL_PREFIX.length);
  const newline = rest.indexOf("\n");
  const tool = (newline === -1 ? rest : rest.slice(0, newline)).trim();
  if (tool === "browser") {
    return undefined;
  }
  return { id, title, tool: tool.length > 0 ? tool : UNKNOWN_TOOL };
}

/** The browser prelude's card: select, the whole title, exactly `["Approve","Deny"]`. */
export function isPreludeCard(frame: OmpFrame): boolean {
  const { method, options, title } = frame;
  return (
    method === "select" &&
    typeof title === "string" &&
    PRELUDE_TITLE.test(title) &&
    Array.isArray(options) &&
    options.length === 2 &&
    options[0] === "Approve" &&
    options[1] === "Deny"
  );
}

export function cancelFrame(id: string): OmpFrame {
  return { type: "extension_ui_response", id, cancelled: true };
}

export function answerFrame(id: string, decision: ApprovalDecision): OmpFrame {
  return { type: "extension_ui_response", id, value: decision === "allow" ? "Approve" : "Deny" };
}
