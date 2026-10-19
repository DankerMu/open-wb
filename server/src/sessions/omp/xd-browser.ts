/**
 * Issue #1526 (omp-browser-integration design D5): omp v18.0.10 calls its non-top-level `browser`
 * tool through `write` to the virtual path `xd://browser`, the JSON arguments in `content`. This pure
 * module (no IO) judges the path and describes the call for the approval card, the step and the
 * `session.browser` audit (browser-runtime「浏览器操作的可读描述」). Both rules are ported from omp and
 * SHALL be re-checked on an omp upgrade (its bundled Bun 1.4.0 URL parser was not run here): the path
 * as `tools/plan-mode-guard.ts:57-74` unwraps it, the untrimmed scheme test (`tools/write.ts:1141`,
 * `internal-urls/router.ts:80`), `new URL()` (`parse.ts:59`) and its `href`'s device (`xd-protocol.ts:41`);
 * the content as `tools/write.ts:332-363` strips it (`hashline/src/prefixes.ts`) before `JSON.parse`.
 */
import { asPlain, own } from "../file-changes.js";

type Texts = "name" | "url" | "code" | "path" | "cdpUrl";
/** The parsed arguments (`path`, `args`, `cdpUrl`, `relay` are `app.*`): own, well-typed ones only. */
export type BrowserCall = { action: string; args?: string[] } & Partial<
  Record<Texts, string> & Record<"all" | "kill" | "relay", boolean>
>;

