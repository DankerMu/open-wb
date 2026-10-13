/**
 * Issue #1273（前一半）：`startCompiledServerWithRetry` 自己的测试。每例都跑真实的 compiled 入口；
 * 「端口被占」由测试在 `launchFor` 里（取到端口之后、子进程启动之前）真的监听上去造成。
 * 预览端口一例另钉住：与某次尝试绑定的显式 `PREVIEW_PORT` 在 `launchFor` 里新取才换得掉。
 * 监听类失败只认「`listen` 或 `preview_listen`」，不钉是哪一个（s1-followups-batch tasks 2a.4）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  expectBindable,
  releaseStartupFixtures,
  reserveWildcardPort,
} from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const NODE_SQLITE_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u;
const scratch: string[] = [];
const holders = new Set<Server>();
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

/** 每次尝试一个新的临时根：上一次失败的尝试建的 DB 不带进下一次。 */
function envFor(port: number, extra: Record<string, string> = {}): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "open-wb-startup-retry-"));
  scratch.push(root);
  return compiledFixtureEnv(root, port, join(root, "bin", "omp"), extra);
}

/** 在入口要绑的同一个 host:port 上先监听，占住它。 */
function hold(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const holder = createServer();
    holder.once("error", reject);
    holder.listen(port, "127.0.0.1", () => {
      holders.add(holder);
      resolve();
    });
  });
}

async function releaseHolders(): Promise<void> {
  for (const holder of holders) {
    await new Promise((resolve) => holder.close(resolve));
    holders.delete(holder);
  }
}

/** 整段应用 stderr 恰是一行失败记录；返回它的 `reason`。 */
function failureReason(stderr: string): unknown {
  const record = JSON.parse(stderr.replace(NODE_SQLITE_WARNING, "")) as Record<string, unknown>;
  expect(Object.keys(record)).toEqual(["event", "reason"]);
  expect(record.event).toBe("server_start_failed");
  return record.reason;
}

describe("startCompiledServerWithRetry (#1273)", () => {
  it("retries on another port when the first port is taken before the entry starts", async () => {
    const ports: number[] = [];
    try {
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, async (port) => {
        ports.push(port);
        if (ports.length === 1) {
          await hold(port);
        }
        return { env: envFor(port) };
      });
      try {
        expect(await server.waitForStarted()).toMatchObject({ event: "server_started", port });
        expect(ports).toHaveLength(2);
        expect(port).toBe(ports[1]);
        expect(port).not.toBe(ports[0]);
        // 返回的端口上是入口自己：它答 HTTP（占位的裸 TCP 监听器不会）。
        const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(response.status).toBe(401);
        expect(await server.stop()).toBe(0);
      } finally {
        await server.dispose();
      }
    } finally {
      await releaseHolders();
    }
  }, 60_000);

  it("retries when the explicit preview port chosen for the first attempt is taken", async () => {
    const previewPorts: number[] = [];
    try {
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, async (port) => {
        const previewPort = await reserveWildcardPort();
        previewPorts.push(previewPort);
        if (previewPorts.length === 1) {
          await hold(previewPort);
        }
        return { env: envFor(port, { PREVIEW_PORT: String(previewPort) }) };
      });
      try {
        expect(await server.waitForStarted()).toMatchObject({ event: "server_started", port });
        expect(previewPorts).toHaveLength(2);
        expect(previewPorts[1]).not.toBe(previewPorts[0]);
        expect(await server.stop()).toBe(0);
      } finally {
        await server.dispose();
      }
    } finally {
      await releaseHolders();
    }
  }, 60_000);

  it("hands back the last listen failure untouched when all three ports are taken", async () => {
    const ports: number[] = [];
    try {
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, async (port) => {
        ports.push(port);
        await hold(port);
        return { env: envFor(port) };
      });
      try {
        expect(ports).toHaveLength(3);
        expect(port).toBe(ports[2]);
        expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
        expect(server.stdout()).toBe("");
        expect(["listen", "preview_listen"]).toContain(failureReason(server.stderr()));
        await expect(server.waitForStarted()).rejects.toThrow(
          "compiled entry exited before server_started code=1 signal=null",
        );
      } finally {
        await server.dispose();
      }
    } finally {
      await releaseHolders();
    }
  }, 60_000);

  it("does not retry a failure outside the listen stages: config starts exactly once", async () => {
    const ports: number[] = [];
    const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => {
      ports.push(port);
      return { env: envFor(port, { PORT: "abc" }) };
    });
    try {
      expect(ports).toEqual([port]);
      expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
      expect(server.stdout()).toBe("");
      expect(failureReason(server.stderr())).toBe("config");
      await expectBindable("127.0.0.1", port);
    } finally {
      await server.dispose();
    }
  }, 60_000);
});
