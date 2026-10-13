/**
 * Issue #1261（change s1-followups-batch 任务 4.3）：非法的 `MODEL_ID` 使真实的编译入口在任何
 * 文件系统 / 数据库 / 监听副作用之前失败；合法取值启动成功并逐字节出现在 composer options 里。
 * 期望的那一行是规格的字节（http-service-skeleton「服务启动与装配」场景「MODEL_ID 的取值规则」）；
 * 逐值的规则在 `server-config-model-id.test.ts`。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  getJson,
  login,
  releaseStartupFixtures,
} from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const NODE_SQLITE_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u;
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
  const root = mkdtempSync(join(tmpdir(), "open-wb-model-id-"));
  scratch.push(root);
  return root;
}

describe("MODEL_ID 的取值规则在编译入口上（#1261）", () => {
  it.each([
    ["首尾各一个空格", " custom-model "],
    // 42 个三字节的字加两个 ASCII 字符：恰 128 个 UTF-8 字节。
    ["恰 128 个 UTF-8 字节", `${"模".repeat(42)}ab`],
  ])(
    "%s：启动成功，composer options 的 models[0].id 与 defaults.modelId 逐字节等于它",
    async (_label, raw) => {
      // 每次尝试一个新的根：监听类失败换端口重来时不带上一次留下的 DB。
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => {
        const root = scratchRoot();
        return { env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID: raw }) };
      });
      try {
        await server.waitForStarted();
        const options = await getJson(port, "/api/composer/options", await login(port));
        expect(options.status).toBe(200);
        const body = options.body as {
          models: Array<{ id: string }>;
          defaults: { modelId: string };
        };
        expect(body.models.map((model) => model.id)).toStrictEqual([raw]);
        expect(body.defaults.modelId).toBe(raw);
      } finally {
        await server.dispose();
      }
    },
    60_000,
  );

  it('MODEL_ID="" → 退出码 1，stderr 恰一行 config 失败记录，没有 success record，DB 未创建', async () => {
    const root = scratchRoot();
    // 配置在 listen 之前就失败，端口只是一个合法的 PORT 取值，不会被绑定：辅助函数在这里不会重试。
    const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
      env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID: "" }),
    }));
    try {
      expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
      // success record 只写 stdout：整个 stdout 为空即没有它。
      expect(server.stdout()).toBe("");
      // node:sqlite 一被 import 运行时就打印实验性警告（实测：配置阶段失败时也有），它不是
      // application 的输出；去掉它之后 stderr 逐字节只有这一行。
      expect(server.stderr().replace(NODE_SQLITE_WARNING, "")).toBe(
        '{"event":"server_start_failed","reason":"config"}\n',
      );
      // 夹具的 DB_PATH 是 <root>/db/dev.db；另外三个受管目录同样没有被建出。
      expect(existsSync(join(root, "db"))).toBe(false);
      expect(existsSync(join(root, "state"))).toBe(false);
      expect(existsSync(join(root, "sandbox"))).toBe(false);
      expect(existsSync(join(root, "preview-cache"))).toBe(false);
    } finally {
      await server.dispose();
    }
  }, 60_000);
});
