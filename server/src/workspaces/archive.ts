/**
 * workspaces/archive — the member list of a tar / tar.gz, and the single item of a bare .gz
 * (s1f-files-page design D7, workspaces「压缩包列表」). The zip half and the route come later.
 *
 * The bytes are a user's file and every field in them is attacker-controlled. What this module
 * holds on to, whatever the archive declares:
 * - it reads through the caller's `readAt` only and imports no fs / os / path module: nothing is
 *   unpacked, nothing is written, and a member name is never anything but a string;
 * - one `readAt` call asks for at most 65536 bytes: a 512-byte header, an extension record whose
 *   declared size was checked before the read, or one chunk of compressed input;
 * - a GNU `L` or pax `x` record declaring more than 65536 bytes is not read, a name longer than
 *   4096 bytes is not listed; either one ends the walk as corruption does;
 * - the walk stops at `maxEntries` and 5000 ms after it began; the clock is read before every
 *   header and, in a tar.gz, before every 1024 compressed bytes handed to the inflater.
 * Corruption (a short or missing header, a bad checksum, a non-octal size, a bad pax record, a
 * gunzip error) with nothing listed yet is `preview_unsupported`; after the first entry it ends
 * the walk with `truncated`. Running out of time is never `preview_unsupported`: it returns what
 * was listed, possibly nothing, with `truncated`. A failure of `readAt` itself is rethrown as it is.
 */
import { createGunzip, type Gunzip } from "node:zlib";
import { HttpError } from "../core/errors/index.js";

type ArchiveFormat = "tar" | "tar.gz" | "gz";
type ReadAt = (position: number, length: number) => Promise<Buffer>;
type Expired = () => boolean;

interface ArchiveEntry {
  /** The member name as the archive gives it: no normalisation, `..` and a leading `/` included. */
  path: string;
  type: "file" | "dir";
  /** The size in the member's header; null where the format does not say (a bare .gz). */
  size: number | null;
}

interface Walked {
  entries: ArchiveEntry[];
  truncated: boolean;
}

interface ByteSource {
  /** The next `length` bytes; fewer where the data ends. A tar.gz also stops short, here and in `skip`, once the time is up. */
  read(length: number): Promise<Buffer>;
  /** Steps over `length` bytes without handing them out. */
  skip(length: number): Promise<void>;
}

interface Header {
  name: string;
  typeflag: number;
  size: number;
}

/** Names carried by extension records for the next member; pax `path` wins over GNU `L`. */
interface PendingNames {
  pax: string | null;
  gnu: string | null;
}

const BLOCK = 512;
/** Also the largest `length` any `readAt` call is given; a multiple of `BLOCK`. */
const MAX_EXTENSION_BYTES = 65_536;
const MAX_NAME_BYTES = 4096;
const DEADLINE_MS = 5000;
/** Compressed bytes given to the inflater per step; bounds what one step can inflate. */
const FEED_BYTES = 1024;

const TYPE_DIRECTORY = 0x35; // "5"
const TYPE_GNU_LONG_NAME = 0x4c; // "L"
const TYPE_GNU_LONG_LINK = 0x4b; // "K"
const TYPE_PAX = 0x78; // "x"
const TYPE_PAX_GLOBAL = 0x67; // "g"
/** POSIX ustar. GNU writes `ustar` + two spaces + NUL here and uses the prefix area for other fields. */
const USTAR_MAGIC = "ustar\u0000";
const OCTAL = /^[0-7]+$/u;
const DECIMAL = /^[0-9]+$/u;
const SPACE = 0x20;
const EQUALS = 0x3d;
const NEWLINE = 0x0a;

/** Ends the walk: `preview_unsupported` with nothing listed, `truncated` otherwise. Never leaves this module. */
class CorruptArchive extends Error {}

/** By the lowercased file name; `.tar.gz` and `.tgz` are checked before `.gz`. */
export function archiveFormat(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".tar")) {
    return "tar";
  }
  return lower.endsWith(".gz") ? "gz" : null;
}

/**
 * `readAt(position, length)` returns up to `length` bytes of the archive, fewer only at its end.
 * `gz` reads nothing: its one item is `name` without the trailing `.gz`.
 */
export async function listArchive(
  format: ArchiveFormat,
  name: string,
  readAt: ReadAt,
  options: { maxEntries: number; now: () => number },
): Promise<{ format: ArchiveFormat } & Walked> {
  if (format === "gz") {
    const entries: ArchiveEntry[] = [{ path: name.slice(0, -3), type: "file", size: null }];
    return { format, entries, truncated: false };
  }
  const expired = deadline(options.now);
  if (format === "tar") {
    return { format, ...(await walk(positionalSource(readAt), options.maxEntries, expired)) };
  }
  const source = gunzipSource(readAt, expired);
  try {
    return { format, ...(await walk(source, options.maxEntries, expired)) };
  } finally {
    // Every way out — the cap, the deadline, corruption, a thrown error — releases the inflater.
    source.close();
  }
}

