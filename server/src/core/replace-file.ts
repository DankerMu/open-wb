import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Replaces `<dir>/<name>` without ever opening that path: the managed layout keeps the agent dir
 * read-only for the omp uid (ADR-0010), but a symlink left there by an older, group-writable
 * layout must still be replaced, not written through. The content goes to a temporary file created
 * exclusively in `dir`, with mode 0640 whatever the umask, which is then renamed over the target.
 * A failure after the creation removes the temporary file. `dir` must exist; it is never created.
 */
export async function replaceFile(dir: string, name: string, content: string): Promise<void> {
  const temporary = join(dir, `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.chmod(0o640);
    } finally {
      await handle.close();
    }
    await rename(temporary, join(dir, name));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
