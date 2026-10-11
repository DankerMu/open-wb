/**
 * Issue #1074: what the two `/o/` test files share — the recording converter stand-in, the bytes it
 * "converts" to, the spec's six failure texts, and the small request helpers.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, vi } from "vitest";
import { OfficeConvertError, type OfficeConverter } from "../src/preview/office.js";
import { tempDir } from "./core-db-helpers.js";
import {
  type Answer,
  expectNoSuccessHeaders,
  FAILURE_HEADERS,
  type PreviewWorld,
  WORKSPACE_A,
  ZHANGSAN,
} from "./preview-app-helpers.js";

/** A well-formed token nobody issued. */
export const UNKNOWN_TOKEN = "d".repeat(64);
/** What the stand-in "converted": not valid UTF-8 throughout, so equality is equality of bytes. */
export const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.from([0xff, 0xfe, 0x00, 0x89]),
  Buffer.from("\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"),
]);
export const DOCX_BYTES = "not a real office document";
/** office-preview 「办公文档预览路由」, the failure table, verbatim. */
export const TEXT = {
  unsupported: "该类型不支持转换",
  tooLarge: "文件超过预览上限，请下载后查看",
  unavailable: "服务器未启用文档转换，请下载后查看",
  busy: "文档转换繁忙，请稍后重试",
  failed: "文档转换失败，请下载后查看",
  timeout: "文档转换超时，请下载后查看",
} as const;

type Behave = (absInput: string, signal?: AbortSignal) => Promise<string>;

export interface StandIn extends OfficeConverter {
  convert: ReturnType<typeof vi.fn<Behave>>;
}

/** A cached PDF somewhere outside every workspace, as the real converter's `pdf/` is. */
function pdfFile(): string {
  const path = join(tempDir(), "0123abcd.pdf");
  writeFileSync(path, PDF_BYTES);
  return path;
}

/**
 * Records every call; converts by `behave`, to a fresh PDF when none is given. The caller's
 * `afterEach` removes the temp dirs (`removeTempDirs`).
 */
export function standIn(behave?: Behave, available = true): StandIn {
  const pdf = pdfFile();
  return {
    available,
    convert: vi.fn<Behave>(behave ?? (() => Promise.resolve(pdf))),
    close: () => Promise.resolve(),
  };
}

export function failing(kind: ConstructorParameters<typeof OfficeConvertError>[0]): StandIn {
  return standIn(() => Promise.reject(new OfficeConvertError(kind)));
}

export async function tokenForA(world: PreviewWorld): Promise<string> {
  return (await world.issueToken(world.zhangsan, WORKSPACE_A)).token;
}

/** Writes a file into workspace A: the given text, or that many bytes. */
export function seed(
  world: PreviewWorld,
  name: string,
  bytes: string | number = DOCX_BYTES,
): string {
  const path = join(world.root, name);
  writeFileSync(path, typeof bytes === "number" ? Buffer.alloc(bytes, 0x61) : bytes);
  return path;
}

export function get(world: PreviewWorld, target: string, headers: Record<string, string> = {}) {
  return fetch(`${world.origin}${target}`, { headers });
}

export async function bytesOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

/**
 * A failure of `/o/`: the status, the fixed text and nothing else in the body, the four failure
 * headers, and none of the headers a success carries.
 */
export function expectOfficeFailure(
  answer: Answer,
  status: number,
  text: string,
  label = "",
): void {
  expect(answer.status, label).toBe(status);
  expect(answer.body, label).toBe(text);
  expect(answer.headers, label).toMatchObject(FAILURE_HEADERS);
  expect(answer.headers["content-length"], label).toBe(String(Buffer.byteLength(text)));
  expectNoSuccessHeaders(answer);
}

export function rejectOf(relPath: string) {
  return { actor_id: ZHANGSAN, workspace_id: WORKSPACE_A, op: "read", rel_path: relPath };
}

export async function until(condition: () => boolean, what: string): Promise<void> {
  const deadlineAt = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > deadlineAt) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(5);
  }
}