/** True from `DEADLINE_MS` after this call on, and it stays true whatever the clock does next. */
function deadline(now: () => number): Expired {
  const start = now();
  let passed = false;
  return () => {
    passed ||= now() - start >= DEADLINE_MS;
    return passed;
  };
}

/** The cap and the clock are checked before each header is read; a header that was read is listed. */
async function walk(source: ByteSource, maxEntries: number, expired: Expired): Promise<Walked> {
  const entries: ArchiveEntry[] = [];
  const pending: PendingNames = { pax: null, gnu: null };
  try {
    while (entries.length < maxEntries && !expired()) {
      const header = parseHeader(await source.read(BLOCK));
      if (header === null) {
        return { entries, truncated: false };
      }
      await source.skip(await takeHeader(source, header, pending, entries));
    }
  } catch (error) {
    if (!(error instanceof CorruptArchive)) {
      throw error;
    }
    // A tar.gz read cut short by the deadline arrives here as well: that is the time limit, not
    // an archive nothing can be read from.
    if (entries.length === 0 && !expired()) {
      throw new HttpError("preview_unsupported");
    }
  }
  return { entries, truncated: true };
}

/**
 * Reads what an extension header carries, or lists the member. Returns how many bytes after the
 * header are left to step over: a member's body, or a `g` / `K` record that is of no use here.
 */
async function takeHeader(
  source: ByteSource,
  header: Header,
  pending: PendingNames,
  entries: ArchiveEntry[],
): Promise<number> {
  switch (header.typeflag) {
    case TYPE_GNU_LONG_NAME:
      pending.gnu = memberName(untilNul(await readExtension(source, header.size)));
      return 0;
    case TYPE_PAX:
      pending.pax = paxPath(await readExtension(source, header.size));
      return 0;
    case TYPE_PAX_GLOBAL:
    case TYPE_GNU_LONG_LINK:
      return padded(header.size);
    default:
      entries.push({
        path: pending.pax ?? pending.gnu ?? header.name,
        type: header.typeflag === TYPE_DIRECTORY ? "dir" : "file",
        size: header.size,
      });
      pending.pax = null;
      pending.gnu = null;
      return padded(header.size);
  }
}

