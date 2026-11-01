/**
 * 真实 compiled production 入口，知识库已配置（s2a-kb-ragflow tasks 4.3，#1839）：ragflow-backend「密钥文件不合规
 * 即启动失败」的六例与合规一例；http-service-skeleton「知识库键与密钥文件阶段」的前六例与最后一例。最后一例本组只
 * 断言启动成功与十一项模块，「十二项且最后是 `kb`」由组 6 断言。期望的行是规格的字节。
 *
 * 密钥文件的路径与内容都带哨兵：失败记录长出错误文本时，两个哨兵先红，不只是行形状红。
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveServerConfig } from "../src/server.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  releaseStartupFixtures,
  reserveWildcardPort,
} from "./server-startup-helpers.js";
import {
  applicationStderr,
  expectNeverListened,
  type ListenerTrace,
  startListenTraced,
} from "./server-startup-order-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const CONTENT_SENTINEL = "ragflow-key-sentinel-1839";
const PATH_SENTINEL = "PATHSENTINEL1839zq";
/** 没有东西在听的回环端口：启动不连 RAGFlow，这里只需要一个合法地址。 */
const CLOSED_RAGFLOW = "http://127.0.0.1:9";
const ELEVEN_MODULES = [
  "core/db",
  "auth",
  "http",
  "model-proxy",
  "sessions",
  "workspaces",
  "accounts",
  "models",
  "experts",
  "skills",
  "connectors",
];
const CASE_MS = 60_000;
const scratch: string[] = [];
let compiled: CompiledServerEntry;

beforeAll(async () => {
  compiled = await compileServerEntry();
}, 90_000);

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "open-wb-startup-kb-"));
  scratch.push(root);
  return root;
}

function keyPathIn(root: string): string {
  return join(root, `key-${PATH_SENTINEL}`);
}

/** `mode` 经 chmod 落下，不受 umask 影响。 */
function writeKeyFile(root: string, content: string, mode = 0o600): string {
  const path = keyPathIn(root);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

interface Failure extends ListenerTrace {
  stdout: string;
  stderr: string;
}

/** 跑到入口自己退出：退出码 1。 */
async function failStartup(
  root: string,
  extra: Record<string, string>,
  requireHook?: string,
): Promise<Failure> {
  const { server, port, listenerLines } = await startListenTraced(
    compiled.entry,
    root,
    (attemptPort) => ({
      env: compiledFixtureEnv(root, attemptPort, join(root, "bin", "omp"), extra),
      ...(requireHook === undefined ? {} : { requireHook }),
    }),
  );
  try {
    expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
    return { port, listenerLines, stdout: server.stdout(), stderr: server.stderr() };
  } finally {
    await server.dispose();
  }
}

/** 整个 application stderr 恰一行 `reason` 的记录，stdout 为空，配置之后的副作用一样都没有。 */
function expectFailedBeforeAnyEffect(root: string, failure: Failure, reason: string): void {
  const output = failure.stdout + failure.stderr;
  expect(output).not.toContain(CONTENT_SENTINEL);
  expect(output).not.toContain(PATH_SENTINEL);
  expect(failure.stdout).toBe("");
  expect(applicationStderr(failure.stderr)).toBe(
    `{"event":"server_start_failed","reason":"${reason}"}\n`,
  );
  for (const effect of ["db", "state", "sandbox", "preview-cache"]) {
    expect(existsSync(join(root, effect)), effect).toBe(false);
  }
  expectNeverListened(failure);
}

describe("密钥文件不合规即启动失败", () => {
  const compliant = `${CONTENT_SENTINEL}\n`;
  it.each([
    ["mode 0644", compliant, 0o644],
    ["an empty file", "", 0o600],
    ["content with a CR", `${CONTENT_SENTINEL}\rrest`, 0o600],
    ["4097 bytes", `${CONTENT_SENTINEL}${"k".repeat(4097 - CONTENT_SENTINEL.length)}`, 0o600],
    ["exactly \\n\\n", "\n\n", 0o600],
  ])(
    "%s fails at kb_key with nothing created and no file content in the output",
    async (_label, content, mode) => {
      const root = scratchRoot();
      const failure = await failStartup(root, {
        RAGFLOW_BASE_URL: CLOSED_RAGFLOW,
        RAGFLOW_API_KEY_FILE: writeKeyFile(root, content, mode),
      });
      expectFailedBeforeAnyEffect(root, failure, "kb_key");
    },
    CASE_MS,
  );

  it(
    "a symlink to a compliant file fails at kb_key",
    async () => {
      const root = scratchRoot();
      const target = join(root, "compliant");
      writeFileSync(target, CONTENT_SENTINEL, { mode: 0o600 });
      const link = keyPathIn(root);
      symlinkSync(target, link);
      const failure = await failStartup(root, {
        RAGFLOW_BASE_URL: CLOSED_RAGFLOW,
        RAGFLOW_API_KEY_FILE: link,
      });
      expectFailedBeforeAnyEffect(root, failure, "kb_key");
    },
    CASE_MS,
  );

  it(
    "a compliant 0600 file starts, and the key is in no output",
    async () => {
      const root = scratchRoot();
      const keyFile = writeKeyFile(root, `${CONTENT_SENTINEL}\n`);
      const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), {
          RAGFLOW_BASE_URL: CLOSED_RAGFLOW,
          RAGFLOW_API_KEY_FILE: keyFile,
        }),
      }));
      try {
        await server.waitForStarted();
        expect(await server.stop()).toBe(0);
        expect(server.stdout() + server.stderr()).not.toContain(CONTENT_SENTINEL);
        expect(applicationStderr(server.stderr())).toBe("");
      } finally {
        await server.dispose();
      }
    },
    CASE_MS,
  );
});

