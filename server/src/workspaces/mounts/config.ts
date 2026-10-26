/**
 * 挂载的三个配置键与 `RCLONE_BIN` 的启动预检（workspace-mounts「挂载配置与启动预检」，design D4）。
 * 纯配置 seam 的一部分：由 `resolveServerConfig` 展开，只读文件系统与运行 `id`，不建目录、不开 DB、不 listen。
 * 错误只点名键，不回显任何取值、路径或用户名。
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { resolvePositiveInteger } from "../../agent-config.js";

const DEFAULT_MOUNT_MAX_PER_WORKSPACE = 8;
const HOST_ITEM = /^[A-Za-z0-9.:-]{1,253}$/u;
/** 一次 `id` 调用的期限：卡住的名字服务不能让启动无限等待。 */
const ID_TIMEOUT_MS = 10_000;
const GROUP_RULE =
  "RCLONE_BIN preflight: every fusermount3 and fusermount on PATH must have no other-execute bit " +
  "and a group the omp user is not in (fusermount3 只能对 app 所在、omp 不在的组可执行)";

export interface MountSettings {
  /** 未配置即挂载关闭；给出时预检已通过。 */
  rcloneBin?: string;
  /** PATH 上第一个可执行的 `fusermount3` 的绝对路径；此后的卸载只用它。与 `rcloneBin` 同在。 */
  fusermountBin?: string;
  /** omp 用户的数值 uid（`/usr/bin/id -u`）；只在配置了 `rcloneBin` 与 `OMP_USER` 时出现。 */
  ompUid?: number;
  /** 未配置即不限主机。 */
  mountHostAllow?: readonly string[];
  mountMaxPerWorkspace: number;
}

/** 预检读取的固定位置；测试注入替身。 */
export interface MountProbes {
  devFuse: string;
  fuseConf: string;
  idBin: string;
}

/** 生产取值；`id` 走固定路径、不经 PATH（与 `/usr/bin/setpriv` 同一纪律）。 */
export const SYSTEM_PROBES: MountProbes = {
  devFuse: "/dev/fuse",
  fuseConf: "/etc/fuse.conf",
  idBin: "/usr/bin/id",
};

export function resolveMountSettings(
  env: Record<string, string | undefined>,
  probes: MountProbes = SYSTEM_PROBES,
): MountSettings {
  const mountHostAllow = resolveHostAllow(env.MOUNT_HOST_ALLOW);
  const mountMaxPerWorkspace = resolvePositiveInteger(
    env.MOUNT_MAX_PER_WORKSPACE,
    DEFAULT_MOUNT_MAX_PER_WORKSPACE,
    "MOUNT_MAX_PER_WORKSPACE",
  );
  return {
    ...(env.RCLONE_BIN === undefined
      ? {}
      : preflight(env.RCLONE_BIN, env.PATH, env.OMP_USER, probes)),
    ...(mountHostAllow === undefined ? {} : { mountHostAllow }),
    mountMaxPerWorkspace,
  };
}

/** 逗号分隔，不 trim、不去重、保持书写顺序；每项 1..253 字节、只含 `[A-Za-z0-9.:-]`。 */
function resolveHostAllow(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const hosts = raw.split(",");
  if (!hosts.every((host) => HOST_ITEM.test(host))) {
    throw new Error(
      "MOUNT_HOST_ALLOW must be comma-separated host names of 1..253 ASCII letters, digits, '.', ':' or '-'",
    );
  }
  return hosts;
}

function preflight(
  rcloneBin: string,
  path: string | undefined,
  ompUser: string | undefined,
  probes: MountProbes,
): Pick<MountSettings, "rcloneBin" | "fusermountBin" | "ompUid"> {
  if (!isAbsolute(rcloneBin) || !isExecutableFile(rcloneBin)) {
    throw new Error("RCLONE_BIN must be an absolute path to an executable regular file");
  }
  const dirs = pathDirs(path);
  const fusermountBin = firstExecutable(dirs, "fusermount3");
  if (fusermountBin === undefined) {
    throw new Error("RCLONE_BIN preflight: no executable fusermount3 on PATH");
  }
  if (firstExecutable(dirs, "fusermount") === undefined) {
    throw new Error("RCLONE_BIN preflight: no executable fusermount on PATH");
  }
  if (!isCharacterDevice(probes.devFuse)) {
    throw new Error("RCLONE_BIN preflight: /dev/fuse must exist as a character device");
  }
  if (ompUser === undefined) {
    return { rcloneBin, fusermountBin };
  }
  if (!allowsOther(probes.fuseConf)) {
    throw new Error("RCLONE_BIN preflight: /etc/fuse.conf must enable user_allow_other");
  }
  const [ompUid, ...extra] = idOutput(probes.idBin, "-u", ompUser);
  if (ompUid === undefined || extra.length > 0) {
    throw new Error("RCLONE_BIN preflight: /usr/bin/id -u for the omp user failed");
  }
  assertRestrictedFusermount(dirs, new Set(idOutput(probes.idBin, "-G", ompUser)));
  return { rcloneBin, fusermountBin, ompUid };
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The first executable regular file `name` under the absolute entries of `path`; also the manager's
 * `fusermount3` lookup when the feature is off (design D10).
 */
export function findExecutable(path: string | undefined, name: string): string | undefined {
  return firstExecutable(pathDirs(path), name);
}

function pathDirs(path: string | undefined): string[] {
  return (path ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
}

function firstExecutable(dirs: readonly string[], name: string): string | undefined {
  return dirs.map((dir) => join(dir, name)).find(isExecutableFile);
}

function isCharacterDevice(file: string): boolean {
  try {
    return statSync(file).isCharacterDevice();
  } catch {
    return false;
  }
}

function allowsOther(fuseConf: string): boolean {
  try {
    return readFileSync(fuseConf, "utf8")
      .split("\n")
      .some((line) => line.trim() === "user_allow_other");
  } catch {
    return false;
  }
}

/**
 * `<idBin> <flag> -- <user>` 的十进制数列（`-u` 一个、`-G` 一个或多个）；退出码非 0、超时或任一项
 * 不是十进制整数即不过。
 */
function idOutput(idBin: string, flag: "-u" | "-G", user: string): number[] {
  const run = spawnSync(idBin, [flag, "--", user], {
    encoding: "utf8",
    env: {},
    stdio: ["ignore", "pipe", "ignore"],
    timeout: ID_TIMEOUT_MS,
  });
  const fields = run.status === 0 ? run.stdout.trim().split(/\s+/u) : [];
  if (fields.length === 0 || !fields.every((field) => /^[0-9]{1,10}$/u.test(field))) {
    throw new Error(`RCLONE_BIN preflight: /usr/bin/id ${flag} for the omp user failed`);
  }
  return fields.map(Number);
}

/** PATH 各项下找到的每一个 `fusermount3` 与 `fusermount`（跟随符号链接）：无 other 执行位、属组不是 omp 的组。 */
function assertRestrictedFusermount(dirs: readonly string[], ompGroups: ReadonlySet<number>): void {
  for (const dir of dirs) {
    for (const name of ["fusermount3", "fusermount"]) {
      const found = statIfFile(join(dir, name));
      if (found !== undefined && ((found.mode & 0o001) !== 0 || ompGroups.has(found.gid))) {
        throw new Error(GROUP_RULE);
      }
    }
  }
}

function statIfFile(file: string): { mode: number; gid: number } | undefined {
  try {
    const stats = statSync(file);
    return stats.isFile() ? stats : undefined;
  } catch {
    return undefined;
  }
}
