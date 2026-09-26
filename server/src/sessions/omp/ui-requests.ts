/**
 * extension_ui_request classification (Issue #460): approval select or immediate cancel, the approval
 * tool name, and the extension_ui_response frame shapes. Stateless; OmpProcess alone sends them.
 */
import type { OmpFrame } from "./frame.js";

const APPROVAL_PREFIX = "Allow tool: ";
const UNKNOWN_TOOL = "unknown";

/** Owner-facing approval request: the frame id, the full title and the parsed tool name. */
export interface ApprovalRequest {
  id: string;
  title: string;
  tool: string;
}

export type ApprovalDecision = "allow" | "deny";

/** Approval iff select + options exactly ["Approve","Deny"] + title prefix; else undefined (cancel). */
export function approvalRequest(frame: OmpFrame, id: string): ApprovalRequest | undefined {
  const { method, options, title } = frame;
  if (
    method !== "select" ||
    !Array.isArray(options) ||
    options.length !== 2 ||
    options[0] !== "Approve" ||
    options[1] !== "Deny" ||
    typeof title !== "string" ||
    !title.startsWith(APPROVAL_PREFIX)
  ) {
    return undefined;
  }
  const rest = title.slice(APPROVAL_PREFIX.length);
  const newline = rest.indexOf("\n");
  const tool = (newline === -1 ? rest : rest.slice(0, newline)).trim();
  return { id, title, tool: tool.length > 0 ? tool : UNKNOWN_TOOL };
}

export function cancelFrame(id: string): OmpFrame {
  return { type: "extension_ui_response", id, cancelled: true };
}

export function answerFrame(id: string, decision: ApprovalDecision): OmpFrame {
  return { type: "extension_ui_response", id, value: decision === "allow" ? "Approve" : "Deny" };
}
