/**
 * Issue #1019 the attachments of a prompt (message-attachments「prompt 携带附件」, design D12 of
 * s1g-composer-capabilities): the body of `POST /api/sessions/:id/prompt` and the five conditions
 * a non-empty `attachments` has to meet before the prompt is admitted. `parsePromptBody` is the
 * body's key set, the text and condition 1 — lexical only, no file is touched. `admitAttachments`
 * is conditions 2 to 5 in that order; the prompt route (rest.ts) calls the two with its archive and
 * claim checks in between, and admits what the second returns.
 *
 * Condition 4 is in two steps (#1257): the root of the session's workspace has to be a directory
 * before any path is resolved, else 404 and no audit event — with no root the facade refuses every
 * path as an escape, and that event would be false. Then every path goes through the sandbox
 * facade the assembly injects — the one instance the workspaces routes use, so a refusal is
 * audited there and nowhere else — and the file it names is only `lstat`ed: its content is never
 * read, and the absolute path never leaves this file. A path whose first segment is one of the
 * workspace's registered mount names (s1b-workspace-mounts D21) is a 400 after that resolution,
 * judged by name: nothing in a mount is looked at.
 */
import { Buffer } from "node:buffer";
import { lstatSync } from "node:fs";
import { HttpError } from "../core/errors/index.js";
import { hasRefusedCharacter } from "../core/refused-characters.js";
import { firstSegment } from "../core/sandbox/resolve.js";
import { WorkspaceRootOccupiedError } from "../workspaces/store.js";
import type { WorkspaceRootOf } from "./session-cwd.js";
import type { StoredAttachment } from "./store-attachments.js";

/**
 * The part of the sandbox facade (core/sandbox) the attachment check needs, declared here so that
 * sessions does not import the facade: a refusal throws 403 `sandbox_denied` after the facade
 * wrote its `sandbox.reject`, a workspace that is not this account's throws 404.
 */
export interface SessionSandboxPort {
  resolve(principal: { id: string }, workspaceId: string, relPath: string, op: "read"): string;
  /** The workspace's registered mount names (D21); omitted means none. */
  mountNamesOf?(workspaceId: string): ReadonlySet<string>;
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
 * two), each 1 to 1024 UTF-8 bytes, without a refused code point (`hasRefusedCharacter`: the
 * controls, three line breaks and the bidirectional controls, the same list an upload's name is
 * held to) or a lone surrogate (it has no UTF-8 encoding), and neither ending in `/` nor with `.`
 * as its last segment — the sandbox skips empty and `.` segments, so such a path would pass every
 * later condition and still name no file (`uploads/a.pdf/.`). A `.` segment before the last is not
 * refused.
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
      hasRefusedCharacter(element) ||
      Buffer.from(element, "utf8").toString("utf8") !== element ||
      element.endsWith("/") ||
      element === "." ||
      element.endsWith("/.") ||
      paths.includes(element)
    ) {
      throw new HttpError("bad_request");
    }
    paths.push(element);
  }
  return paths;
}

/** What `admitAttachments` judges the paths of one prompt against. */
export interface AttachmentAdmission {
  sandbox: SessionSandboxPort;
  /** The workspace store's owner-scoped `rootOf`, as the rest of the session module has it. */
  workspaceRootOf: WorkspaceRootOf;
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
 * Then the root (4, first half; `assertRootVisible`), once for the request, and two passes: every
 * path is resolved in request order as a `read` of this account in this workspace (4) — the first
 * refusal throws, so one request writes at most one audit event — and only then is any file looked
 * at: each target has to be outside the registered mounts (by its first segment, no file system
 * call) and an existing regular file (5; `lstat`, a link is not followed), else 400. Returns what
 * the admission stores: the path as given and the size that `lstat` reported.
 */
export function admitAttachments({
  sandbox,
  workspaceRootOf,
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
  assertRootVisible(workspaceRootOf, principal.id, workspaceId);
  const targets = paths.map((path) => sandbox.resolve(principal, workspaceId, path, "read"));
  const mounts = sandbox.mountNamesOf?.(workspaceId);
  if (paths.some((path) => mounts?.has(firstSegment(path) ?? "") === true)) {
    throw new HttpError("bad_request");
  }
  return paths.map((path, index) => ({ path, size: regularFileSize(targets[index] ?? "") }));
}

/**
 * 404 unless the workspace's root is a directory right now: the lookup answers null (not this
 * account's workspace), throws the store's `WorkspaceRootOccupiedError` (a non-directory is at the
 * path), or names a path where `lstat` finds no directory (nothing there; a link is not followed).
 * The same answer the workspaces routes give (`ensureOwnedRoot`), and like there nothing is
 * resolved and nothing audited. Any other failure of the lookup is thrown as it is and stays the
 * generic failure it was (design D14-1): a root that is a symbolic link (tested), an owner
 * directory that is itself occupied by a file — the store's own `lstat` then throws `ENOTDIR`,
 * which is not the dedicated class (tested) — and an unsafe owner segment (read from the code, not
 * exercised).
 * A check, not a hold: a root removed between this `lstat` and the facade's own look at it would
 * still be refused there, as the 403 with its event that every such request was before (read from
 * the code, not exercised).
 */
function assertRootVisible(
  workspaceRootOf: WorkspaceRootOf,
  ownerId: string,
  workspaceId: string,
): void {
  let root: string | null;
  try {
    root = workspaceRootOf(ownerId, workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceRootOccupiedError) {
      throw new HttpError("not_found");
    }
    throw error;
  }
  if (root === null || !isDirectory(root)) {
    throw new HttpError("not_found");
  }
}

function isDirectory(absPath: string): boolean {
  try {
    return lstatSync(absPath).isDirectory();
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
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