/** The `session.browser` audit fields (browser-runtime「浏览器调用审计」). */
export interface BrowserAudit {
  action: string | null;
  url: string | null;
  external: { path?: string; args?: string[]; cdpUrl?: string; relay?: true } | null;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const HEADER_TAG = /#[0-9A-Fa-f]{4}$/u;

/** omp's `[P]` / `[P#XXXX]` unwrap of a write path: never trims the start. */
function unwrapHeaderPath(path: string): string {
  const trimmed = path.trimEnd();
  if (trimmed.length < 2 || !trimmed.startsWith("[") || !trimmed.endsWith("]")) return path;
  const inner = trimmed.slice(1, -1);
  const tag = HEADER_TAG.exec(inner);
  const part = tag === null ? inner : inner.slice(0, tag.index);
  return part.length === 0 || part.includes("#") ? path : part;
}

/** True iff omp's write dispatch routes `raw` to the `browser` device. */
export function isBrowserDevicePath(raw: string): boolean {
  const path = unwrapHeaderPath(raw);
  if (!SCHEME.test(path) || !URL.canParse(path)) return false;
  const { href } = new URL(path);
  return href.slice(0, 5).toLowerCase() === "xd://" && href.slice(5) === "browser";
}

// hashline/src/prefixes.ts (HL_FILE_HASH_LENGTH = 4) and write.ts LOOSE_HASHLINE_HEADER_RE, verbatim.
const HL_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:[+*-]\s*)?\d+[:|]/;
const HL_HEADER_RE = /^\s*\[[^#\r\n]+#[0-9a-fA-F]{4}\]\s*$/;
const LOOSE_HEADER_RE = /^\s*\[[^#\r\n]+#[^ \t\r\n]*\]\s*$/;
// `isReadMetadataLine`: READ_TRUNCATION_NOTICE_RE, READ_RANGE_ELISION_RE, READ_SINGLE_ELISION_RE.
const READ_METADATA = [
  /^\s*\[(?:(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bUse :L?\d+|(?:…|\.\.\.)?\d+\s*ln elided;\s*re-read needed ranges with .+)\]\s*$/,
  /^\s*[1-9]\d*\s*-\s*[1-9]\d*:.*(?:…|\.\.\.).*$/,
  /^\s*(?:…|\.\.\.)\s*$/,
];
const isReadMetadataLine = (line: string) => READ_METADATA.some((re) => re.test(line));

/** `stripLeadingHashlinePrefixes`: removes the prefix until none is left. */
function stripLeadingPrefixes(line: string): string {
  let result = line;
  for (let previous = ""; previous !== result; ) {
    previous = result;
    result = result.replace(HL_PREFIX_RE, "");
  }
  return result;
}

/** Strict `stripHashlinePrefixes`: undefined when it strips nothing (omp returns the same array). */
function stripHashline(lines: string[]): string[] | undefined {
  let [nonEmpty, headers, prefixed] = [0, 0, 0];
  for (const line of lines) {
    if (line.length === 0 || isReadMetadataLine(line)) continue;
    nonEmpty += 1;
    if (HL_HEADER_RE.test(line)) headers += 1;
    else if (HL_PREFIX_RE.test(line)) prefixed += 1;
  }
  const content = nonEmpty - headers;
  if (content === 0 || prefixed !== content) return undefined;
  return lines
    .filter((line) => !isReadMetadataLine(line) && !HL_HEADER_RE.test(line))
    .map(stripLeadingPrefixes);
}

/** `stripWriteContentWithPotentialLooseHeader`: the stripped text, undefined when nothing changed. */
function stripWriteContent(text: string): string | undefined {
  const lines = text.split("\n");
  const strict = stripHashline(lines);
  if (strict !== undefined) return strict.join("\n");
  const header = lines.findIndex((line) => line.trim().length > 0);
  if (header === -1 || !LOOSE_HEADER_RE.test(lines[header] ?? "")) return undefined;
  return stripHashline([...lines.slice(0, header), ...lines.slice(header + 1)])?.join("\n");
}

/** The raw text, else its hashline-stripped form; the first that parses as browser arguments. */
export function parseBrowserContent(text: unknown): BrowserCall | undefined {
  if (typeof text !== "string") return undefined;
  return toCall(parseJson(text)) ?? toCall(parseJson(stripWriteContent(text)));
}

/** The parsed value; undefined (never a JSON value) when `text` is absent or not JSON. */
function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "") as unknown;
  } catch {
    return undefined;
  }
}

function toCall(value: unknown): BrowserCall | undefined {
  const record = asPlain(value);
  const action = record === undefined ? undefined : text(own(record, "action"));
  if (record === undefined || action === undefined) return undefined;
  const app = asPlain(own(record, "app")) ?? {};
  const args = own(app, "args");
  const valid = Array.isArray(args) && args.length > 0 && args.every((a) => typeof a === "string");
  return compact<BrowserCall>({
    action,
    name: text(own(record, "name")),
    url: text(own(record, "url")),
    code: text(own(record, "code")),
    all: flag(own(record, "all")),
    kill: flag(own(record, "kill")),
    path: text(own(app, "path")),
    args: valid ? [...(args as string[])] : undefined,
    cdpUrl: text(own(app, "cdp_url")),
    relay: flag(own(app, "relay")),
  });
}

/** Drops the absent (undefined) keys, so the object holds only what is present. */
function compact<T>(value: { [K in keyof T]-?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
/** CR, LF, U+2028 and U+2029 each become one space: an inserted value never breaks its line. */
const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]/gu, " ");

/** The one summary line; `浏览器操作` when the arguments did not parse. */
export function browserSummary(call: BrowserCall | undefined): string {
  if (call === undefined) return "浏览器操作";
  const tab = `标签页 ${oneLine(call.name ?? "main")}`;
  const kill = call.kill === true ? "并结束外部浏览器" : "";
  switch (call.action) {
    case "open":
      return `浏览器：打开${call.url === undefined ? tab : ` ${oneLine(call.url)}`}`;
    case "run":
      return `浏览器：在${tab} 执行脚本`;
    case "close":
      return `浏览器：关闭${call.all === true ? "全部标签页" : tab}${kill}`;
    default:
      return `浏览器：${oneLine(call.action)}`;
  }
}

/** Zero to three ⚠ lines: external program (with its args), external browser, relay. */
export function browserFlags(call: BrowserCall | undefined): string[] {
  const lines: string[] = [];
  if (call?.path !== undefined) {
    const args = call.args === undefined ? "" : ` 参数 ${JSON.stringify(call.args.map(oneLine))}`;
    lines.push(`⚠ 启动外部程序：${oneLine(call.path)}${args}`);
  }
  if (call?.cdpUrl !== undefined) lines.push(`⚠ 连接外部浏览器：${oneLine(call.cdpUrl)}`);
  if (call?.relay === true) lines.push("⚠ 经中继连接用户自己的浏览器");
  return lines;
}

export function browserAuditFields(call: BrowserCall | undefined): BrowserAudit {
  if (call === undefined) return { action: null, url: null, external: null };
  const { path, args, cdpUrl } = call;
  const relay = call.relay === true ? (true as const) : undefined;
  const external = compact<NonNullable<BrowserAudit["external"]>>({ path, args, cdpUrl, relay });
  return {
    action: call.action,
    url: call.url ?? null,
    external: Object.keys(external).length === 0 ? null : external,
  };
}

/**
 * A `write` start whose own `args.path` is the browser device: the detail's head (summary, flags),
 * `args.content` parsed as JSON (undefined unless a string holding JSON) and the audit fields.
 */
export type BrowserStart = { head: string[]; json: unknown; browser: BrowserAudit };

export function browserStart(args: unknown): BrowserStart | undefined {
  const record = asPlain(args) ?? {};
  const path = own(record, "path");
  if (typeof path !== "string" || !isBrowserDevicePath(path)) return undefined;
  const content = own(record, "content");
  const call = parseBrowserContent(content);
  return {
    head: [browserSummary(call), ...browserFlags(call)],
    json: typeof content === "string" ? parseJson(content) : undefined,
    browser: browserAuditFields(call),
  };
}
