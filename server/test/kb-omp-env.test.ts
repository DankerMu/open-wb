/**
 * s2a-kb-ragflow tasks 4.3（#1839）：ragflow-backend「密钥不进 omp 环境」。真实 compiled 入口，知识库已配置，
 * 一次真实的 omp spawn：假 omp 的启动器先把自己拿到的整个环境写进文件，再转给 `fake-omp.mjs`。
 *
 * spawn 环境本来就是白名单：这是不变量的守卫，改动之前的源码上同样绿，靠往 `ompSpawnEnv` 注入泄露才红。
 * sudo 形状（`OMP_USER`）要真实 sudo，这里钉 `--preserve-env` 名单与 `OMP_CHILD_ENV_NAMES`。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OMP_CHILD_ENV_NAMES, SUDO_PRESERVE_ENV } from "../src/sessions/omp/spawn-env.js";
import {
  compiledFixtureEnv,
  compileServerEntry,
  createSession,
  login,
  prompt,
  releaseStartupFixtures,
  waitForFile,
  writeFakeOmpLauncher,
} from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const KB_KEY = "ragflow-key-sentinel-1839";
const KB_NAMES = ["RAGFLOW_API_KEY_FILE", "RAGFLOW_BASE_URL"];
const scratch: string[] = [];

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 假 omp 的启动器：环境先写临时文件再改名，`waitForFile` 看到的永远是完整内容。 */
function envRecordingOmp(root: string, envDump: string): string {
  mkdirSync(join(root, "bin"), { recursive: true });
  const inner = writeFakeOmpLauncher(root, "hang-eof");
  const bin = join(root, "bin", "env-recording-omp.mjs");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(`${envDump}.tmp`)}, JSON.stringify(process.env));
renameSync(${JSON.stringify(`${envDump}.tmp`)}, ${JSON.stringify(envDump)});
await import(${JSON.stringify(inner)});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("密钥不进 omp 环境", () => {
  it("a spawned omp has no RAGFLOW_* name and no value equal to the key", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-wb-kb-omp-env-"));
    scratch.push(root);
    const keyFile = join(root, "ragflow.key");
    writeFileSync(keyFile, `${KB_KEY}\n`);
    chmodSync(keyFile, 0o600);
    const envDump = join(root, "omp-env.json");
    const bin = envRecordingOmp(root, envDump);
    const compiled = await compileServerEntry();
    const { server, port } = await startCompiledServerWithRetry(compiled.entry, (attempt) => ({
      env: compiledFixtureEnv(root, attempt, bin, {
        RAGFLOW_BASE_URL: "http://127.0.0.1:9",
        RAGFLOW_API_KEY_FILE: keyFile,
      }),
    }));
    try {
      await server.waitForStarted();
      const cookie = await login(port);
      await prompt(port, cookie, await createSession(port, cookie), "spawn-omp");
      await waitForFile(envDump, 15_000);
      const env = JSON.parse(readFileSync(envDump, "utf8")) as Record<string, string>;
      // 记录下来的确是 spawn 的环境，不是空对象：白名单里的 token 在。
      expect(env).toHaveProperty("WORKBUDDY_MODEL_TOKEN");
      for (const name of KB_NAMES) {
        expect(env).not.toHaveProperty(name);
      }
      expect(Object.keys(env).filter((name) => name.startsWith("RAGFLOW"))).toEqual([]);
      expect(Object.values(env).filter((value) => value.includes(KB_KEY))).toEqual([]);
      expect(Object.values(env)).not.toContain(keyFile);
    } finally {
      await server.dispose();
    }
  }, 90_000);

  it("sudo keeps neither name, and neither is a name the omp process is known to have", () => {
    const preserved = SUDO_PRESERVE_ENV.slice("--preserve-env=".length).split(",");
    for (const name of KB_NAMES) {
      expect(preserved).not.toContain(name);
      expect(OMP_CHILD_ENV_NAMES.has(name)).toBe(false);
    }
  });
});
