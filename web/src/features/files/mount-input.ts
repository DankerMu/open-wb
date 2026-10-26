/**
 * The `挂载目录` dialog's local rules and body (workspace-mounts「挂载对话框」, design D2), pure. They
 * follow the server's (`server/src/workspaces/mounts/validate.ts`): the name alphabet and length,
 * the reserved `uploads` / `screenshots`, a non-empty host, port 1..65535, an absolute path (for
 * `SMB` with a share), a non-blank user name and credential — one message, the first broken. The
 * rest (host characters, surrounding whitespace, the key's shape) is the server's 400. The body has
 * the chosen backend's keys only; an empty port or domain is no key at all (the server takes no
 * `null` for them). Name, host, port and domain are trimmed; the path and the credentials go out as
 * typed.
 */
import type { CreateMountInput } from "../../lib/api.js";

type Backend = CreateMountInput["backend"];
export type Auth = "password" | "privateKey";

/** The workspaces `dir` alphabet, 1..64 (validate.ts `MOUNT_NAME`, migration 049). */
const MOUNT_NAME = /^[A-Za-z0-9_一-龥-]{1,64}$/;
const RESERVED_NAMES: ReadonlySet<string> = new Set(["uploads", "screenshots"]);
const PORT = /^\d+$/;

export const EMPTY_VALUES = {
  name: "",
  host: "",
  port: "",
  remotePath: "",
  username: "",
  password: "",
  privateKey: "",
  domain: "",
};
export type MountValues = typeof EMPTY_VALUES;

/** The name's rule it breaks (validate.ts `mountNameOf`), or `null`. */
function nameProblem(name: string) {
  if (name === "") return "请填写挂载名称";
  if (!MOUNT_NAME.test(name)) return "名称只能包含字母、数字、下划线、连字符与汉字";
  return RESERVED_NAMES.has(name) ? "该名称已保留" : null;
}

/** `port` 1..65535 (`portOf`), the path absolute and for `smb` with a share (`remotePathOf`). */
function remoteProblem(values: MountValues, backend: "sftp" | "smb", auth: Auth) {
  if (values.host.trim() === "") return "请填写主机";
  const port = values.port.trim();
  if (port !== "" && !(PORT.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    return "端口应为 1 到 65535 的整数";
  }
  const path = values.remotePath;
  const shareless = backend === "smb" && (path.length === 1 || path[1] === "/");
  if (!path.startsWith("/") || shareless) return "请填写绝对路径，如 /srv/data";
  if (values.username.trim() === "") return "请填写用户名";
  if (backend === "sftp" && auth === "privateKey") {
    return values.privateKey.trim() === "" ? "请填写私钥" : null;
  }
  return values.password.trim() === "" ? "请填写密码" : null;
}

/** The body of a `SFTP` / `SMB` mount whose values pass `remoteProblem`. */
function remoteInput(
  values: MountValues,
  backend: "sftp" | "smb",
  auth: Auth,
  name: string,
  readOnly: boolean,
): CreateMountInput {
  const port = values.port.trim();
  const base = {
    name,
    host: values.host.trim(),
    ...(port === "" ? {} : { port: Number(port) }),
    remotePath: values.remotePath,
    readOnly,
    username: values.username,
  };
  if (backend === "sftp") {
    return auth === "privateKey"
      ? { ...base, backend, privateKey: values.privateKey }
      : { ...base, backend, password: values.password };
  }
  const domain = values.domain.trim();
  return { ...base, backend, password: values.password, ...(domain === "" ? {} : { domain }) };
}

/** The message of the first local rule `values` breaks, or the body (`null`: nothing to submit). */
export function mountInput(
  values: MountValues,
  backend: Backend,
  auth: Auth,
  readOnly: boolean,
  sourceId: string | null,
): string | CreateMountInput | null {
  const name = values.name.trim();
  const problem = nameProblem(name);
  if (problem) return problem;
  if (backend === "local") {
    return sourceId === null ? null : { name, backend, sourceId, readOnly };
  }
  return remoteProblem(values, backend, auth) ?? remoteInput(values, backend, auth, name, readOnly);
}
