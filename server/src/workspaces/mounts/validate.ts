/**
 * workspaces/mounts/validate — the mount and mount-source POST body rules (s1b-workspace-mounts design
 * D1 `name`, D2; workspace-mounts「挂载取值与主机规则」key sets and values,「挂载源端点」body shape).
 * Pure functions: no filesystem, DB or resolver. The mount-source `path` is checked for shape only; its
 * realpath, existence and containment belong to the endpoint, the 32-source cap to the store.
 *
 * Key sets are strict per `backend`. A refusal names one field and never carries a submitted value —
 * credentials enter the system only through here. An unexpected key is reported as `body`: its name is
 * submitted data too. Lengths are UTF-8 bytes for `host`, `remotePath`, `domain` and `privateKey`, code
 * points for `username`, `password` and the mount-source `name`.
 */

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; field: string; message: string };

interface RemoteFields {
  name: string;
  host: string;
  port?: number;
  remotePath: string;
  readOnly: boolean;
  username: string;
}

export type MountBody =
  | (RemoteFields & { backend: "sftp"; password: string })
  | (RemoteFields & { backend: "sftp"; privateKey: string })
  | (RemoteFields & { backend: "smb"; password: string; domain?: string })
  | { name: string; backend: "local"; sourceId: string; readOnly: boolean };

export interface MountSourceBody {
  name: string;
  path: string;
  readOnly: boolean;
}

type Backend = MountBody["backend"];

const REMOTE_REQUIRED = ["name", "backend", "host", "remotePath", "readOnly", "username"] as const;
const KEYS: Readonly<
  Record<Backend, { required: readonly string[]; optional: readonly string[] }>
> = {
  sftp: { required: REMOTE_REQUIRED, optional: ["port", "password", "privateKey"] },
  smb: { required: [...REMOTE_REQUIRED, "password"], optional: ["port", "domain"] },
  local: { required: ["name", "backend", "sourceId", "readOnly"], optional: [] },
};
const SOURCE_KEYS = ["name", "path", "readOnly"] as const;

/** Mirrors workspaces `DIR_ALPHABET` (store.ts) and the `dir` CHECK of migration 031; excludes `.`. */
const MOUNT_NAME = /^[A-Za-z0-9_一-龥-]{1,64}$/;
const RESERVED_NAMES: ReadonlySet<string> = new Set(["uploads", "screenshots"]);
const HOST = /^[A-Za-z0-9.:][A-Za-z0-9.:-]*$/;
const DOMAIN = /^[A-Za-z0-9._-]+$/;
const SOURCE_ID = /^[0-9a-f]{32}$/;
const PRINTABLE_ASCII_OR_LF = /^[\x20-\x7e\n]*$/;
const KEY_PREFIX = "-----BEGIN ";
// `host`, `domain` and `privateKey` are ASCII-only by their patterns, so `.length` is the byte count.
const MAX_HOST_BYTES = 253;
const MAX_REMOTE_PATH_BYTES = 1024;
const MAX_USERNAME_POINTS = 256;
const MAX_PASSWORD_POINTS = 1024;
const MAX_DOMAIN_BYTES = 64;
const MAX_PRIVATE_KEY_BYTES = 16384;
const MAX_SOURCE_NAME_POINTS = 64;

class Refusal extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** `POST /api/workspaces/:id/mounts` body. */
export function validateMountBody(body: unknown): ValidationResult<MountBody> {
  return attempt(() => {
    const record = objectOf(body);
    const backend = record.backend;
    if (backend !== "sftp" && backend !== "smb" && backend !== "local") {
      refuse("backend");
    }
    exactKeys(record, KEYS[backend].required, KEYS[backend].optional);
    const name = mountNameOf(record.name);
    const readOnly = booleanOf(record.readOnly, "readOnly");
    if (backend === "local") {
      return { name, backend, sourceId: sourceIdOf(record.sourceId), readOnly };
    }
    const remote: RemoteFields = {
      name,
      host: hostOf(record.host),
      remotePath: remotePathOf(record.remotePath, backend === "smb"),
      readOnly,
      username: credentialOf(record.username, "username", MAX_USERNAME_POINTS),
    };
    if (Object.hasOwn(record, "port")) {
      remote.port = portOf(record.port);
    }
    return backend === "smb" ? smbOf(record, remote) : sftpOf(record, remote);
  });
}

