/**
 * connectors/validate — the connector value rules (s1d-connectors design D2, D3; connectors「连接器取值
 * 规则」). The store's only way in: every write body passes `parseCreate` / `parseUpdate` here.
 *
 * The rules make every string written to the managed `mcp.json` reach omp literally: omp runs a value
 * starting with `!` as a shell command, interpolates `${…}` across the whole file, and replaces an `env`
 * / `headers` value that is exactly the name of one of its environment variables with that variable's
 * value. So `command`, each `args` item, `env` values, `url` and `headers` values never start with `!` or
 * contain `${`, and `env` / `headers` values are never exactly an `OMP_CHILD_ENV_NAMES` member.
 *
 * Key sets are strict per type (the other type's keys or any unknown key are refused); `name` and `type`
 * are create-only. Every refusal is the fixed-message `bad_request`: no field named, no value echoed;
 * Node's header-check errors (which quote the header) are caught and never passed on. Lengths count code
 * points except `command` (UTF-8 bytes).
 */
import { validateHeaderName, validateHeaderValue } from "node:http";
import { validateUpstreamBaseUrl } from "../agent-config.js";
import { HttpError } from "../core/errors/index.js";
import { OMP_CHILD_ENV_NAMES } from "../sessions/omp/spawn-env.js";

/** The most connectors, and the most items of a connector-name list (counted before deduplication). */
export const MAX_CONNECTORS = 32;

const NAME = /^[a-z]{1,32}$/u;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const MAX_DESCRIPTION_POINTS = 200;
const MAX_COMMAND_BYTES = 1024;
const MAX_ARGS = 32;
const MAX_ARG_POINTS = 1024;
const MAX_ENTRIES = 32;
const MAX_ENV_VALUE_POINTS = 4096;

type Entries = Readonly<Record<string, string>>;

/** A connector's resolved values (credentials included); `env` / `headers` keys in sorted order. */
export type ConnectorFields =
  | {
      type: "stdio";
      description: string;
      enabled: boolean;
      command: string;
      args: readonly string[];
      env: Entries;
    }
  | { type: "http"; description: string; enabled: boolean; url: string; headers: Entries };

const KEYS = {
  stdio: ["description", "enabled", "command", "args", "env"],
  http: ["description", "enabled", "url", "headers"],
} as const;

/** D2: 1..32 lowercase letters — the server name omp sees, with no `_` or digit to fold. */
function isConnectorName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

/**
 * A connector-name list (account defaults, session lists): an array of at most 32 items, each a
 * connector name, else `bad_request`; returns it deduplicated in dictionary order. Names need not be
 * registered.
 */
export function normalizeConnectorNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONNECTORS || !value.every(isConnectorName)) {
    fail();
  }
  return [...new Set(value as readonly string[])].sort();
}

/** POST body: `{name, type, description?, …that type's keys, enabled?}`; a `null` value is refused. */
export function parseCreate(body: unknown): { name: string; fields: ConnectorFields } {
  const record = object(body);
  const { name, type } = record;
  if (!isConnectorName(name) || (type !== "stdio" && type !== "http")) {
    fail();
  }
  onlyKeys(record, ["name", "type", ...KEYS[type]]);
  return { name, fields: parseFields(record, type, {}) };
}

/**
 * PUT body: whole replacement of `existing` (same type; no `name` or `type` key). An omitted key takes
 * the POST default; an `env` / `headers` value of `null` keeps that key's existing value, and a `null`
 * for a key `existing` lacks is refused.
 */
export function parseUpdate(body: unknown, existing: ConnectorFields): ConnectorFields {
  const record = object(body);
  onlyKeys(record, KEYS[existing.type]);
  const kept = existing.type === "stdio" ? existing.env : existing.headers;
  return parseFields(record, existing.type, kept);
}

function parseFields(
  record: Record<string, unknown>,
  type: ConnectorFields["type"],
  kept: Entries,
): ConnectorFields {
  const description = descriptionOf(record.description);
  const enabled = enabledOf(record.enabled);
  if (type === "stdio") {
    return {
      type,
      description,
      enabled,
      command: commandOf(record.command),
      args: argsOf(record.args),
      env: entriesOf(record.env, kept, envEntry),
    };
  }
  return {
    type,
    description,
    enabled,
    url: urlOf(record.url),
    headers: entriesOf(record.headers, kept, headerEntry),
  };
}

function descriptionOf(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || points(value) > MAX_DESCRIPTION_POINTS) {
    fail();
  }
  return value;
}

function enabledOf(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    fail();
  }
  return value;
}

/** An absolute path, ≤1024 UTF-8 bytes, no U+0000–U+001F or U+007F. */
function commandOf(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    Buffer.byteLength(value, "utf8") > MAX_COMMAND_BYTES ||
    hasControl(value)
  ) {
    fail();
  }
  return literal(value);
}

/** Absent = `[]`; at most 32 strings of ≤1024 code points each. */
function argsOf(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_ARGS) {
    fail();
  }
  return value.map((item: unknown) => {
    if (typeof item !== "string" || points(item) > MAX_ARG_POINTS) {
      fail();
    }
    return literal(item);
  });
}

function urlOf(value: unknown): string {
  if (typeof value !== "string" || !validateUpstreamBaseUrl(value)) {
    fail();
  }
  return literal(value);
}

/**
 * Absent = `{}`; at most 32 entries, each checked by `entry` or, for `null`, taken from `kept`.
 * Returns a fresh object with the keys in sorted order (`Object.fromEntries`: `__proto__` stays a key).
 */
function entriesOf(
  value: unknown,
  kept: Entries,
  entry: (key: string, value: unknown) => void,
): Entries {
  if (value === undefined) {
    return {};
  }
  const pairs = Object.entries(object(value));
  if (pairs.length > MAX_ENTRIES) {
    fail();
  }
  const resolved = pairs.map(([key, item]): [string, string] => {
    if (item === null) {
      if (!Object.hasOwn(kept, key)) {
        fail();
      }
      return [key, kept[key] as string];
    }
    entry(key, item);
    return [key, item as string];
  });
  return Object.fromEntries(resolved.sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Key `^[A-Z_][A-Z0-9_]{0,63}$`; value 1..4096 code points, taken literally by omp. */
function envEntry(key: string, value: unknown): void {
  if (!ENV_KEY.test(key) || typeof value !== "string" || value === "") {
    fail();
  }
  if (points(value) > MAX_ENV_VALUE_POINTS) {
    fail();
  }
  notAnEnvName(value);
}

/** Name an RFC 7230 token, value a valid header value (Node's checks), taken literally by omp. */
function headerEntry(name: string, value: unknown): void {
  if (typeof value !== "string") {
    fail();
  }
  try {
    validateHeaderName(name);
    validateHeaderValue(name, value);
  } catch {
    // Node's message quotes the header; only the fixed message leaves here.
    fail();
  }
  notAnEnvName(value);
}

/** Neither a `!` command nor a `${…}` interpolation to omp. */
function literal(value: string): string {
  if (value.startsWith("!") || value.includes("${")) {
    fail();
  }
  return value;
}

/** Also not replaced by an omp environment variable's value (`env` and `headers` values only). */
function notAnEnvName(value: string): void {
  literal(value);
  if (OMP_CHILD_ENV_NAMES.has(value)) {
    fail();
  }
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function points(value: string): number {
  return [...value].length;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail();
  }
  return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (!Object.keys(record).every((key) => allowed.includes(key))) {
    fail();
  }
}

function fail(): never {
  throw new HttpError("bad_request");
}