describe("知识库键与密钥文件阶段", () => {
  it.each([
    ["only RAGFLOW_BASE_URL", { RAGFLOW_BASE_URL: CLOSED_RAGFLOW }, "RAGFLOW_API_KEY_FILE"],
    ["only RAGFLOW_API_KEY_FILE", { RAGFLOW_API_KEY_FILE: "/etc/key" }, "RAGFLOW_BASE_URL"],
    [
      "RAGFLOW_BASE_URL=https://h/path",
      { RAGFLOW_BASE_URL: "https://h/path", RAGFLOW_API_KEY_FILE: "/etc/key" },
      "RAGFLOW_BASE_URL",
    ],
    [
      "RAGFLOW_API_KEY_FILE=relative/key",
      { RAGFLOW_BASE_URL: CLOSED_RAGFLOW, RAGFLOW_API_KEY_FILE: "relative/key" },
      "RAGFLOW_API_KEY_FILE",
    ],
    ["KB_UPLOAD_MAX_BYTES=0", { KB_UPLOAD_MAX_BYTES: "0" }, "KB_UPLOAD_MAX_BYTES"],
  ])(
    "%s fails at config before any effect, the message naming the key and not the value",
    async (_label, env, key) => {
      const root = scratchRoot();
      const failure = await failStartup(root, env);
      expectFailedBeforeAnyEffect(root, failure, "config");
      expect(() => resolveServerConfig(env, SOURCE_ENTRY)).toThrow(key);
      expect(() => resolveServerConfig(env, SOURCE_ENTRY)).not.toThrow("/path");
      expect(() => resolveServerConfig(env, SOURCE_ENTRY)).not.toThrow("relative/key");
    },
    CASE_MS,
  );

  it(
    "both keys and a 0644 key file fail at kb_key: the DB file does not exist",
    async () => {
      const root = scratchRoot();
      const failure = await failStartup(root, {
        RAGFLOW_BASE_URL: CLOSED_RAGFLOW,
        RAGFLOW_API_KEY_FILE: writeKeyFile(root, CONTENT_SENTINEL, 0o644),
      });
      expectFailedBeforeAnyEffect(root, failure, "kb_key");
      expect(existsSync(join(root, "db", "dev.db"))).toBe(false);
    },
    CASE_MS,
  );

  it(
    "both keys, a compliant file and a closed RAGFlow port start normally with eleven modules",
    async () => {
      const root = scratchRoot();
      const keyFile = writeKeyFile(root, CONTENT_SENTINEL);
      const closed = await reserveWildcardPort();
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, (attempt) => ({
        env: compiledFixtureEnv(root, attempt, join(root, "bin", "omp"), {
          RAGFLOW_BASE_URL: `http://127.0.0.1:${closed}`,
          RAGFLOW_API_KEY_FILE: keyFile,
        }),
      }));
      try {
        expect(await server.waitForStarted()).toEqual({
          event: "server_started",
          host: "127.0.0.1",
          port,
          modules: ELEVEN_MODULES,
        });
      } finally {
        await server.dispose();
      }
    },
    CASE_MS,
  );

  it(
    "no knowledge base keys start normally: nothing about a key file is checked",
    async () => {
      const root = scratchRoot();
      const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), {}),
      }));
      try {
        await server.waitForStarted();
      } finally {
        await server.dispose();
      }
    },
    CASE_MS,
  );
});

/**
 * 「对同一个 fd 做 fstat，再从该 fd 读取」：钩子在密钥文件打开成功后立刻把路径换成一个 `0644`、内容含 `\r` 的
 * 文件。判定与读取都走描述符才看得到原来那个合规文件；判定回到路径会看到 `0644`，读取回到路径会读到 `\r`，都以
 * `kb_key` 失败。钩子辅助复现，不是自然竞争。
 */
describe("the key file is judged and read through its descriptor", () => {
  it(
    "a refusable file swapped in at the path right after the open does not reach the stage",
    async () => {
      const root = scratchRoot();
      const keyFile = writeKeyFile(root, CONTENT_SENTINEL);
      const fired = join(root, "swap-fired");
      const hook = join(root, "swap-after-open.cjs");
      writeFileSync(
        hook,
        `'use strict';
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const target = ${JSON.stringify(keyFile)};
const nativeOpen = fs.openSync;
fs.openSync = function swapAfterOpen(path, ...rest) {
  const fd = nativeOpen.call(this, path, ...rest);
  if (path === target && !fs.existsSync(${JSON.stringify(fired)})) {
    fs.writeFileSync(${JSON.stringify(fired)}, '');
    fs.renameSync(target, target + '.original');
    fs.writeFileSync(target, 'swapped\\rcontent', { mode: 0o644 });
    fs.chmodSync(target, 0o644);
  }
  return fd;
};
syncBuiltinESMExports();
`,
      );
      const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), {
          RAGFLOW_BASE_URL: CLOSED_RAGFLOW,
          RAGFLOW_API_KEY_FILE: keyFile,
        }),
        requireHook: hook,
      }));
      try {
        await server.waitForStarted();
        expect(existsSync(fired)).toBe(true);
      } finally {
        await server.dispose();
      }
    },
    CASE_MS,
  );
});
