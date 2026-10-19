/**
 * Issue #1529 omp-runtime「子进程 spawn 契约」scenario「环境白名单」(the `PUPPETEER_EXECUTABLE_PATH`
 * and `PI_BROWSER_*` WHENs) and omp-uid-isolation「OMP_USER 配置与 sudo spawn 前缀」scenario「sudo 保留
 * 浏览器路径」, on the captured `spawnOmp` call. `PUPPETEER_EXECUTABLE_PATH` comes only from the
 * deployment's `BROWSER_BIN` (`browserBin`), after `LANG`/`TMPDIR`; `PI_BROWSER_RELAY=0` and
 * `PI_BROWSER_CMUX=0` are always set; nothing of the parent's browser variables reaches the child;
 * the sudo `--preserve-env=` element is one fixed string. Expected keys, order and the literal are
 * the spec's, not derived from `src/sessions/omp/`.
 */
import type { SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SpawnImpl, spawnOmp } from "../src/sessions/omp/process.js";
import { FakeChild } from "./support/omp-rpc.js";
import { useSetprivStub } from "./support/setpriv.js";

const OWNER = "u1";
const TOKEN = "d".repeat(64);
const CHROMIUM = "/usr/bin/chromium";
/** The parent's own browser variables (a deployment shell or an inherited dotenv). */
const PARENT: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  TMPDIR: "/tmp/browser tmp",
  PUPPETEER_EXECUTABLE_PATH: "/opt/other",
  BROWSER_BIN: "/opt/parent-browser-bin",
  PI_BROWSER_RELAY: "1",
  PI_BROWSER_CMUX: "1",
  CMUX_SOCKET_PATH: "/tmp/x.sock",
};
const PRESERVE_ENV =
  "--preserve-env=PATH,LANG,TMPDIR,HOME,XDG_DATA_HOME,XDG_STATE_HOME,XDG_CACHE_HOME,PI_CODING_AGENT_DIR,PI_CONFIG_FILES,PI_CONFIG_DIR,OMP_PROFILE,PI_PROFILE,WORKBUDDY_MODEL_TOKEN,PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_EXECUTABLE_PATH";
/** The closed key set in the order the contract builds it; `PUPPETEER_EXECUTABLE_PATH` comes last. */
const KEYS = [
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
  "LANG",
  "TMPDIR",
];

interface Captured {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  bin: string;
}

/** Read before any case stubs `TMPDIR`, which `tmpdir()` follows. */
const BASE_TMP = tmpdir();
const temps: string[] = [];
useSetprivStub();

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function capture(options: { ompUser?: string; browserBin?: string }): Promise<Captured> {
  const root = mkdtempSync(join(BASE_TMP, "omp-process-browser-"));
  temps.push(root);
  const bin = join(root, "bin", "omp");
  for (const [key, value] of Object.entries(PARENT)) {
    vi.stubEnv(key, value);
  }
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawnImpl: SpawnImpl = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], options: spawnOptions });
    return new FakeChild().spawnImpl(command, args, spawnOptions);
  };
  await spawnOmp(
    {
      bin,
      sandboxRoot: join(root, "sandbox"),
      stateDir: join(root, "state"),
      ownerId: OWNER,
      cwd: join(root, "sandbox", OWNER),
      modelId: "deepseek-v4.1-flash",
      approvalMode: "write",
      token: TOKEN,
      resumePath: null,
      ...options,
    },
    spawnImpl,
  );
  expect(calls).toHaveLength(1);
  const call = calls[0];
  return {
    command: String(call?.command),
    args: call?.args ?? [],
    env: call?.options.env ?? {},
    bin,
  };
}

/** No parent browser value anywhere in the call, and no browser `KEY=value` argv element. */
function expectNoParentBrowserValues(call: Captured): void {
  const dump = JSON.stringify([call.env, call.args]);
  for (const value of ["/opt/other", "/opt/parent-browser-bin", "/tmp/x.sock"]) {
    expect(dump).not.toContain(value);
  }
  expect(call.env).not.toHaveProperty("BROWSER_BIN");
  expect(call.env).not.toHaveProperty("CMUX_SOCKET_PATH");
  for (const key of ["PUPPETEER_EXECUTABLE_PATH", "PI_BROWSER_RELAY", "PI_BROWSER_CMUX"]) {
    expect(call.args.some((arg) => arg.startsWith(`${key}=`))).toBe(false);
  }
}

describe("spawnOmp browser environment", () => {
  it.each([undefined, "omp"])(
    "BROWSER_BIN unset (ompUser %s): no PUPPETEER_EXECUTABLE_PATH, both pins 0",
    async (ompUser) => {
      const call = await capture(ompUser === undefined ? {} : { ompUser });

      expect(Object.keys(call.env)).toEqual(KEYS);
      expect(call.env.PI_BROWSER_RELAY).toBe("0");
      expect(call.env.PI_BROWSER_CMUX).toBe("0");
      expect(call.env).not.toHaveProperty("PUPPETEER_EXECUTABLE_PATH");
      expectNoParentBrowserValues(call);
    },
  );

  it.each([undefined, "omp"])(
    "BROWSER_BIN set (ompUser %s): PUPPETEER_EXECUTABLE_PATH is exactly it, after LANG/TMPDIR",
    async (ompUser) => {
      const call = await capture({
        browserBin: CHROMIUM,
        ...(ompUser === undefined ? {} : { ompUser }),
      });

      expect(Object.keys(call.env)).toEqual([...KEYS, "PUPPETEER_EXECUTABLE_PATH"]);
      expect(call.env.PUPPETEER_EXECUTABLE_PATH).toBe(CHROMIUM);
      expect(call.env.PI_BROWSER_RELAY).toBe("0");
      expect(call.env.PI_BROWSER_CMUX).toBe("0");
      expectNoParentBrowserValues(call);
    },
  );

  it("direct spawn: argv is the same with and without BROWSER_BIN", async () => {
    const unset = await capture({});
    const set = await capture({ browserBin: CHROMIUM });

    expect(unset.command).toBe(unset.bin);
    expect(set.command).toBe(set.bin);
    const relative = (call: Captured) =>
      call.args.map((arg) => arg.replaceAll(join(call.bin, "..", ".."), "<root>"));
    expect(relative(set)).toEqual(relative(unset));
  });

  it("sudo: one fixed --preserve-env element ending in the three browser keys, set or unset", async () => {
    const unset = await capture({ ompUser: "omp" });
    const set = await capture({ ompUser: "omp", browserBin: CHROMIUM });

    for (const call of [unset, set]) {
      expect(call.command).toBe("sudo");
      expect(call.args.slice(0, call.args.indexOf(call.bin) + 1)).toEqual([
        "-n",
        "-u",
        "omp",
        PRESERVE_ENV,
        "TMPDIR=/tmp/browser tmp",
        "--",
        "/usr/bin/setpriv",
        "--pdeathsig",
        "KILL",
        "--",
        call.bin,
      ]);
      expect(call.args.find((arg) => arg.startsWith("--preserve-env="))).toMatch(
        /,WORKBUDDY_MODEL_TOKEN,PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_EXECUTABLE_PATH$/u,
      );
      expect(call.env.PI_BROWSER_RELAY).toBe("0");
      expect(call.env.PI_BROWSER_CMUX).toBe("0");
      expectNoParentBrowserValues(call);
    }
    expect(set.env.PUPPETEER_EXECUTABLE_PATH).toBe(CHROMIUM);
    expect(unset.env).not.toHaveProperty("PUPPETEER_EXECUTABLE_PATH");
  });
});
