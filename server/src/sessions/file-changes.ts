/**
 * Issue #515 pure file-change candidates from omp edit/write tool_execution_end `result.details`.
 * Paths stay raw; resolution, workspace containment, caps and persistence belong to the supervisor.
 */

/** One file of a `files.changed` event: `added`/`removed` are counts for edit, null for write. */
export interface FileChange {
  path: string;
  added: number | null;
  removed: number | null;
  kind: "edit" | "write";
}

type Plain = Record<string, unknown>;

// omp 编号 diff 行：`+N|text` / `-N|text` / ` N|text`（edit/diff.ts formatNumberedDiffLine）。
const ADDED_LINE = /^\+\d+\|/;
const REMOVED_LINE = /^-\d+\|/;

/** 按 `\n` 切分，只计行首 `+<数字>|` 与 `-<数字>|`；上下文行与其余行不计，CRLF 的 `\r` 留在行尾无碍。 */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (ADDED_LINE.test(line)) {
      added += 1;
    } else if (REMOVED_LINE.test(line)) {
      removed += 1;
    }
  }
  return { added, removed };
}

/**
 * 登记名为 `edit`/`write`、`result` 与 `details` 皆为普通对象且 `result.isError` 不为 true 时产出候选；
 * 其它工具（含 ast_edit、bash）恒为空。所有键只读自有属性，不走原型链；返回值均为新建对象。
 */
export function fileChangeCandidates(toolName: string, result: unknown): FileChange[] {
  const record = asPlain(result);
  if (record === undefined || own(record, "isError") === true) {
    return [];
  }
  const details = asPlain(own(record, "details"));
  if (details === undefined) {
    return [];
  }
  if (toolName === "edit") {
    return editCandidates(details);
  }
  if (toolName === "write") {
    const path = nonemptyString(own(details, "resolvedPath"));
    return path === undefined ? [] : [{ path, added: null, removed: null, kind: "write" }];
  }
  return [];
}

/** 非空 `perFileResults` 优先且逐项（无效项跳过、不回落顶层）；否则取顶层 `path`+`diff`。 */
function editCandidates(details: Plain): FileChange[] {
  const perFile = own(details, "perFileResults");
  if (!Array.isArray(perFile) || perFile.length === 0) {
    const single = editCandidate(details);
    return single === undefined ? [] : [single];
  }
  const files: FileChange[] = [];
  for (let index = 0; index < perFile.length; index += 1) {
    const change = Object.hasOwn(perFile, index) ? editCandidate(perFile[index]) : undefined;
    if (change !== undefined) {
      files.push(change);
    }
  }
  return files;
}

function editCandidate(value: unknown): FileChange | undefined {
  const record = asPlain(value);
  if (record === undefined) {
    return undefined;
  }
  const path = nonemptyString(own(record, "path"));
  const diff = own(record, "diff");
  if (path === undefined || typeof diff !== "string") {
    return undefined;
  }
  return { path, ...countDiffLines(diff), kind: "edit" };
}

function own(record: Plain, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function asPlain(value: unknown): Plain | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Plain)
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
