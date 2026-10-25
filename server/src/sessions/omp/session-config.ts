/**
 * The per-spawn session config file (change s1d-experts-skills, design D1; omp-runtime「子进程 spawn
 * 契约」「会话配置文件」). Each spawn gets its own random key: `<key>.yml` is a second `--config`
 * layer holding exactly the session's `disabledExtensions`, and `<key>.md` — only with an expert —
 * is the file `--append-system-prompt` reads. Both are written like the managed `models.yml`
 * (`replaceFile`, 0640) into `session-config/` (2710: the omp uid opens them by exact path only) and
 * removed when the child is gone; a file that cannot be removed is reported once to the caller's
 * callback (issue #1722). The caller decides the content; nothing here defaults it.
 * The content is one pure function of the capabilities (`sessionConfigContent`), shared by the write
 * and by the capability fingerprint a dispatch compares (design D8, group 6).
 */
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { replaceFile } from "../../core/replace-file.js";
import { ompSessionConfigDir } from "./state-layout.js";

export interface SessionCapabilities {
  /** Already prefixed (`skill:<name>`, `mcp:<name>`); deduplicated and sorted when written. */
  readonly disabledExtensions: readonly string[];
  /** The effective expert's prompt; null without an expert. */
  readonly appendSystemPrompt: string | null;
}

export interface SessionConfig {
  /** `--config <yml>` and, with an expert, `--append-system-prompt <md>`: absolute paths. */
  readonly args: readonly string[];
  readonly key: string;
  /** Deletes both files on its first call, later calls do nothing; never throws. */
  readonly remove: () => void;
}

/**
 * A session config file's removal failure, once per file (omp-runtime「子进程 spawn 契约」).
 * Synchronous; whatever it throws is swallowed so exit handling goes on.
 */
export type SessionConfigReport = (error: Error) => void;

/**
 * One line: every element a JSON string, which is also a YAML double-quoted scalar, so `:`, `#` or
 * `"` in a name cannot break the document. omp replaces arrays whole, so this list overrides the
 * project and global `disabledExtensions`, even when empty.
 */
function sessionConfigYaml(disabled: readonly string[]): string {
  const elements = [...new Set(disabled)].sort().map((element) => JSON.stringify(element));
  return `disabledExtensions: [${elements.join(", ")}]\n`;
}

/** The two files' text: `<key>.yml`, and `<key>.md` (null: no file, no flag). */
export function sessionConfigContent(capabilities: SessionCapabilities): {
  yml: string;
  md: string | null;
} {
  return {
    yml: sessionConfigYaml(capabilities.disabledExtensions),
    md: capabilities.appendSystemPrompt,
  };
}

/**
 * The capability fingerprint (chat-sessions「派发前按会话设置对齐进程」step 1): SHA-256 hex over the
 * JSON array `[yml, md, mcpJson]` — the `.yml` text and the `.md` text or `null` (the fixed no-file
 * mark, so with and without an expert never collide whatever the prompt says) of
 * `sessionConfigContent`, then the managed `mcp.json` bytes as the caller read them (`""` when there
 * is none; s1d-connectors D8). The key is not in it: equal capabilities over the same `mcp.json`
 * give one fingerprint on every spawn.
 */
export function sessionConfigFingerprint(
  capabilities: SessionCapabilities,
  mcpJson: string,
): string {
  const { yml, md } = sessionConfigContent(capabilities);
  return createHash("sha256")
    .update(JSON.stringify([yml, md, mcpJson]))
    .digest("hex");
}

/**
 * Writes this spawn's files; on any write failure the ones already written are removed. `report`
 * receives each removal failure — of that rollback or of the returned `remove` — exactly once;
 * omitted, failures are discarded.
 */
export async function writeSessionConfig(
  stateDir: string,
  capabilities: SessionCapabilities,
  report?: SessionConfigReport,
): Promise<SessionConfig> {
  const dir = ompSessionConfigDir(stateDir);
  const key = randomBytes(16).toString("hex");
  const yml = join(dir, `${key}.yml`);
  const md = join(dir, `${key}.md`);
  let done = false;
  const remove = (): void => {
    if (done) {
      return;
    }
    done = true;
    for (const path of [yml, md]) {
      try {
        rmSync(path, { force: true });
      } catch (error) {
        // Not retried: reported to the caller's channel (in production one `session_fault` line).
        try {
          report?.(error instanceof Error ? error : new Error(String(error)));
        } catch {
          // A failing report channel must not interrupt the exit handling that called remove.
        }
      }
    }
  };
  const content = sessionConfigContent(capabilities);
  try {
    await replaceFile(dir, `${key}.yml`, content.yml);
    if (content.md !== null) {
      await replaceFile(dir, `${key}.md`, content.md);
    }
  } catch (error) {
    remove();
    throw error;
  }
  const args = ["--config", yml, ...(content.md === null ? [] : ["--append-system-prompt", md])];
  return { args, key, remove };
}
