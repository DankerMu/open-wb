/**
 * Issue #802 omp-runtime「子进程 spawn 契约」/「工作目录 dotenv 钉住」: the five variables that decide
 * where omp reads its managed configuration are set explicitly on every spawn, so a `.env` that omp
 * loads cannot supply them. Key set, literal values and the sudo prefix are written out from the
 * spec, not derived from `src/sessions/omp/process.ts`. #1529: the key set also holds the four
 * browser pins, and the sudo list ends in them and `PUPPETEER_EXECUTABLE_PATH`. #1575: and
 * `OTEL_SDK_DISABLED=true`, whatever the parent's `OTEL_*`, named in the sudo list before
 * `PUPPETEER_EXECUTABLE_PATH`. #1615: and `no_proxy=*` / `NO_PROXY=*`, whatever the parent's proxy
 * variables, named in the sudo list after `OTEL_SDK_DISABLED`.
 */
import type { SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SpawnImpl, spawnOmp } from "../src/sessions/omp/process.js";
import { ompHostOverlayPath } from "../src/sessions/omp/state-layout.js";
import { FakeChild } from "./support/omp-rpc.js";
import { useSetprivStub } from "./support/setpriv.js";

const OWNER = "u1";
const TOKEN = "c".repeat(64);
/** What a parent environment (or an inherited dotenv) could carry; none of it may reach the child. */
const PARENT: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  TMPDIR: "/tmp/pins tmp",
  PI_CODING_AGENT_DIR: "/tmp/parent-agent-sentinel",
  PI_CONFIG_FILES: "/tmp/parent-overlay-sentinel.yml",
  OMP_CONFIG_FILES: "/tmp/parent-omp-overlay-sentinel.yml",
  PI_CONFIG_DIR: "parent-config-dir-sentinel",
  OMP_PROFILE: "parentprofile",
  PI_PROFILE: "parentlegacyprofile",
};

/** omp-runtime「环境白名单」#1575 WHEN: a parent that would turn OTLP export on, to an outside address. */
const OTEL_PARENT: Record<string, string> = {
  OTEL_SDK_DISABLED: "false",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://192.0.2.1:4318",
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true",
};

/**
 * omp-runtime「环境白名单」#1615 WHEN: a parent that would proxy the model requests, with exemptions
 * that do not match the model endpoint.
 */
const PROXY_PARENT: Record<string, string> = {
  HTTP_PROXY: "http://192.0.2.1:9",
  ALL_PROXY: "http://192.0.2.1:9",
  no_proxy: "example.invalid",
  NO_PROXY: "example.invalid",
};

interface Captured {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stateDir: string;
  bin: string;
}

const temps: string[] = [];
useSetprivStub();

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function capture(
  ompUser?: string,
  parent: Record<string, string> = {},
  browserBin?: string,
): Promise<Captured> {
  const root = mkdtempSync(join(tmpdir(), "omp-dotenv-pins-"));
  temps.push(root);
  const stateDir = join(root, "state dir");
  const bin = join(root, "bin", "omp");
  for (const [key, value] of Object.entries({ ...PARENT, ...parent })) {
    vi.stubEnv(key, value);
  }
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return new FakeChild().spawnImpl(command, args, options);
  };
  await spawnOmp(
    {
      bin,
      sandboxRoot: join(root, "sandbox"),
      stateDir,
      ownerId: OWNER,
      cwd: join(root, "sandbox", OWNER),
      modelId: "deepseek-v4.1-flash",
      approvalMode: "write",
      token: TOKEN,
      resumePath: null,
      ...(ompUser === undefined ? {} : { ompUser }),
      ...(browserBin === undefined ? {} : { browserBin }),
    },
    spawnImpl,
  );
  expect(calls).toHaveLength(1);
  const call = calls[0];
  return {
    command: String(call?.command),
    args: call?.args ?? [],
    env: call?.options.env ?? {},
    stateDir,
    bin,
  };
}

