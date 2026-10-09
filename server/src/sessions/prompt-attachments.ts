/**
 * Issue #1019 the attachments of a prompt (message-attachments「prompt 携带附件」, design D12 of
 * s1g-composer-capabilities): the body of `POST /api/sessions/:id/prompt` and the five conditions
 * a non-empty `attachments` has to meet before the prompt is admitted. `parsePromptBody` is the
 * body's key set, the text and condition 1 — lexical only, no file is touched. `admitAttachments`
 * is conditions 2 to 5 in that order; the prompt route (rest.ts) calls the two with its archive and
 * claim checks in between, and admits what the second returns.
 *
 * Every path goes through the sandbox facade the assembly injects — the one instance the
 * workspaces routes use, so a refusal is audited there and nowhere else — and the file it names is
 * only `lstat`ed: its content is never read, and the absolute path never leaves this file.
 */
import { Buffer } from "node:buffer";
import { lstatSync } from "node:fs";
import { HttpError } from "../core/errors/index.js";
import type { StoredAttachment } from "./store-attachments.js";

/**
 * The part of the sandbox facade (core/sandbox) the attachment check needs, declared here so that
 * sessions imports neither the facade nor the workspaces module: a refusal throws 403
 * `sandbox_denied` after the facade wrote its `sandbox.reject`, an invisible workspace throws 404.
 */
export interface SessionSandboxPort {
  resolve(principal: { id: string }, workspaceId: string, relPath: string, op: "read"): string;
}

const MESSAGE_LIMIT = 32_768;
const PATH_LIMIT = 1_024;

/**
 * Exactly `{message}` or `{message, attachments}` of an already checked plain record. `text` is the
 * message trimmed once, at most 32768 UTF-8 bytes; it may be empty only beside a non-empty
 * `attachments`. `paths` are the attachments as given (`[]` when absent), at most `maxFiles` of
 * them — the effective `UPLOAD_MAX_FILES`.
 */
export function parsePromptBody(
  body: Record<string, unknown>,
  maxFiles: number,
): { text: string; paths: string[] } {
  const keys = Object.keys(body).length;
  const listed = Object.hasOwn(body, "attachments");
  if (
    !Object.hasOwn(body, "message") ||
    typeof body.message !== "string" ||
    keys !== (listed ? 2 : 1)
  ) {
    throw new HttpError("bad_request");
  }
  const text = body.message.trim();
  const paths = listed ? parsePaths(body.attachments, maxFiles) : [];
  if (
    (text.length === 0 && paths.length === 0) ||
    Buffer.byteLength(text, "utf8") > MESSAGE_LIMIT
  ) {
    throw new HttpError("bad_request");
  }
  return { text, paths };
}

/**
 * Condition 1: a list of at most `maxFiles` distinct strings (compared as given: `a` and `./a` are
 * two), each 1 to 1024 UTF-8 bytes, without U+0000–U+001F, U+007F or a lone surrogate (it has no
 * UTF-8 encoding), and not ending in `/` — the sandbox skips empty segments, so such a path would
 * pass every later condition and still name no file.
 */
function parsePaths(value: unknown, maxFiles: number): string[] {
  if (!Array.isArray(value) || value.length > maxFiles) {
    throw new HttpError("bad_request");
  }
  const paths: string[] = [];
  for (const element of value as unknown[]) {
    if (
      typeof element !== "string" ||
      element.length === 0 ||
      Buffer.byteLength(element, "utf8") > PATH_LIMIT ||
      hasControlCharacter(element) ||
      Buffer.from(element, "utf8").toString("utf8") !== element ||
      element.endsWith("/") ||
      paths.includes(element)
    ) {
      throw new HttpError("bad_request");
    }
    paths.push(element);
  }
  return paths;
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) {
      return true;
    }
  }
  return false;
}

/** What `admitAttachments` judges the paths of one prompt against. */
export interface AttachmentAdmission {
  sandbox: SessionSandboxPort;
  /** The authenticated account. */
  principal: { id: string };
  /** The session's own binding; null for a session without a workspace. */
  workspaceId: string | null;
  /** Whether the prompt's text is a builtin command. */
  builtin: boolean;
  paths: readonly string[];
}

/**
 * Conditions 2 to 5 for the paths of one prompt; no path, nothing to check. A session without a
 * workspace (2) and a builtin command (3) take no attachment: 400 before anything is resolved.
 * Then two passes: every path is resolved in request order as a `read` of this account in this
 * workspace (4) — the first refusal throws, so one request writes at most one audit event — and
 * only then is any file looked at: each target has to be an existing regular file (5; `lstat`, a
 * link is not followed), else 400. Returns what the admission stores: the path as given and the
 * size that `lstat` reported.
 */
export function admitAttachments({
  sandbox,
  principal,
  workspaceId,
  builtin,
  paths,
}: AttachmentAdmission): StoredAttachment[] {
  if (paths.length === 0) {
    return [];
  }
  if (workspaceId === null || builtin) {
    throw new HttpError("bad_request");
  }
  const targets = paths.map((path) => sandbox.resolve(principal, workspaceId, path, "read"));
  return paths.map((path, index) => ({ path, size: regularFileSize(targets[index] ?? "") }));
}

function regularFileSize(absPath: string): number {
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(absPath);
  } catch (error) {
    // `uploads/a.pdf/x`: the sandbox lets a path through a regular file pass.
    if (isMissing(error)) {
      throw new HttpError("bad_request");
    }
    throw error;
  }
  if (!status.isFile()) {
    throw new HttpError("bad_request");
  }
  return status.size;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
