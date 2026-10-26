/**
 * Issue #1682 workspace-mounts「挂载配置与启动预检」：三个挂载键（`RCLONE_BIN`、`MOUNT_HOST_ALLOW`、
 * `MOUNT_MAX_PER_WORKSPACE`）与 `RCLONE_BIN` 的启动预检；http-service-skeleton「挂载键与启动预检」的配置部分。
 * 三个场景「缺省与覆盖」「非法值」「预检」；预检的 `/dev/fuse`、`/etc/fuse.conf` 与 `id` 经注入的路径，
 * `id -u` / `id -G` 的输出由注入的假 `id` 给出。编译入口按 `omp-max-processes-config.test.ts` 的写法逐值跑。
 * 期望值取自规格（缺省 8、上限 2147483647、每项 1..253 字节），不引用 `src/workspaces/mounts/config.ts` 的常量。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveServerConfig } from "../src/server.js";
import { type MountProbes, resolveMountSettings } from "../src/workspaces/mounts/config.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  releaseStartupFixtures,
} from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const FAILED_RECORD = `${JSON.stringify({ event: "server_start_failed", reason: "config" })}\n`;
const NODE_SQLITE_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u;
/** 规格要求组权限不过的 message 写明的那句话。 */
const GROUP_RULE = "fusermount3 只能对 app 所在、omp 不在的组可执行";
/** 测试用的 omp 用户名：不出现在任何 message 里。 */
const OMP = "wbompx";
const OMP_UID = 4242;

const scratchRoots: string[] = [];

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