function padded(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

/** The declared size is judged before anything is read; `padded(65536)` is still 65536. */
async function readExtension(source: ByteSource, size: number): Promise<Buffer> {
  if (size > MAX_EXTENSION_BYTES) {
    throw new CorruptArchive();
  }
  const data = await source.read(padded(size));
  if (data.length < size) {
    throw new CorruptArchive();
  }
  return data.subarray(0, size);
}

/** Null for the all-zero block that ends an archive. */
function parseHeader(block: Buffer): Header | null {
  if (block.length < BLOCK) {
    throw new CorruptArchive();
  }
  if (block.every((byte) => byte === 0)) {
    return null;
  }
  if (parseOctal(block.subarray(148, 156)) !== checksum(block)) {
    throw new CorruptArchive();
  }
  return {
    name: headerName(block),
    typeflag: block.readUInt8(156),
    size: parseOctal(block.subarray(124, 136)),
  };
}

/** The unsigned sum of the header's bytes with the checksum field itself counted as eight spaces. */
function checksum(block: Buffer): number {
  let sum = 8 * SPACE;
  for (const byte of block.subarray(0, 148)) {
    sum += byte;
  }
  for (const byte of block.subarray(156)) {
    sum += byte;
  }
  return sum;
}

/** Octal digits up to the first NUL, spaces around them allowed. Base-256 and an empty field are corruption. */
function parseOctal(field: Buffer): number {
  const text = untilNul(field).toString("latin1").trim();
  if (!OCTAL.test(text)) {
    throw new CorruptArchive();
  }
  return Number.parseInt(text, 8);
}

/** `prefix/name` at most 256 bytes, so it never reaches `MAX_NAME_BYTES`. */
function headerName(block: Buffer): string {
  const name = untilNul(block.subarray(0, 100)).toString("utf8");
  if (block.subarray(257, 263).toString("latin1") !== USTAR_MAGIC) {
    return name;
  }
  const prefix = untilNul(block.subarray(345, 500)).toString("utf8");
  return prefix === "" ? name : `${prefix}/${name}`;
}

function untilNul(bytes: Buffer): Buffer {
  const end = bytes.indexOf(0);
  return end === -1 ? bytes : bytes.subarray(0, end);
}

/** A name from an extension record; invalid UTF-8 becomes U+FFFD. */
function memberName(bytes: Buffer): string {
  if (bytes.length > MAX_NAME_BYTES) {
    throw new CorruptArchive();
  }
  return bytes.toString("utf8");
}

/** The last `path` record of a pax extended header, or null when it has none. */
function paxPath(data: Buffer): string | null {
  let path: string | null = null;
  let offset = 0;
  while (offset < data.length) {
    const record = paxRecord(data, offset);
    if (record.key === "path") {
      path = memberName(record.value);
    }
    offset = record.end;
  }
  return path;
}

/** One `LEN key=value\n` at `offset`; LEN counts the whole record in bytes. `end` is always past `offset`. */
function paxRecord(data: Buffer, offset: number): { key: string; value: Buffer; end: number } {
  const space = data.indexOf(SPACE, offset);
  if (space === -1) {
    throw new CorruptArchive();
  }
  const length = data.subarray(offset, space).toString("latin1");
  const end = DECIMAL.test(length) ? offset + Number(length) : Number.NaN;
  const equals = data.indexOf(EQUALS, space + 1);
  // NaN fails every comparison below, so a non-decimal length is refused here as well.
  if (!(equals !== -1 && equals < end - 1 && end <= data.length)) {
    throw new CorruptArchive();
  }
  if (data.readUInt8(end - 1) !== NEWLINE) {
    throw new CorruptArchive();
  }
  return {
    key: data.subarray(space + 1, equals).toString("latin1"),
    value: data.subarray(equals + 1, end - 1),
    end,
  };
}

/** An uncompressed tar: stepping over a body moves the position and reads nothing. */
function positionalSource(readAt: ReadAt): ByteSource {
  let position = 0;
  return {
    async read(length) {
      const data = await readAt(position, length);
      position += data.length;
      return data;
    },
    skip(length) {
      position += length;
      return Promise.resolve();
    },
  };
}

/**
 * A tar.gz. Nothing runs in the background: compressed bytes are fetched with `readAt` and fed to
 * the inflater only when the walk asks for more, one `FEED_BYTES` slice at a time, and the next
 * slice waits until this one is consumed. What is held is therefore what one slice inflates to
 * (deflate tops out near 1032:1, about 1 MiB) plus what the walk asked for (at most 65536 bytes).
 * A gunzip error ends the data: what earlier slices inflated is still handed out (zlib gives
 * nothing for the slice the error is in), and the walk then meets a short read — corruption.
 */
function gunzipSource(readAt: ReadAt, expired: Expired): ByteSource & { close(): void } {
  const gunzip = createGunzip();
  // Errors are taken from the write / end callbacks; this keeps them from being uncaught events.
  gunzip.on("error", () => {});
  let incoming: Buffer[] = [];
  let available = 0;
  gunzip.on("data", (chunk: Buffer) => {
    incoming.push(chunk);
    available += chunk.length;
  });
  let rest: Buffer = Buffer.alloc(0);
  let input: Buffer = Buffer.alloc(0);
  let position = 0;
  let ended = false;

  /** Feeds one slice, or ends the stream when the file has no more; a `readAt` failure is thrown as it is. */
  async function fill(): Promise<void> {
    if (input.length === 0) {
      input = await readAt(position, MAX_EXTENSION_BYTES);
      position += input.length;
    }
    const slice = input.subarray(0, FEED_BYTES);
    input = input.subarray(FEED_BYTES);
    if (slice.length === 0) {
      await settled(gunzip, (done) => gunzip.end(done));
      ended = true;
      return;
    }
    // An errored stream is destroyed and takes no further call.
    ended = !(await settled(gunzip, (done) => gunzip.write(slice, done)));
  }

  /** Removes and returns up to `length` inflated bytes. */
  function take(length: number): Buffer {
    if (rest.length < length) {
      rest = Buffer.concat([rest, ...incoming]);
      incoming = [];
    }
    const taken = rest.subarray(0, length);
    rest = rest.subarray(length);
    available -= taken.length;
    return taken;
  }

  return {
    async read(length) {
      // Compressed input can go on for long without inflating to anything: the clock is read here
      // too. The walk takes the short block as the end of what could be read in time.
      while (available < length && !ended && !expired()) {
        await fill();
      }
      return take(length);
    },
    async skip(length) {
      let left = length - take(length).length;
      while (left > 0 && !ended && !expired()) {
        await fill();
        left -= take(left).length;
      }
    },
    close() {
      gunzip.destroy();
    },
  };
}

/**
 * Runs one stream call that reports through a callback and says whether it went through. The
 * 'close' of the stream settles it too, so a callback that is never invoked cannot hold the walk.
 */
function settled(
  gunzip: Gunzip,
  call: (done: (error?: Error | null) => void) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const closed = () => resolve(false);
    gunzip.once("close", closed);
    call((error) => {
      gunzip.off("close", closed);
      resolve(!error);
    });
  });
}
