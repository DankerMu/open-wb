/**
 * s1d-connectors group 1: `OMP_CHILD_ENV_NAMES` (connectors「连接器取值规则」, design D3 and Context
 * 「omp 子进程的环境变量名」). The expected names are literals from the design, not read back from the
 * module: every key `ompSpawnEnv` sets (with and without `browserBin` / `LANG` / `TMPDIR`), every name in
 * `SUDO_PRESERVE_ENV`, the eleven sudo-injected names and the six omp sets itself. A key added to
 * `ompSpawnEnv` but not to the set fails the first two cases.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OMP_CHILD_ENV_NAMES,
  ompSpawnEnv,
  SUDO_PRESERVE_ENV,
} from "../src/sessions/omp/spawn-env.js";

const SUDO_INJECTED = [
  "USER",
  "LOGNAME",
  "SHELL",
  "MAIL",
  "TERM",
  "SUDO_USER",
  "SUDO_UID",
  "SUDO_GID",
  "SUDO_COMMAND",
  "SUDO_HOME",
  "SUDO_TTY",
];
const OMP_SELF_SET = [
  "PI_NO_PTY",
  "PI_NO_TITLE",
  "PI_NOTIFICATIONS",
  "__PI_NATIVE_VARIANT_CACHE",
  "EXA_API_KEY",
  "BUN_BE_BUN",
];
/** Context's list of `ompSpawnEnv` keys, the conditional three last. */
const SPAWN_ENV_KEYS = [
  "PATH",
  "HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_FILES",
  "PI_CONFIG_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "WORKBUDDY_MODEL_TOKEN",
  "PI_BROWSER_RELAY",
  "PI_BROWSER_CMUX",
  "PUPPETEER_PROXY",
  "PUPPETEER_PROXY_IGNORE_CERT_ERRORS",
  "OTEL_SDK_DISABLED",
  "no_proxy",
  "NO_PROXY",
  "LANG",
  "TMPDIR",
  "PUPPETEER_EXECUTABLE_PATH",
];

afterEach(() => {
  vi.unstubAllEnvs();
});

const missing = (keys: readonly string[]) => keys.filter((key) => !OMP_CHILD_ENV_NAMES.has(key));

describe("OMP_CHILD_ENV_NAMES", () => {
  it("holds every key ompSpawnEnv sets with browserBin, LANG and TMPDIR", () => {
    vi.stubEnv("LANG", "zh_CN.UTF-8");
    vi.stubEnv("TMPDIR", "/var/tmp/omp");
    const env = ompSpawnEnv({ stateDir: "/srv/state", token: "t", browserBin: "/usr/bin/chrome" });
    expect(Object.keys(env)).toEqual(expect.arrayContaining(["LANG", "TMPDIR"]));
    expect(Object.keys(env)).toContain("PUPPETEER_EXECUTABLE_PATH");
    expect(missing(Object.keys(env))).toEqual([]);
  });

  it("holds every key ompSpawnEnv sets without browserBin, LANG or TMPDIR", () => {
    vi.stubEnv("LANG", undefined);
    vi.stubEnv("TMPDIR", undefined);
    const env = ompSpawnEnv({ stateDir: "/srv/state", token: "t" });
    expect(Object.keys(env)).not.toContain("LANG");
    expect(Object.keys(env)).not.toContain("TMPDIR");
    expect(Object.keys(env)).not.toContain("PUPPETEER_EXECUTABLE_PATH");
    expect(missing(Object.keys(env))).toEqual([]);
  });

  it("holds every name sudo preserves", () => {
    expect(SUDO_PRESERVE_ENV.startsWith("--preserve-env=")).toBe(true);
    const preserved = SUDO_PRESERVE_ENV.slice("--preserve-env=".length).split(",");
    expect(preserved.length).toBeGreaterThan(0);
    expect(missing(preserved)).toEqual([]);
  });

  it("holds the eleven sudo-injected names and the six omp sets itself", () => {
    expect(SUDO_INJECTED).toHaveLength(11);
    expect(missing(SUDO_INJECTED)).toEqual([]);
    expect(missing(OMP_SELF_SET)).toEqual([]);
  });

  it("is exactly the design's 38 names, case-sensitive", () => {
    expect([...OMP_CHILD_ENV_NAMES].sort()).toEqual(
      [...SPAWN_ENV_KEYS, ...SUDO_INJECTED, ...OMP_SELF_SET].sort(),
    );
    expect(OMP_CHILD_ENV_NAMES.size).toBe(38);
    expect(OMP_CHILD_ENV_NAMES.has("home")).toBe(false);
    expect(OMP_CHILD_ENV_NAMES.has("Path")).toBe(false);
  });
});
