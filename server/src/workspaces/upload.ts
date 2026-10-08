/**
 * workspaces/upload — the disk side of a streamed upload (s1g design D10 / D11 steps 7 and 8;
 * spec workspaces「文件上传」). No HTTP here: the caller has checked ownership, been through the
 * sandbox, applied the name rules and made the directory; this module writes one stream into it.
 *
 * The bytes go to a temporary file in the same directory (`.upload-<hex>.part`, created
 * exclusively), counted as they pass. Then the file gets its name by `link`, which creates the
 * name only when nothing is there: a taken name, a symbolic link included (dangling or not, it is
 * not followed), moves on to the next candidate, so nothing is ever overwritten and two uploads
 * of one name each get their own. Node has no `rename` that refuses to replace.
 *
 * Three outcomes for the caller to tell apart:
 * - `HttpError("upload_too_large")`: the stream went past `maxBytes`; reading stopped there.
 * - `HttpError("conflict")`: the name and its 999 numbered forms are all taken.
 * - anything else (the source failed, the disk did, a numbered name is too long) is passed on
 *   as it is.
 * Whichever it is, the temporary file is removed. One exception to "nothing is left": if the name
 * was linked and removing the temporary file then fails, the error is passed on and the named
 * file stays.
 *
 * Not done here: no fsync, no directory handle. A parent directory replaced by a symbolic link
 * after the caller resolved it is traversed (the residual registered in design D11 / Risks).
 */
import { randomBytes } from "node:crypto";
import { link, open, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../core/errors/index.js";
import { codeOf } from "./snapshots.js";

/**
 * Shared with the omp user's group, which reads and writes the file through the directory's
 * setgid group (ADR-0010). Exact: set on the handle, so the umask has no say.
 */
const UPLOAD_MODE = 0o660;
/** The name itself plus `(1)` … `(999)`. */
const LAST_NUMBER = 999;

interface UploadOptions {
  /** Absolute path of an existing directory, already through the sandbox. */
  dir: string;
  /** One path component, already validated by the caller. */
  name: string;
  source: Readable;
  /** A body of exactly this many bytes is accepted. */
  maxBytes: number;
}

interface StoredUpload {
  /** The name the file ended up with: the given one, or a numbered form of it. */
  name: string;
  size: number;
}

/**
 * `<stem> (n)<extension>`. The extension starts at the last dot; a name without a dot, or whose
 * only dot is the first character, has none.
 */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? `${name} (${n})` : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/** Links `temp` to the first free candidate and returns that candidate. */
async function linkFreeName(temp: string, dir: string, name: string): Promise<string> {
  for (let n = 0; n <= LAST_NUMBER; n += 1) {
    const candidate = n === 0 ? name : numbered(name, n);
    try {
      await link(temp, join(dir, candidate));
      return candidate;
    } catch (error) {
      if (codeOf(error) !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new HttpError("conflict");
}

export async function storeUpload(options: UploadOptions): Promise<StoredUpload> {
  const { dir, name, source, maxBytes } = options;
  // The caller's rules guarantee this; a name that is not one component would leave `dir`.
  if (name === "" || name.includes("/")) {
    throw new Error("upload name is not a single path component");
  }
  const temp = join(dir, `.upload-${randomBytes(16).toString("hex")}.part`);
  const handle = await open(temp, "wx", UPLOAD_MODE);
  try {
    await handle.chmod(UPLOAD_MODE);
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        // The chunk that crosses the limit is not written; `pipeline` then destroys the source.
        if (size > maxBytes) {
          done(new HttpError("upload_too_large"));
          return;
        }
        done(null, chunk);
      },
    });
    // The write stream closes the handle when it ends or is destroyed. Keeping it open past
    // that (`autoClose: false`) would leave the stream's hold on the handle in place, and the
    // `close` below would wait for it forever.
    await pipeline(source, counter, handle.createWriteStream());
    const finalName = await linkFreeName(temp, dir, name);
    await unlink(temp);
    return { name: finalName, size };
  } catch (error) {
    // Best effort: the error that brought us here is the one the caller has to see.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    // For a failure before the stream had the handle; a second close is a no-op.
    await handle.close();
  }
}