describe("spawnOmp dotenv pins", () => {
  it.each([undefined, "omp_user"])(
    "sets the closed env key set with the five pinned variables (ompUser %s)",
    async (ompUser) => {
      const { env, args, stateDir } = await capture(ompUser);

      expect(Object.keys(env).toSorted()).toEqual([
        "HOME",
        "LANG",
        "NO_PROXY",
        "OMP_PROFILE",
        "OTEL_SDK_DISABLED",
        "PATH",
        "PI_BROWSER_CMUX",
        "PI_BROWSER_RELAY",
        "PI_CODING_AGENT_DIR",
        "PI_CONFIG_DIR",
        "PI_CONFIG_FILES",
        "PI_PROFILE",
        "PUPPETEER_PROXY",
        "PUPPETEER_PROXY_IGNORE_CERT_ERRORS",
        "TMPDIR",
        "WORKBUDDY_MODEL_TOKEN",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "no_proxy",
      ]);
      expect(env.PI_CONFIG_DIR).toBe(".omp");
      expect(env.OMP_PROFILE).toBe("default");
      expect(env.PI_PROFILE).toBe("default");
      // omp compares the agent dir with `$HOME/.omp/agent` as strings; only equality keeps XDG on.
      expect(env.HOME).toBe(join(stateDir, "home"));
      expect(env.PI_CODING_AGENT_DIR).toBe(join(String(env.HOME), ".omp", "agent"));
      expect(env.PI_CODING_AGENT_DIR).toBe(`${stateDir}/home/.omp/agent`);
      expect(env.PI_CONFIG_FILES).toBe(`${stateDir}/home/.omp/agent/host-overlay.yml`);
      expect(env.PI_CONFIG_FILES).toBe(ompHostOverlayPath(stateDir));
      expect(env.PI_CONFIG_FILES).toBe(args[args.indexOf("--config") + 1]);
      expect(env.XDG_DATA_HOME).toBe(join(stateDir, "xdg", "data"));
      expect(env.WORKBUDDY_MODEL_TOKEN).toBe(TOKEN);
      expect(env.OTEL_SDK_DISABLED).toBe("true");
      expect(env.no_proxy).toBe("*");
      expect(env.NO_PROXY).toBe("*");
      for (const sentinel of Object.values(PARENT).filter((value) => value.includes("sentinel"))) {
        expect(JSON.stringify([env, args])).not.toContain(sentinel);
      }
      expect(JSON.stringify([env, args])).not.toContain("parentprofile");
      expect(JSON.stringify([env, args])).not.toContain("parentlegacyprofile");
    },
  );

  it.each([undefined, "/usr/bin/chromium"])(
    "pins OTEL_SDK_DISABLED=true over the parent's OTEL_* (BROWSER_BIN %s)",
    async (browserBin) => {
      const { env, args } = await capture(undefined, OTEL_PARENT, browserBin);

      expect(env.OTEL_SDK_DISABLED).toBe("true");
      expect(env).not.toHaveProperty("OTEL_EXPORTER_OTLP_ENDPOINT");
      expect(env).not.toHaveProperty("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT");
      expect(Object.keys(env).filter((key) => key.startsWith("OTEL_"))).toEqual([
        "OTEL_SDK_DISABLED",
      ]);
      expect(JSON.stringify([env, args])).not.toContain("192.0.2.1");
      if (browserBin === undefined) {
        expect(env).not.toHaveProperty("PUPPETEER_EXECUTABLE_PATH");
      } else {
        expect(env.PUPPETEER_EXECUTABLE_PATH).toBe(browserBin);
      }
    },
  );

  it.each([undefined, "/usr/bin/chromium"])(
    "pins no_proxy=* and NO_PROXY=* over the parent's proxy variables (BROWSER_BIN %s)",
    async (browserBin) => {
      const { env, args } = await capture(undefined, PROXY_PARENT, browserBin);

      expect(env.no_proxy).toBe("*");
      expect(env.NO_PROXY).toBe("*");
      expect(env).not.toHaveProperty("HTTP_PROXY");
      expect(env).not.toHaveProperty("ALL_PROXY");
      // The browser's own PUPPETEER_PROXY pin aside, the two exemptions are the only proxy keys.
      const proxyKeys = Object.keys(env).filter(
        (key) => /proxy/iu.test(key) && !key.startsWith("PUPPETEER_"),
      );
      expect(proxyKeys.toSorted()).toEqual(["NO_PROXY", "no_proxy"]);
      expect(JSON.stringify([env, args])).not.toContain("192.0.2.1");
      expect(JSON.stringify([env, args])).not.toContain("example.invalid");
      if (browserBin === undefined) {
        expect(env).not.toHaveProperty("PUPPETEER_EXECUTABLE_PATH");
      } else {
        expect(env.PUPPETEER_EXECUTABLE_PATH).toBe(browserBin);
      }
    },
  );

  it("names the five variables in the sudo --preserve-env list, in the contract's order", async () => {
    const { command, args, bin } = await capture("omp_user");

    expect(command).toBe("sudo");
    expect(args.slice(0, args.indexOf(bin) + 1)).toEqual([
      "-n",
      "-u",
      "omp_user",
      "--preserve-env=PATH,LANG,TMPDIR,HOME,XDG_DATA_HOME,XDG_STATE_HOME,XDG_CACHE_HOME,PI_CODING_AGENT_DIR,PI_CONFIG_FILES,PI_CONFIG_DIR,OMP_PROFILE,PI_PROFILE,WORKBUDDY_MODEL_TOKEN,PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_PROXY,PUPPETEER_PROXY_IGNORE_CERT_ERRORS,OTEL_SDK_DISABLED,no_proxy,NO_PROXY,PUPPETEER_EXECUTABLE_PATH",
      "TMPDIR=/tmp/pins tmp",
      "--",
      "/usr/bin/setpriv",
      "--pdeathsig",
      "KILL",
      "--",
      bin,
    ]);
  });

  it("leaves argv untouched: --config stays the last option of a cold spawn", async () => {
    const { command, args, stateDir, bin } = await capture();

    expect(command).toBe(bin);
    expect(args.slice(-3)).toEqual([
      "--no-title",
      "--config",
      `${stateDir}/home/.omp/agent/host-overlay.yml`,
    ]);
    expect(args.some((arg) => arg.startsWith("PI_") || arg.startsWith("OMP_"))).toBe(false);
  });
});
