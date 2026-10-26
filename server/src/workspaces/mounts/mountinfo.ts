/**
 * workspaces/mounts/mountinfo — reading `/proc/self/mountinfo` for the mount-manager (s1b-workspace-mounts
 * design D9; workspace-mounts「挂载进程与挂载点」). "Mounted" is a line whose mount point (field 5, its
 * octal escapes decoded) equals the path byte for byte, whatever the file-system type — the #1237
 * criterion (temporary-workspaces「临时空间目录的删除」). A mount of this manager is recognised wherever it
 * landed by type `fuse.rclone` and a source (the second field after the `-` separator; the optional
 * fields before it vary in number) starting `<section>:` or `<section>{` (#1665 P1′: an argv override
 * gives the remote name a `{xxxxx}` suffix; P15: a swapped mount point lands the mount elsewhere).
 *
 * The kernel writes space, tab, newline and backslash of both fields as `\ooo`; every other byte raw.
 * Decoding works on bytes (latin1) and then reads them as UTF-8, so CJK names survive; paths are
 * compared as those strings, which is byte comparison wherever the line is valid UTF-8 (invalid bytes
 * decode to U+FFFD). A missing file (no `/proc`, e.g. macOS) reads as no mounts.
 *
 * The read is synchronous on purpose: procfs, never a FUSE path (D21 forbids synchronous calls under a
 * mount point, not here), and off the libuv pool. Hung calls inside a mount each hold a pool thread;
 * the recovery that frees them (SIGKILL rclone, read mountinfo, `-uz`) must not queue behind them, or
 * it never runs (#1795 review).
 */
import { readFileSync } from "node:fs";

export const SYSTEM_MOUNTINFO = "/proc/self/mountinfo";

export interface MountEntry {
  mountPoint: string;
  fstype: string;
  source: string;
}

export function parseMountinfo(text: Buffer): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.toString("latin1").split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    const mountPoint = fields[4];
    const fstype = fields[separator + 1];
    const source = fields[separator + 2];
    if (
      separator === -1 ||
      mountPoint === undefined ||
      fstype === undefined ||
      source === undefined
    ) {
      continue;
    }
    entries.push({
      mountPoint: decode(mountPoint),
      fstype: decode(fstype),
      source: decode(source),
    });
  }
  return entries;
}

export function readMountinfo(path: string): MountEntry[] {
  try {
    return parseMountinfo(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** The `fuse.rclone` lines whose source names this section, wherever they are mounted. */
export function sectionMounts(entries: readonly MountEntry[], section: string): MountEntry[] {
  return entries.filter(
    (entry) =>
      entry.fstype === "fuse.rclone" &&
      (entry.source.startsWith(`${section}:`) || entry.source.startsWith(`${section}{`)),
  );
}

/**
 * What "lazily unmount this mount" runs `-uz` on: the mount point when it is in mountinfo, then the
 * mount point of every line of this section (design D9), each once.
 */
export function unmountTargets(
  entries: readonly MountEntry[],
  mountPoint: string | undefined,
  section: string,
): string[] {
  const targets =
    entries.some((entry) => entry.mountPoint === mountPoint) && mountPoint !== undefined
      ? [mountPoint]
      : [];
  for (const entry of sectionMounts(entries, section)) {
    if (!targets.includes(entry.mountPoint)) {
      targets.push(entry.mountPoint);
    }
  }
  return targets;
}

function decode(field: string): string {
  return Buffer.from(
    field.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    ),
    "latin1",
  ).toString("utf8");
}
