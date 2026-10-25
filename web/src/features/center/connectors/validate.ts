import type { ConnectorView, CreateConnectorInput, UpdateConnectorInput } from "@/lib/api";

/**
 * 连接器表单的值、客户端校验与「表单 / 视图 → 请求」的映射（connectors「中心「连接器」tab」「连接器取值规则」，
 * s1d-connectors 任务 6.3）。校验与服务端 `server/src/connectors/validate.ts` 同一份常量，文案点名具体原因；以下
 * 只由服务端判定（其 400 的固定文案在对话框内就地显示）：值恰为 `OMP_CHILD_ENV_NAMES` 成员（名单在 server 侧，web
 * 不复制）、请求头名 / 值的合法性、第 33 个连接器。
 */

/** 一行键值对：`existing` 为编辑时视图里已有的键（键名只读，值留空 = 保留现有值）。 */
export type Entry = { key: string; value: string; existing: boolean };

export type ConnectorFormValues = {
  name: string;
  type: "stdio" | "http";
  description: string;
  command: string;
  /** 参数 textarea 原文：每行一个。 */
  args: string;
  env: Entry[];
  url: string;
  headers: Entry[];
};

type Field = "name" | "description" | "command" | "args" | "env" | "url" | "headers";
export type FieldErrors = Partial<Record<Field, string>>;

