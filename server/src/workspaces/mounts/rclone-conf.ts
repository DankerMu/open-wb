/**
 * workspaces/mounts/rclone-conf — the per-mount credential file `<state>/mounts/<id>/rclone.conf`
 * (s1b-workspace-mounts design D5 file part, D6; workspace-mounts「挂载凭证文件」). One INI section
 * `m<mount id>`; `sftp` / `smb` carry the host IP judged by host-policy for this attempt (never the
 * user's name — rclone does not resolve), `local` only its type. The private `<id>/` directory is the
 * manager's (D5: it also holds `cache/` and `rclone.log`) and must exist; nothing here creates it.
 *
 * Every write goes to a temporary name in the same directory and is renamed into place at 0600
 * (`replaceFile`). A password reaches rclone only on the stdin of `<RCLONE_BIN> obscure -` (#1665 P2′),
 * whose environment is exactly `{PATH, HOME}`; a hang past the deadline is killed and, like any other
 * obscure failure, fails the write. Errors never carry a credential or rclone output.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { replaceFile } from "../../core/replace-file.js";
import type { MountBody } from "./validate.js";

const CONF = "rclone.conf";
const CONF_MODE = 0o600;
const OBSCURE_TIMEOUT_MS = 10_000;
const MOUNT_ID = /^[0-9a-f]{32}$/u;
/** rclone's obscure output is base64 RawURLEncoding. */
const OBSCURED = /^[A-Za-z0-9_-]+$/u;
const HOST_PREFIX = "host = ";

export interface ConfTarget {
  rcloneBin: string;
  /** `<state>/mounts/<id>`: existing, app-private; also the obscure child's `HOME`. */
  dir: string;
  mountId: string;
  /** Tests only; the deadline is 10 s. */
  obscureTimeoutMs?: number;
}

/**
 * Creation: the whole file. `host` is required for `sftp` / `smb` (an IP literal) and refused for
 * `local`.
 */
export async function writeRcloneConf(
  target: ConfTarget,
  mount: MountBody,
  host?: string,
): Promise<void> {
  if (!MOUNT_ID.test(target.mountId)) {
    throw new Error("rclone.conf: mount id must be 32 lowercase hex digits");
  }
  const lines = [`[m${target.mountId}]`, `type = ${mount.backend}`];
  if (mount.backend === "local") {
    if (host !== undefined) {
      throw new Error("rclone.conf: a local mount has no host");
    }
  } else {
    lines.push(hostLine(host), ...(mount.port === undefined ? [] : [`port = ${mount.port}`]));
    lines.push(userLine(mount.username));
    if ("privateKey" in mount) {
      // #1665 P12: rclone's single-line key_pem spelling. validate.ts holds the key to printable ASCII
      // and `\n` starting `-----BEGIN `, so it never opens with a quote and has no other line break.
      lines.push(`key_pem = ${mount.privateKey.replaceAll("\n", "\\n")}`);
    } else {
      lines.push(`pass = ${await obscure(target, mount.password)}`);
    }
    if (mount.backend === "smb" && mount.domain !== undefined) {
      // validate.ts: `[A-Za-z0-9._-]{1,64}` — no quote, whitespace or comment character.
      lines.push(`domain = ${mount.domain}`);
    }
  }
  await replaceFile(target.dir, CONF, `${lines.join("\n")}\n`, CONF_MODE);
}

/**
 * Remount and startup recovery: read the file back and replace only the value of its single `host`
 * line; every other byte is kept, so no credential is handled again. A file without exactly one
 * `host` line (a `local` mount's) is refused unchanged.
 */
export async function rewriteHost(dir: string, host: string): Promise<void> {
  const line = hostLine(host);
  const lines = (await readFile(join(dir, CONF), "utf8")).split("\n");
  const at = lines.flatMap((text, index) => (text.startsWith(HOST_PREFIX) ? [index] : []));
  if (at.length !== 1) {
    throw new Error("rclone.conf: expected exactly one host line");
  }
  lines[at[0] ?? 0] = line;
  await replaceFile(dir, CONF, lines.join("\n"), CONF_MODE);
}

/**
 * The judged address as rclone dials it. rclone v1.60.1 appends the port without bracketing (measured
 * on the test host, #1685 follow-up 2026-10-25: `host = fd00::1` dials `fd00::1:22` and fails with
 * "too many colons"; `host = [fd00::1]` dials `[fd00::1]:22`, sftp and smb alike), so every IPv6
 * literal — IPv4-mapped included, it has colons too — is written in brackets; IPv4 is written as is.
 * The caller keeps the bare address (host-policy's verdict) for its own `node:net` connect check.
 */
function hostLine(host: string | undefined): string {
  const family = host === undefined ? 0 : isIP(host);
  if (family === 0) {
    throw new Error("rclone.conf: host must be the judged IP literal");
  }
  return `${HOST_PREFIX}${family === 6 ? `[${host}]` : host}`;
}

/**
 * Only `user` is quoted. rclone v1.60.1 (`rclone config dump`, measured on the test host, #1685
 * comment 2026-10-25) unquotes a value that starts with a backtick pair, reads a value starting `"""`
 * as multi-line (the whole config then fails to load) and strips leading / trailing U+0085 (Go's
 * TrimSpace, which JS `trim()` in validate.ts does not cover); `"…"`, `'…'`, `#` and `;` stay literal.
 * Wrapping in backticks round-tripped every tested value verbatim, including values that contain or
 * consist of backticks. The other values cannot hit any of these: `pass` is checked against the
 * obscure alphabet, `domain` is `[A-Za-z0-9._-]`, `host` an IP literal, `key_pem` starts `-----BEGIN `.
 * A line break would end the value; validate.ts already refuses control characters.
 */
function userLine(username: string): string {
  if (/[\r\n]/u.test(username)) {
    throw new Error("rclone.conf: user must be a single line");
  }
  return `user = \`${username}\``;
}

/** `<rcloneBin> obscure -`: the password on stdin, one obscure token (and a newline) on stdout. */
function obscure(target: ConfTarget, password: string): Promise<string> {
  return new Promise((settle, fail) => {
    let stdout = "";
    let timedOut = false;
    const child = spawn(target.rcloneBin, ["obscure", "-"], {
      env: { PATH: process.env.PATH ?? "", HOME: target.dir },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, target.obscureTimeoutMs ?? OBSCURE_TIMEOUT_MS);
    child.on("error", (cause) => {
      clearTimeout(timer);
      fail(new Error("rclone obscure could not be started", { cause: errnoOf(cause) }));
    });
    // A child that exits before reading leaves an EPIPE here; its exit status decides the outcome.
    child.stdin.on("error", () => undefined);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const token = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
      if (timedOut) {
        fail(new Error("rclone obscure timed out"));
      } else if (code !== 0 || !OBSCURED.test(token)) {
        fail(new Error("rclone obscure failed"));
      } else {
        settle(token);
      }
    });
    child.stdin.end(password);
  });
}

/** Only the errno code survives into `cause`: the spawn error's message would carry the binary path. */
function errnoOf(error: Error): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}
