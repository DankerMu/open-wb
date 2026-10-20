/**
 * extension_ui_request classification (Issue #460): approval select or immediate cancel, the approval
 * tool name, and the extension_ui_response frame shapes. Stateless; OmpProcess alone sends them.
 * Issue #1566 (design D3): an approval has one of two closed option shapes (v18.12.3 adds a session
 * grant the host never answers with); the browser eval prelude's card, matched by its whole title,
 * is answered `Approve` by the transport; anything else is cancelled.
 * Issue #1526 (design D5): a `write` approval whose path is the browser device becomes tool `browser`
 * with a readable title, before it is registered, published or audited.
 */
import type { OmpFrame } from "./frame.js";
import {
  browserFlags,
  browserSummary,
  isBrowserDevicePath,
  parseBrowserContent,
} from "./xd-browser.js";

const APPROVAL_PREFIX = "Allow tool: ";
const UNKNOWN_TOOL = "unknown";
// omp v18.0.10's `write` approval (no Reason line; v18.12.3 has no `xd://browser`):
// `Allow tool: write\nPath: <path>\nContent:\n<content>`.
const WRITE_PATH = "Allow tool: write\nPath: ";
const CONTENT = "\nContent:\n";
const SESSION_GRANT = /^Approve .+ for this session$/u;
// The prelude's header alone (v18.0.10's real `browser` card has `Action:` lines).
const PRELUDE_TITLE = /^Allow tool: browser(?:\nReason: [^\n]+)?$/u;
const TRUNCATED = [
  "浏览器操作（参数过长，以下为原文）",
  "⚠ 参数被截断，无法确认是否启动外部程序或连接外部浏览器",
];

/** Owner-facing approval request: the frame id, the full (or browser-rewritten) title, the tool. */
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
  const browser = browserTitle(title);
  if (browser !== undefined) {
    return { id, title: browser, tool: "browser" };
  }
  return { id, title, tool: tool.length > 0 ? tool : UNKNOWN_TOOL };
}

/**
 * The rewritten title when the path before the first `\nContent:\n` is the browser device (the same
 * judgment as the step's, so the two pair by name): summary and flag lines, then `代码：` and the code
 * of a `run`, then `原文：` and the content when unverified; a content that does not parse (omp
 * truncated it) keeps its text under a fixed warning.
 */
function browserTitle(title: string): string | undefined {
  const contentAt = title.startsWith(WRITE_PATH) ? title.indexOf(CONTENT, WRITE_PATH.length) : -1;
  if (contentAt === -1 || !isBrowserDevicePath(title.slice(WRITE_PATH.length, contentAt))) {
    return undefined;
  }
  const content = title.slice(contentAt + CONTENT.length);
  const call = parseBrowserContent(content);
  if (call === undefined || call.unparsed === true) {
    return [...TRUNCATED, content].join("\n");
  }
  const code = call.action === "run" && call.code !== undefined ? ["代码：", call.code] : [];
  const raw = call.unverified === true ? ["原文：", content] : [];
  return [browserSummary(call), ...browserFlags(call), ...code, ...raw].join("\n");
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
