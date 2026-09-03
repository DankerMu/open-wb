import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

describe("import server.ts 不命中 ESM main guard 时零副作用", () => {
  it("不创建/改写 repo var DB、不注册 signal、不发出 application JSON，只暴露配置 seam", async () => {
    const envKeys = ["HOST", "PORT", "DB_PATH", "STATIC_ROOT"] as const;
    const saved = new Map<string, string | undefined>();
    for (const key of envKeys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }

    const varPath = join(REPO_ROOT, "var");
    const varExisted = existsSync(varPath);
    const devDbPath = join(varPath, "dev.db");
    const devDbExisted = existsSync(devDbPath);
    const devDbBytes = devDbExisted ? readFileSync(devDbPath) : undefined;
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    const stdoutSpy = vi.spyOn(process.stdout, "write");
    const stderrSpy = vi.spyOn(process.stderr, "write");

    let imported: unknown;
    try {
      imported = await import("../src/server.js");
    } finally {
      const appRecords = [...stdoutSpy.mock.calls, ...stderrSpy.mock.calls]
        .map((call) => String(call[0]))
        .filter((line) => line.includes("server_started") || line.includes("server_start_failed"));
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      for (const key of envKeys) {
        const previous = saved.get(key);
        if (previous === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous;
        }
      }

      expect(appRecords).toEqual([]);
      expect(existsSync(varPath)).toBe(varExisted);
      expect(existsSync(devDbPath)).toBe(devDbExisted);
      if (devDbExisted && devDbBytes !== undefined) {
        expect(readFileSync(devDbPath)).toEqual(devDbBytes);
      }
      expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
      expect(imported).toBeDefined();
      expect(typeof (imported as { resolveServerConfig?: unknown }).resolveServerConfig).toBe(
        "function",
      );
    }
  });
});
