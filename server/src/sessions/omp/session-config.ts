/**
 * The per-spawn session config file (change s1d-experts-skills, design D1; omp-runtime「子进程 spawn
 * 契约」「会话配置文件」). Each spawn gets its own random key: `<key>.yml` is a second `--config`
 * layer holding exactly the session's `disabledExtensions`, and `<key>.md` — only with an expert —
 * is the file `--append-system-prompt` reads. Both are written like the managed `models.yml`
 * (`replaceFile`, 0640) into `session-config/` (2710: the omp uid opens them by exact path only) and
 * removed when the child is gone. The caller decides the content; nothing here defaults it.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { replaceFile } from "../../core/replace-file.js";
import { ompSessionConfigDir } from "./state-layout.js";

export interface SessionCapabilities {
  /** Already prefixed (`skill:<name>`); deduplicated and sorted when written. */
  readonly disabledExtensions: readonly string[];
  /** The effective expert's prompt; null without an expert. */
  readonly appendSystemPrompt: string | null;
}

/** No expert and nothing disabled: what every spawn path passes until capabilities are wired. */
export const NO_SESSION_CAPABILITIES: SessionCapabilities = Object.freeze({
  disabledExtensions: Object.freeze([]),
  appendSystemPrompt: null,
});

export interface SessionConfig {
  /** `--config <yml>` and, with an expert, `--append-system-prompt <md>`: absolute paths. */
  readonly args: readonly string[];
  readonly key: string;
  /** Deletes both files; idempotent, never throws. */
  readonly remove: () => void;
}

/**
 * One line: every element a JSON string, which is also a YAML double-quoted scalar, so `:`, `#` or
 * `"` in a name cannot break the document. omp replaces arrays whole, so this list overrides the
 * project and global `disabledExtensions`, even when empty.
 */
function sessionConfigYaml(disabled: readonly string[]): string {
  const elements = [...new Set(disabled)].sort().map((element) => JSON.stringify(element));
  return `disabledExtensions: [${elements.join(", ")}]\n`;
}

/** Writes this spawn's files; on any write failure the ones already written are removed. */
export async function writeSessionConfig(
  stateDir: string,
  capabilities: SessionCapabilities,
): Promise<SessionConfig> {
  const dir = ompSessionConfigDir(stateDir);
  const key = randomBytes(16).toString("hex");
  const yml = join(dir, `${key}.yml`);
  const md = join(dir, `${key}.md`);
  const remove = (): void => {
    for (const path of [yml, md]) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Only logged: the exit handling goes on; the next startup's sweep clears what is left.
        process.emitWarning("session config file not removed", "WorkbuddySessionConfig");
      }
    }
  };
  const prompt = capabilities.appendSystemPrompt;
  try {
    await replaceFile(dir, `${key}.yml`, sessionConfigYaml(capabilities.disabledExtensions));
    if (prompt !== null) {
      await replaceFile(dir, `${key}.md`, prompt);
    }
  } catch (error) {
    remove();
    throw error;
  }
  const args = ["--config", yml, ...(prompt === null ? [] : ["--append-system-prompt", md])];
  return { args, key, remove };
}