function script(dir: string, name: string, mode: number, body = "exit 0\n"): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}`);
  chmodSync(file, mode);
  return file;
}

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("resolver accepted the configuration");
}

interface FakeId {
  bin: string;
  /** 每次调用一行：收到的全部参数，空格连接。 */
  calls(): string[];
}

/** 假 `id`：只认 `-u -- <OMP>` 与 `-G -- <OMP>`，其它参数退出 3；每次调用落一行记录。 */
function fakeId(dir: string, behaviour: { u?: string; g?: string }): FakeId {
  const log = join(dir, "id-calls.log");
  const body = [
    `printf '%s\\n' "$*" >> '${log}'`,
    `[ "$#" -eq 3 ] && [ "$2" = "--" ] && [ "$3" = "${OMP}" ] || exit 3`,
    'case "$1" in',
    `  -u) ${behaviour.u ?? `echo ${OMP_UID}`} ;;`,
    `  -G) ${behaviour.g ?? "echo 1"} ;;`,
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n");
  const bin = script(dir, "fake-id", 0o755, body);
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []),
  };
}

/** omp 的组里不含 `file` 属组的 `id -G` 输出。 */
function groupsWithout(file: string): string {
  const gid = statSync(file).gid;
  return `echo ${gid + 1} ${gid + 2}`;
}

interface Host {
  root: string;
  rclone: string;
  /** PATH 上唯一一项，内有 `fusermount3` 与指向它的 `fusermount`（Ubuntu fuse3 包的形状）。 */
  pathDir: string;
  fusermount3: string;
  fuseConf: string;
  env: Record<string, string>;
  probes: MountProbes;
  id: FakeId;
}

/**
 * 前提齐全的主机：`/dev/null` 充当字符设备 `/dev/fuse`；`OMP_USER` 模式下 `fusermount3` 为 `4750`、
 * 属组不在 omp 的组里。`fusermount3Mode` / `idGroups` 给出时替换对应前提。
 */
function host(options: { ompUser?: boolean; fusermount3Mode?: number; idGroups?: string } = {}) {
  const root = scratch("open-wb-mounts-preflight-");
  const rclone = script(root, "rclone", 0o755);
  const pathDir = join(root, "path-a");
  const fusermount3 = script(pathDir, "fusermount3", options.fusermount3Mode ?? 0o4750);
  symlinkSync(fusermount3, join(pathDir, "fusermount"));
  const fuseConf = join(root, "fuse.conf");
  writeFileSync(fuseConf, "# mount_max = 1000\n  user_allow_other  \n");
  const id = fakeId(root, { g: options.idGroups ?? groupsWithout(fusermount3) });
  const env: Record<string, string> = {
    RCLONE_BIN: rclone,
    PATH: pathDir,
    ...(options.ompUser === true ? { OMP_USER: OMP } : {}),
  };
  const probes: MountProbes = { devFuse: "/dev/null", fuseConf, idBin: id.bin };
  return { root, rclone, pathDir, fusermount3, fuseConf, env, probes, id } satisfies Host;
}

describe("缺省与覆盖", () => {
  it("三键全缺：挂载关闭、主机不限、上限 8", () => {
    const config = resolveServerConfig({}, SOURCE_ENTRY);
    for (const key of ["rcloneBin", "fusermountBin", "ompUid", "mountHostAllow"]) {
      expect(Object.hasOwn(config, key)).toBe(false);
    }
    expect(config.mountMaxPerWorkspace).toBe(8);
  });

  it("未配置 RCLONE_BIN 时不读 /dev/fuse 与 fuse.conf、不运行 id（OMP_USER 配置也一样）", () => {
    const root = scratch("open-wb-mounts-off-");
    const id = fakeId(root, {});
    const probes: MountProbes = {
      devFuse: join(root, "no-such-fuse"),
      fuseConf: join(root, "no-such-fuse.conf"),
      idBin: id.bin,
    };
    const reads: string[] = [];
    const watched = new Proxy(probes, {
      get(target, key: keyof MountProbes) {
        reads.push(String(key));
        return target[key];
      },
    });
    for (const env of [{}, { OMP_USER: OMP, PATH: root }]) {
      const settings = resolveMountSettings(env, watched);
      expect(settings).toEqual({ mountMaxPerWorkspace: 8 });
    }
    expect(reads).toEqual([]);
    expect(id.calls()).toEqual([]);
  });

  it("MOUNT_HOST_ALLOW=files.intra,10.0.0.5、MOUNT_MAX_PER_WORKSPACE=3：名单恰为两项、上限 3", () => {
    const config = resolveServerConfig(
      { MOUNT_HOST_ALLOW: "files.intra,10.0.0.5", MOUNT_MAX_PER_WORKSPACE: "3" },
      SOURCE_ENTRY,
    );
    expect(config.mountHostAllow).toEqual(["files.intra", "10.0.0.5"]);
    expect(config.mountMaxPerWorkspace).toBe(3);
    expect(Object.hasOwn(config, "rcloneBin")).toBe(false);
  });

  it("边界内的取值：253 字节的一项、IPv6 字面、上限 1 与 2147483647", () => {
    const longest = "a".repeat(253);
    const allow = resolveMountSettings({ MOUNT_HOST_ALLOW: `${longest},fd00::1,A-b.C` });
    expect(allow.mountHostAllow).toEqual([longest, "fd00::1", "A-b.C"]);
    expect(resolveMountSettings({ MOUNT_MAX_PER_WORKSPACE: "1" }).mountMaxPerWorkspace).toBe(1);
    expect(
      resolveMountSettings({ MOUNT_MAX_PER_WORKSPACE: "2147483647" }).mountMaxPerWorkspace,
    ).toBe(2147483647);
  });
});

type EnvBuilder = (root: string) => Record<string, string>;

/** 「非法值」场景逐值（RCLONE_BIN 两例、MOUNT_HOST_ALLOW 四例、MOUNT_MAX_PER_WORKSPACE 四例）加 RCLONE_BIN 不可执行一例。 */
const INVALID_VALUES: ReadonlyArray<readonly [key: string, label: string, build: EnvBuilder]> = [
  ["RCLONE_BIN", "empty", () => ({ RCLONE_BIN: "" })],
  ["RCLONE_BIN", "bin/rclone", () => ({ RCLONE_BIN: "bin/rclone" })],
  ["MOUNT_HOST_ALLOW", "empty", () => ({ MOUNT_HOST_ALLOW: "" })],
  ["MOUNT_HOST_ALLOW", "a,,b", () => ({ MOUNT_HOST_ALLOW: "a,,b" })],
  ["MOUNT_HOST_ALLOW", "a b", () => ({ MOUNT_HOST_ALLOW: "a b" })],
  ["MOUNT_HOST_ALLOW", "a/b", () => ({ MOUNT_HOST_ALLOW: "a/b" })],
  ["MOUNT_MAX_PER_WORKSPACE", "empty", () => ({ MOUNT_MAX_PER_WORKSPACE: "" })],
  ["MOUNT_MAX_PER_WORKSPACE", "0", () => ({ MOUNT_MAX_PER_WORKSPACE: "0" })],
  ["MOUNT_MAX_PER_WORKSPACE", "08", () => ({ MOUNT_MAX_PER_WORKSPACE: "08" })],
  ["MOUNT_MAX_PER_WORKSPACE", "2147483648", () => ({ MOUNT_MAX_PER_WORKSPACE: "2147483648" })],
  ["RCLONE_BIN", "not executable", (root) => ({ RCLONE_BIN: script(root, "rclone-0644", 0o644) })],
];

/**
 * http-service-skeleton「挂载键与启动预检」另列的三例：`RCLONE_BIN` 合法而 PATH 上没有 `fusermount3`、
 * PATH 上有 `fusermount3` 而没有 `fusermount`、`MOUNT_MAX_PER_WORKSPACE=016`。
 */
const SKELETON_EXTRA: ReadonlyArray<readonly [key: string, label: string, build: EnvBuilder]> = [
  [
    "RCLONE_BIN",
    "no fusermount3 on PATH",
    (root) => {
      mkdirSync(join(root, "path-empty"));
      return { RCLONE_BIN: script(root, "rclone", 0o755), PATH: join(root, "path-empty") };
    },
  ],
  [
    "RCLONE_BIN",
    "fusermount3 without fusermount",
    (root) => {
      script(join(root, "path-f3"), "fusermount3", 0o755);
      return { RCLONE_BIN: script(root, "rclone", 0o755), PATH: join(root, "path-f3") };
    },
  ],
  ["MOUNT_MAX_PER_WORKSPACE", "016", () => ({ MOUNT_MAX_PER_WORKSPACE: "016" })],
];

describe("非法值", () => {
  it("例数被钉住：非法值十一例，骨架另列三例", () => {
    expect(INVALID_VALUES).toHaveLength(11);
    expect(SKELETON_EXTRA).toHaveLength(3);
  });

  it.each([...INVALID_VALUES, ...SKELETON_EXTRA])(
    "%s=%s：resolveServerConfig 的 message 含键名而不含输入值",
    (key, _label, build) => {
      const env = build(scratch("open-wb-mounts-invalid-"));
      const thrown = message(() => resolveServerConfig(env, SOURCE_ENTRY));
      expect(thrown).toContain(key);
      for (const value of Object.values(env)) {
        if (value !== "") {
          expect(thrown).not.toContain(value);
        }
      }
    },
  );

  it("MOUNT_HOST_ALLOW 的 254 字节一项与非 ASCII 字符同为配置错误", () => {
    for (const raw of ["a".repeat(254), "files.intra,ü.intra", "a_b", "files.intra,"]) {
      const thrown = message(() => resolveMountSettings({ MOUNT_HOST_ALLOW: raw }));
      expect(thrown).toContain("MOUNT_HOST_ALLOW");
      expect(thrown).not.toContain(raw);
    }
  });
});

type HostCase = readonly [label: string, setup: () => Host];

/** 规格「预检」场景列出的十种不过。 */
const PREFLIGHT_FAILURES: ReadonlyArray<HostCase> = [
  [
    "RCLONE_BIN 不可执行",
    () => {
      const h = host();
      chmodSync(h.rclone, 0o644);
      return h;
    },
  ],
  [
    "RCLONE_BIN 是目录",
    () => {
      const h = host();
      const dir = join(h.root, "rclone-dir");
      mkdirSync(dir, { mode: 0o755 });
      return { ...h, env: { ...h.env, RCLONE_BIN: dir } };
    },
  ],
  [
    "PATH 上没有 fusermount3",
    () => {
      const h = host();
      const empty = join(h.root, "path-empty");
      mkdirSync(empty);
      return { ...h, env: { ...h.env, PATH: empty } };
    },
  ],
  [
    "PATH 上有 fusermount3 而没有 fusermount",
    () => {
      const h = host();
      rmSync(join(h.pathDir, "fusermount"));
      return h;
    },
  ],
  [
    "/dev/fuse 不存在",
    () => {
      const h = host();
      return { ...h, probes: { ...h.probes, devFuse: join(h.root, "no-such-fuse") } };
    },
  ],
  [
    "OMP_USER 模式下 fuse.conf 只有被注释的 #user_allow_other",
    () => {
      const h = host({ ompUser: true });
      writeFileSync(h.fuseConf, "#user_allow_other\n# user_allow_other\n");
      return h;
    },
  ],
  [
    "OMP_USER 模式下 id -u 以非 0 退出",
    () => {
      const h = host({ ompUser: true });
      const id = fakeId(join(h.root, "id-fails"), { u: "exit 1" });
      return { ...h, id, probes: { ...h.probes, idBin: id.bin } };
    },
  ],
  ["OMP_USER 模式下 fusermount3 为 4755", () => host({ ompUser: true, fusermount3Mode: 0o4755 })],
  [
    "OMP_USER 模式下 fusermount3 为 4750 而属组是 omp 的一个组",
    () => {
      const h = host({ ompUser: true });
      const gid = statSync(h.fusermount3).gid;
      const id = fakeId(join(h.root, "id-in-group"), { g: `echo ${gid + 7} ${gid}` });
      return { ...h, id, probes: { ...h.probes, idBin: id.bin } };
    },
  ],
  [
    "OMP_USER 模式下 PATH 上另有一个 4755 的 fusermount",
    () => {
      const h = host({ ompUser: true });
      const later = join(h.root, "path-b");
      script(later, "fusermount", 0o4755);
      return { ...h, env: { ...h.env, PATH: [h.pathDir, later].join(delimiter) } };
    },
  ],
];

/** 规格行文另含、场景未单列的不过：`/dev/fuse` 不是字符设备、fuse.conf 不存在、id 输出不是一个十进制数、id -G 失败。 */
const PREFLIGHT_FAILURES_EXTRA: ReadonlyArray<HostCase> = [
  [
    "/dev/fuse 是普通文件",
    () => {
      const h = host();
      const file = join(h.root, "fuse-regular");
      writeFileSync(file, "");
      return { ...h, probes: { ...h.probes, devFuse: file } };
    },
  ],
  [
    "OMP_USER 模式下 fuse.conf 不存在",
    () => {
      const h = host({ ompUser: true });
      rmSync(h.fuseConf);
      return h;
    },
  ],
  [
    "OMP_USER 模式下 id -u 的输出不是十进制",
    () => {
      const h = host({ ompUser: true });
      const id = fakeId(join(h.root, "id-word"), { u: `echo ${OMP}` });
      return { ...h, id, probes: { ...h.probes, idBin: id.bin } };
    },
  ],
  [
    "OMP_USER 模式下 id -u 输出不止一个数",
    () => {
      const h = host({ ompUser: true });
      const id = fakeId(join(h.root, "id-two"), { u: `echo ${OMP_UID} 1` });
      return { ...h, id, probes: { ...h.probes, idBin: id.bin } };
    },
  ],
  [
    "OMP_USER 模式下 id -G 以非 0 退出",
    () => {
      const h = host({ ompUser: true });
      const id = fakeId(join(h.root, "id-g-fails"), { g: "exit 1" });
      return { ...h, id, probes: { ...h.probes, idBin: id.bin } };
    },
  ],
];

const GROUP_FAILURES = new Set(PREFLIGHT_FAILURES.slice(7).map(([label]) => label));

describe("预检", () => {
  it("规格列出的不过共十种", () => {
    expect(PREFLIGHT_FAILURES).toHaveLength(10);
  });

  it.each([...PREFLIGHT_FAILURES, ...PREFLIGHT_FAILURES_EXTRA])(
    "%s：配置错误、message 含 RCLONE_BIN、不含路径与用户名",
    (label, setup) => {
      const h = setup();
      const thrown = message(() => resolveMountSettings(h.env, h.probes));
      expect(thrown).toContain("RCLONE_BIN");
      for (const leaked of [h.root, h.env.RCLONE_BIN, OMP, h.probes.devFuse, h.probes.fuseConf]) {
        expect(thrown).not.toContain(leaked);
      }
      if (GROUP_FAILURES.has(label)) {
        expect(thrown).toContain(GROUP_RULE);
      }
    },
  );

  it("前提齐全（OMP_USER 模式，fusermount3 为 4750 且属组不在 omp 的组里）：记下路径与 uid", () => {
    const h = host({ ompUser: true });
    const settings = resolveMountSettings(h.env, h.probes);
    expect(settings).toEqual({
      rcloneBin: h.rclone,
      fusermountBin: h.fusermount3,
      ompUid: OMP_UID,
      mountMaxPerWorkspace: 8,
    });
    expect(h.id.calls()).toEqual([`-u -- ${OMP}`, `-G -- ${OMP}`]);
  });

  it("记下的 fusermount3 是 PATH 上第一个可执行者的绝对路径（不可执行的与目录跳过）", () => {
    const h = host();
    const missing = join(h.root, "path-missing");
    const notExecutable = join(h.root, "path-0644");
    script(notExecutable, "fusermount3", 0o644);
    const directory = join(h.root, "path-dir");
    mkdirSync(join(directory, "fusermount3"), { recursive: true });
    const first = join(h.root, "path-first");
    const chosen = script(first, "fusermount3", 0o755);
    const path = [missing, notExecutable, directory, first, h.pathDir].join(delimiter);
    const settings = resolveMountSettings({ ...h.env, PATH: path }, h.probes);
    expect(settings.fusermountBin).toBe(chosen);
    expect(settings.rcloneBin).toBe(h.rclone);
    expect(Object.hasOwn(settings, "ompUid")).toBe(false);
  });

  it("OMP_USER 未配置时 4755 的 fusermount3 不是错误，也不读 fuse.conf、不运行 id", () => {
    const h = host({ fusermount3Mode: 0o4755 });
    writeFileSync(h.fuseConf, "#user_allow_other\n");
    const settings = resolveMountSettings(h.env, h.probes);
    expect(settings.fusermountBin).toBe(h.fusermount3);
    expect(Object.hasOwn(settings, "ompUid")).toBe(false);
    expect(h.id.calls()).toEqual([]);
  });

  it("resolveServerConfig 以同一 env 的 PATH 与系统的 /dev/fuse 预检", () => {
    const h = host();
    const env = { ...h.env, MOUNT_HOST_ALLOW: "files.intra" };
    const devFuse = statSync("/dev/fuse", { throwIfNoEntry: false });
    if (devFuse?.isCharacterDevice() !== true) {
      expect(message(() => resolveServerConfig(env, SOURCE_ENTRY))).toContain(
        "RCLONE_BIN preflight: /dev/fuse",
      );
      return;
    }
    const config = resolveServerConfig(env, SOURCE_ENTRY);
    expect(config.rcloneBin).toBe(h.rclone);
    expect(config.fusermountBin).toBe(h.fusermount3);
    expect(config.mountHostAllow).toEqual(["files.intra"]);
  });
});

function refused(port: number): Promise<boolean> {
  return new Promise((settle) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      settle(false);
    });
    socket.once("error", () => settle(true));
  });
}

describe("production entry rejects invalid mount settings before effects", () => {
  let compiled: CompiledServerEntry;

  beforeAll(async () => {
    compiled = await compileServerEntry();
  }, 90_000);

  it.each([...INVALID_VALUES, ...SKELETON_EXTRA])(
    "%s=%s：nonzero、恰一行 generic record、无 DB/state/sandbox/listen",
    async (key, _label, build) => {
      const root = scratch("open-wb-mounts-entry-");
      const extra = build(root);
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), extra),
      }));
      const closed = await server.waitForClose();

      expect(closed).toEqual({ code: 1, signal: null });
      expect(server.stdout()).toBe("");
      const stderr = server.stderr().replace(NODE_SQLITE_WARNING, "");
      expect(stderr).toBe(FAILED_RECORD);
      expect(stderr).not.toContain(key);
      for (const owned of ["db", "state", "sandbox", "bin", "preview-cache"]) {
        expect(existsSync(join(root, owned))).toBe(false);
      }
      expect(existsSync(join(compiled.root, "var"))).toBe(false);
      await expect(refused(port)).resolves.toBe(true);
    },
    20_000,
  );
});
