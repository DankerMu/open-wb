/**
 * Issue #1529 omp-runtime「子进程 spawn 契约」scenario「环境白名单」(the `PUPPETEER_EXECUTABLE_PATH`,
 * `PI_BROWSER_*` and `PUPPETEER_PROXY*` WHENs) and omp-uid-isolation「OMP_USER 配置与 sudo spawn
 * 前缀」scenario「sudo 保留浏览器路径」, on the captured `spawnOmp` call. `PUPPETEER_EXECUTABLE_PATH`
 * comes only from the deployment's `BROWSER_BIN` (`browserBin`), after `LANG`/`TMPDIR`;
 * `PI_BROWSER_RELAY=0`, `PI_BROWSER_CMUX=0`, `PUPPETEER_PROXY=direct://` and
 * `PUPPETEER_PROXY_IGNORE_CERT_ERRORS=0` are always set; nothing of the parent's browser or proxy
 * variables reaches the child; the sudo `--preserve-env=` element is one fixed string. The key set,
 * the pinned values and the literal are the spec's; the key order is from the implementation and
 * design D4 (the spec fixes the set). None of it is derived from `src/sessions/omp/`.
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
  PUPPETEER_PROXY: "http://192.0.2.1:9",
  PUPPETEER_PROXY_IGNORE_CERT_ERRORS: "1",
  http_proxy: "http://192.0.2.1:9",
};
const PRESERVE_ENV =
  "--preserve-env=PATH,LANG,TMPDIR,HOME,XDG_DATA_HOME,XDG_STATE_HOME,XDG_CACHE_HOME,PI_CODING_AGENT_DIR,PI_CONFIG_FILES,PI_CONFIG_DIR,OMP_PROFILE,PI_PROFILE,WORKBUDDY_MODEL_TOKEN,PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_PROXY,PUPPETEER_PROXY_IGNORE_CERT_ERRORS,PUPPETEER_EXECUTABLE_PATH";
/** The closed key set in the order D4 builds it; `PUPPETEER_EXECUTABLE_PATH` comes last. */
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
  "PUPPETEER_PROXY",
  "PUPPETEER_PROXY_IGNORE_CERT_ERRORS",
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

/** The four pins hold their literals whatever the parent carries. */
function expectPins(call: Captured): void {
  expect(call.env.PI_BROWSER_RELAY).toBe("0");
  expect(call.env.PI_BROWSER_CMUX).toBe("0");
  expect(call.env.PUPPETEER_PROXY).toBe("direct://");
  expect(call.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS).toBe("0");
}

/** No parent browser or proxy value anywhere in the call, and no browser `KEY=value` argv element. */
function expectNoParentBrowserValues(call: Captured): void {
  const dump = JSON.stringify([call.env, call.args]);
  for (const value of ["/opt/other", "/opt/parent-browser-bin", "/tmp/x.sock", "192.0.2.1"]) {
    expect(dump).not.toContain(value);
  }
  expect(call.env).not.toHaveProperty("BROWSER_BIN");
  expect(call.env).not.toHaveProperty("CMUX_SOCKET_PATH");
  expect(call.env).not.toHaveProperty("http_proxy");
  for (const key of [
    "PUPPETEER_EXECUTABLE_PATH",
    "PI_BROWSER_RELAY",
    "PI_BROWSER_CMUX",
    "PUPPETEER_PROXY",
    "PUPPETEER_PROXY_IGNORE_CERT_ERRORS",
  ]) {
    expect(call.args.some((arg) => arg.startsWith(`${key}=`))).toBe(false);
  }
}

describe("spawnOmp browser environment", () => {
  it.each([undefined, "omp"])(
    "BROWSER_BIN unset (ompUser %s): no PUPPETEER_EXECUTABLE_PATH, the four pins hold",
    async (ompUser) => {
      const call = await capture(ompUser === undefined ? {} : { ompUser });

      expect(Object.keys(call.env)).toEqual(KEYS);
      expectPins(call);
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
      expectPins(call);
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

  it("sudo: one fixed --preserve-env element ending in the five browser keys, set or unset", async () => {
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
        /,WORKBUDDY_MODEL_TOKEN,PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_PROXY,PUPPETEER_PROXY_IGNORE_CERT_ERRORS,PUPPETEER_EXECUTABLE_PATH$/u,
      );
      expectPins(call);
      expectNoParentBrowserValues(call);
    }
    expect(set.env.PUPPETEER_EXECUTABLE_PATH).toBe(CHROMIUM);
    expect(unset.env).not.toHaveProperty("PUPPETEER_EXECUTABLE_PATH");
  });
});