/** `POST /api/mount-sources` body: exactly `{name, path, readOnly}`, shape only. */
export function validateMountSourceBody(body: unknown): ValidationResult<MountSourceBody> {
  return attempt(() => {
    const record = objectOf(body);
    exactKeys(record, SOURCE_KEYS, []);
    const { name, path } = record;
    if (
      typeof name !== "string" ||
      name === "" ||
      points(name) > MAX_SOURCE_NAME_POINTS ||
      hasControl(name)
    ) {
      refuse("name");
    }
    if (typeof path !== "string" || !path.startsWith("/")) {
      refuse("path", "path must be absolute");
    }
    return { name, path, readOnly: booleanOf(record.readOnly, "readOnly") };
  });
}

function smbOf(record: Record<string, unknown>, remote: RemoteFields): MountBody {
  const password = credentialOf(record.password, "password", MAX_PASSWORD_POINTS);
  if (!Object.hasOwn(record, "domain")) {
    return { ...remote, backend: "smb", password };
  }
  return { ...remote, backend: "smb", password, domain: domainOf(record.domain) };
}

/** Exactly one of `password` and `privateKey`. */
function sftpOf(record: Record<string, unknown>, remote: RemoteFields): MountBody {
  const hasPassword = Object.hasOwn(record, "password");
  if (hasPassword === Object.hasOwn(record, "privateKey")) {
    refuse("password", "password: exactly one of password and privateKey is required");
  }
  if (hasPassword) {
    return {
      ...remote,
      backend: "sftp",
      password: credentialOf(record.password, "password", MAX_PASSWORD_POINTS),
    };
  }
  return { ...remote, backend: "sftp", privateKey: privateKeyOf(record.privateKey) };
}

/** The workspaces `dir` alphabet, 1..64, and not a reserved name. */
function mountNameOf(value: unknown): string {
  if (typeof value !== "string" || !MOUNT_NAME.test(value)) {
    refuse("name");
  }
  if (RESERVED_NAMES.has(value)) {
    refuse("name", "name is reserved");
  }
  return value;
}

/** 1..253 bytes of `[A-Za-z0-9.:-]`, not starting with `-`. */
function hostOf(value: unknown): string {
  if (typeof value !== "string" || !HOST.test(value) || value.length > MAX_HOST_BYTES) {
    refuse("host");
  }
  return value;
}

function portOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    refuse("port");
  }
  return value;
}

/** Absolute, ≤1024 bytes, no control character; for smb the first segment (the share) is non-empty. */
function remotePathOf(value: unknown, needsShare: boolean): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    Buffer.byteLength(value, "utf8") > MAX_REMOTE_PATH_BYTES ||
    hasControl(value)
  ) {
    refuse("remotePath");
  }
  if (needsShare && (value.length === 1 || value[1] === "/")) {
    refuse("remotePath", "remotePath needs a share name");
  }
  return value;
}

/** `username` / `password`: 1..max code points, no control character, no surrounding whitespace. */
function credentialOf(value: unknown, field: string, maxPoints: number): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    points(value) > maxPoints ||
    hasControl(value) ||
    value.trim() !== value
  ) {
    refuse(field);
  }
  return value;
}

/** 1..64 bytes of `[A-Za-z0-9._-]` (no control character or whitespace possible). */
function domainOf(value: unknown): string {
  if (typeof value !== "string" || !DOMAIN.test(value) || value.length > MAX_DOMAIN_BYTES) {
    refuse("domain");
  }
  return value;
}

/** ≤16384 bytes, starts with `-----BEGIN `, printable ASCII and `\n` only. */
function privateKeyOf(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(KEY_PREFIX) ||
    !PRINTABLE_ASCII_OR_LF.test(value) ||
    value.length > MAX_PRIVATE_KEY_BYTES
  ) {
    refuse("privateKey");
  }
  return value;
}

function sourceIdOf(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) {
    refuse("sourceId");
  }
  return value;
}

function booleanOf(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    refuse(field);
  }
  return value;
}

/** Every key in `required` ∪ `optional`, every `required` key present (named when missing). */
function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      refuse("body", "body has a key not allowed here");
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      refuse(key, `${key} is required`);
    }
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse("body", "body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function hasControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function points(value: string): number {
  return [...value].length;
}

function attempt<T>(parse: () => T): ValidationResult<T> {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    if (error instanceof Refusal) {
      return { ok: false, field: error.field, message: error.reason };
    }
    throw error;
  }
}

function refuse(field: string, reason = `${field} is invalid`): never {
  throw new Refusal(field, reason);
}