const NAME = /^[a-z]{1,32}$/u;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/u;
/** 与服务端 `UPSTREAM_BASE_URL` 同一正则（`models/validate.ts` 的 `BASE_URL`）。 */
const URL_RULE = /^https?:\/\/[^\s#@]+$/u;
const MAX_DESCRIPTION_POINTS = 200;
const MAX_COMMAND_BYTES = 1024;
const MAX_ARGS = 32;
const MAX_ARG_POINTS = 1024;
const MAX_ENTRIES = 32;
const MAX_ENV_VALUE_POINTS = 4096;

const MESSAGES = {
  name: "名称需为 1–32 个小写字母",
  description: `描述不能超过 ${MAX_DESCRIPTION_POINTS} 个字符`,
  commandPath: "命令需为以 / 开头的绝对路径",
  commandBytes: `命令不能超过 ${MAX_COMMAND_BYTES} 字节`,
  commandControl: "命令不能含控制字符",
  argsCount: `参数至多 ${MAX_ARGS} 项`,
  argLength: `每项参数不能超过 ${MAX_ARG_POINTS} 个字符`,
  envCount: `环境变量至多 ${MAX_ENTRIES} 个`,
  envKey: "变量名需为大写字母、数字或下划线（不以数字开头，至多 64 个字符）",
  envValue: `变量值需为 1–${MAX_ENV_VALUE_POINTS} 个字符`,
  envDuplicate: "变量名重复",
  url: "地址需以 http:// 或 https:// 开头，且不含空白、# 或 @",
  headersCount: `请求头至多 ${MAX_ENTRIES} 个`,
  headerDuplicate: "请求头名重复",
} as const;

const points = (text: string) => [...text].length;

/** U+0000–U+001F 与 U+007F。 */
function hasControl(text: string): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

/** omp 会改写的两种写法：以 `!` 开头（执行命令）与含 `${`（插值）。 */
function rewritten(label: string, value: string): string | null {
  if (value.startsWith("!")) return `${label}不能以 ! 开头`;
  return value.includes("${") ? `${label}不能含 \${` : null;
}

/** 参数 textarea → 数组：空串为 `[]`，否则按 `\n` 精确拆分（不修剪）。 */
export function argsOf(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

const existingEntries = (keys: readonly string[] | null): Entry[] =>
  (keys ?? []).map((key) => ({ key, value: "", existing: true }));

/** 打开对话框时的初值：新增全空、类型 stdio；编辑取视图，已有键的值恒为空。 */
export function initialValues(opened: ConnectorView | null): ConnectorFormValues {
  return {
    name: opened?.name ?? "",
    type: opened?.type ?? "stdio",
    description: opened?.description ?? "",
    command: opened?.command ?? "",
    args: (opened?.args ?? []).join("\n"),
    env: existingEntries(opened?.envKeys ?? null),
    url: opened?.url ?? "",
    headers: existingEntries(opened?.headerKeys ?? null),
  };
}

function commandProblem(command: string): string | null {
  const literal = rewritten("命令", command);
  if (literal) return literal;
  if (!command.startsWith("/")) return MESSAGES.commandPath;
  if (new TextEncoder().encode(command).length > MAX_COMMAND_BYTES) return MESSAGES.commandBytes;
  return hasControl(command) ? MESSAGES.commandControl : null;
}

function argsProblem(text: string): string | null {
  const args = argsOf(text);
  if (args.length > MAX_ARGS) return MESSAGES.argsCount;
  for (const arg of args) {
    const literal = rewritten("参数", arg);
    if (literal) return literal;
    if (points(arg) > MAX_ARG_POINTS) return MESSAGES.argLength;
  }
  return null;
}

/** 键值对共有的检查：个数、重复键名、值的两种改写写法；`entry` 是该类型自己的键 / 值检查。 */
function entriesProblem(
  entries: readonly Entry[],
  kind: "env" | "headers",
  entry: (item: Entry) => string | null,
): string | null {
  const env = kind === "env";
  if (entries.length > MAX_ENTRIES) return env ? MESSAGES.envCount : MESSAGES.headersCount;
  if (new Set(entries.map((item) => item.key)).size !== entries.length) {
    return env ? MESSAGES.envDuplicate : MESSAGES.headerDuplicate;
  }
  for (const item of entries) {
    // 已有键留空 = 保留现有值，不校验。
    if (item.existing && item.value === "") continue;
    const problem = entry(item) ?? rewritten(env ? "变量值" : "请求头值", item.value);
    if (problem) return problem;
  }
  return null;
}

function envEntryProblem({ key, value }: Entry): string | null {
  if (!ENV_KEY.test(key)) return MESSAGES.envKey;
  return value === "" || points(value) > MAX_ENV_VALUE_POINTS ? MESSAGES.envValue : null;
}

/** 逐字段校验；`opened` 为 null 是新增，否则是编辑（名称与类型只读、不校验名称）。只校验所选类型的字段。 */
export function validateConnectorForm(
  values: ConnectorFormValues,
  opened: ConnectorView | null,
): FieldErrors {
  const found: [Field, string | null][] = [
    ["name", opened === null && !NAME.test(values.name) ? MESSAGES.name : null],
    [
      "description",
      points(values.description) > MAX_DESCRIPTION_POINTS ? MESSAGES.description : null,
    ],
  ];
  if (values.type === "stdio") {
    found.push(
      ["command", commandProblem(values.command)],
      ["args", argsProblem(values.args)],
      ["env", entriesProblem(values.env, "env", envEntryProblem)],
    );
  } else {
    found.push(
      ["url", rewritten("地址", values.url) ?? (URL_RULE.test(values.url) ? null : MESSAGES.url)],
      ["headers", entriesProblem(values.headers, "headers", () => null)],
    );
  }
  return Object.fromEntries(found.filter(([, problem]) => problem !== null));
}

const record = (entries: readonly Entry[]) =>
  Object.fromEntries(entries.map(({ key, value }) => [key, value]));

/** 新增只发碰过的键：描述非空才发、参数非空才发、有键值对才发；`enabled` 不发（缺省启用）。 */
export function toCreateInput(values: ConnectorFormValues): CreateConnectorInput {
  const description = values.description === "" ? {} : { description: values.description };
  if (values.type === "stdio") {
    const args = argsOf(values.args);
    return {
      name: values.name,
      type: "stdio",
      ...description,
      command: values.command,
      ...(args.length > 0 ? { args } : {}),
      ...(values.env.length > 0 ? { env: record(values.env) } : {}),
    };
  }
  return {
    name: values.name,
    type: "http",
    ...description,
    url: values.url,
    ...(values.headers.length > 0 ? { headers: record(values.headers) } : {}),
  };
}

/** 整体替换 body 里由调用方改过的部分；`entries` 是该类型键值对的新值（已有键或新键）。 */
export type UpdateOverrides = {
  description?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  entries?: Readonly<Record<string, string>>;
};

/**
 * 由管理员视图构造整体替换的 `PUT` body（`启用` 开关与编辑对话框共用）：总是发 `description`、`enabled` 与该类型的
 * 全部键；未改的取视图（`args` 缺省 `[]`），`envKeys` / `headerKeys` 的每个键为 `null`（保留现有值），除非
 * `entries` 给了新值。
 */
export function toUpdateInput(
  view: ConnectorView,
  overrides: UpdateOverrides,
): UpdateConnectorInput {
  const description = overrides.description ?? view.description;
  const enabled = overrides.enabled ?? view.enabled;
  const kept = (keys: readonly string[] | null) => ({
    ...Object.fromEntries((keys ?? []).map((key): [string, string | null] => [key, null])),
    ...overrides.entries,
  });
  if (view.type === "stdio") {
    return {
      description,
      command: overrides.command ?? view.command ?? "",
      args: overrides.args ?? view.args ?? [],
      env: kept(view.envKeys),
      enabled,
    };
  }
  return {
    description,
    url: overrides.url ?? view.url ?? "",
    headers: kept(view.headerKeys),
    enabled,
  };
}

/** 编辑对话框的改动：填了值的已有键与全部新键进 `entries`，留空的已有键不进（由 `toUpdateInput` 置 null）。 */
export function editOverrides(values: ConnectorFormValues): UpdateOverrides {
  const entries = values.type === "stdio" ? values.env : values.headers;
  return {
    description: values.description,
    command: values.command,
    args: argsOf(values.args),
    url: values.url,
    entries: record(entries.filter((item) => !item.existing || item.value !== "")),
  };
}

/**
 * 保存后是否紧接着探活：保存后的视图是 http，且新增、或地址与打开对话框时的视图不同、或请求头有改动（填了已有键的
 * 新值或加了新键）。stdio 与只改描述都不探活。
 */
export function probesAfterSave(
  saved: ConnectorView,
  opened: ConnectorView | null,
  values: ConnectorFormValues,
): boolean {
  if (saved.type !== "http") return false;
  if (opened === null) return true;
  return (
    saved.url !== opened.url || values.headers.some((item) => !item.existing || item.value !== "")
  );
}
