/**
 * Byte builders for the archive listing tests: tar blocks are written by hand here (no binary
 * fixture is committed, no tar library), and every archive is read back through a real file handle
 * whose `readAt` records the largest length it was asked for.
 */
import { writeFileSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { afterEach } from "vitest";
import { archiveFormat, listArchive } from "../src/workspaces/archive.js";
import { removeTempDirs, tempDir } from "./core-db-helpers.js";

const BLOCK = 512;
/** `ustar\0` + version `00` (POSIX); the GNU form is `ustar` + two spaces + NUL over the same 8 bytes. */
const POSIX_MAGIC = "ustar\u000000";
export const GNU_MAGIC = "ustar  \u0000";
/** The two zero blocks that end a tar. */
export const TAR_END = Buffer.alloc(2 * BLOCK);
/** What the recording `readAt` serves at most; a larger request is recorded, not allocated. */
const SERVED_AT_MOST = 1_048_576;

interface HeaderFields {
  name: string | Buffer;
  size?: number;
  /** One character: `0` file, `5` directory, `2` symlink, `L` / `K` GNU, `x` / `g` pax. */
  typeflag?: string;
  prefix?: string | Buffer;
  magic?: string;
  /** Raw bytes for the 12-byte size field, for the shapes octal cannot express. */
  rawSize?: Buffer;
}

function octal(value: number, digits: number): string {
  return `${value.toString(8).padStart(digits, "0")}\u0000`;
}

/** One 512-byte header with a valid checksum (unsigned sum, the checksum field counted as spaces). */
export function tarHeader(fields: HeaderFields): Buffer {
  const block = Buffer.alloc(BLOCK);
  Buffer.from(fields.name).copy(block, 0, 0, 100);
  block.write(octal(0o644, 7), 100, "latin1");
  block.write(octal(0, 7), 108, "latin1");
  block.write(octal(0, 7), 116, "latin1");
  block.write(octal(fields.size ?? 0, 11), 124, "latin1");
  fields.rawSize?.copy(block, 124, 0, 12);
  block.write(octal(0, 11), 136, "latin1");
  block.write(fields.typeflag ?? "0", 156, "latin1");
  block.write(fields.magic ?? POSIX_MAGIC, 257, "latin1");
  Buffer.from(fields.prefix ?? "").copy(block, 345, 0, 155);
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(`${octal(sum, 6)} `, 148, "latin1");
  return block;
}

/** A header whose size is the body's, then the body padded to whole blocks. */
export function tarFile(
  name: string | Buffer,
  body: string | Buffer = "",
  fields: Omit<HeaderFields, "name" | "size"> = {},
): Buffer {
  const data = Buffer.from(body);
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
  return Buffer.concat([tarHeader({ ...fields, name, size: data.length }), data, padding]);
}

/** One pax record `LEN key=value\n`; LEN is the decimal byte length of the whole record, itself included. */
export function paxRecord(key: string, value: string): string {
  const rest = Buffer.byteLength(` ${key}=${value}\n`);
  let length = rest + 1;
  while (String(length).length + rest !== length) {
    length += 1;
  }
  return `${length} ${key}=${value}\n`;
}

const handles: FileHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  removeTempDirs();
});

/**
 * Writes the archive into `dir` and opens it. `readAt` returns a short Buffer at the end of the
 * file; `maxLength()` is the largest `length` any call asked for and `positions` every `position`.
 */
export async function archiveOnDisk(
  name: string,
  bytes: Buffer,
  dir: string = tempDir(),
): Promise<{
  dir: string;
  readAt: (position: number, length: number) => Promise<Buffer>;
  maxLength: () => number;
  positions: number[];
}> {
  writeFileSync(join(dir, name), bytes);
  const handle = await open(join(dir, name), "r");
  handles.push(handle);
  let maxLength = 0;
  const positions: number[] = [];
  return {
    dir,
    async readAt(position, length) {
      maxLength = Math.max(maxLength, length);
      positions.push(position);
      const buffer = Buffer.alloc(Math.min(length, SERVED_AT_MOST));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      return buffer.subarray(0, bytesRead);
    },
    maxLength: () => maxLength,
    positions,
  };
}

export const DEFAULTS = { maxEntries: 1000, now: () => 0 };
export const UNSUPPORTED = { name: "HttpError", code: "preview_unsupported" };
/** The name GNU tar gives the header of an `L` / `K` record. */
export const LONG_LINK = "././@LongLink";
/** `a.txt` (5 bytes), `dir/`, `dir/b.md` (7 bytes): the archive of the spec's first scenario. */
export const THREE_MEMBERS = Buffer.concat([
  tarFile("a.txt", "hello"),
  tarFile("dir/", "", { typeflag: "5" }),
  tarFile("dir/b.md", "# title"),
  TAR_END,
]);

/** `count` empty files named `m0`, `m1`, …: one 512-byte header each. */
export function emptyMembers(count: number): Buffer[] {
  return Array.from({ length: count }, (_, index) => tarFile(`m${index}`));
}

/** Writes the archive to disk and lists it in the format its name gives. */
export async function list(name: string, bytes: Buffer, options = DEFAULTS) {
  const file = await archiveOnDisk(name, bytes);
  const format = archiveFormat(name);
  if (format === null) {
    throw new Error(`not an archive name: ${name}`);
  }
  return { file, listing: await listArchive(format, name, file.readAt, options) };
}

/** A clock that moves `step` milliseconds forward every time it is read. */
export function tickingClock(step: number): () => number {
  let clock = 0;
  return () => {
    clock += step;
    return clock;
  };
}
