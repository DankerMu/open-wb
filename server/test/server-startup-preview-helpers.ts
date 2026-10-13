/**
 * `server-startup-preview.test.ts`（#1070）与 `server-startup-office.test.ts`（#1074）共用：起真实的
 * compiled production 入口（两个端口都显式预留，见 #1273 / #1337；`startEntry` 何时带重试见其注释）、经主监听器的真实路由开一个正式
 * 工作空间并签发预览令牌。编译产物与临时目录按测试文件各一份（每个文件自己的模块实例）：
 * `beforeAll(compileEntry)`、`afterAll(releaseEntries)`。自 `server-startup-preview.test.ts` 原样搬出。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  login,
  releaseStartupFixtures,
  reserveWildcardPort,
  type StartedServer,
  startCompiledServer,
} from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

/** 种子账号 zhangsan 的 id：回收目录的账号一级以它命名。 */
export const ZHANGSAN = "u1";
const scratch: string[] = [];
let compiled: CompiledServerEntry | undefined;

/** 编译一次真实入口；放进 `beforeAll`（编译比单个用例的时限长）。 */
export async function compileEntry(): Promise<void> {
  compiled = await compileServerEntry();
}

/** 回收本文件起过的进程组、编译产物与临时目录；放进 `afterAll`。 */
export async function releaseEntries(): Promise<void> {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface Entry {
  server: StartedServer;
  root: string;
  port: number;
  /** 显式给了 PREVIEW_PORT 时才有意义；缺省端口的用例从签发响应里取。 */
  previewPort: number;
  readTrace(): string;
}

interface EntryOptions {
  ports?: { port: number; previewPort: number };
  previewPort?: "default" | "same-as-main";
  env?: (root: string) => Record<string, string>;
  hook?: string;
  prepare?: (root: string) => void;
  /** 钩子把启动扣在 `server_started` 之前、由用例自己推进：不等启动结果就交还。 */
  held?: true;
}

/**
 * 起入口。端口缺省各预留一个；`ports` 由调用方先定（要先占住再起）；`previewPort: "default"` 时
 * 不设 PREVIEW_PORT。`hook` 是预加载的源码文本。
 * 带重试（`startCompiledServerWithRetry`，#1273）还是只起一次：给了 `ports`、`previewPort` 为
 * `"same-as-main"`（这两种的监听类失败是用例有意造成的）或 `held`（辅助函数会先等满
 * `server_started` 的时限）时只起一次、立即交还；其余情况带重试，交还时入口已发出
 * `server_started` 或已自行退出，根目录、trace 与预览端口都是最后那次尝试的（每次尝试各取新的）。
 */
export async function startEntry(options: EntryOptions = {}): Promise<Entry> {
  if (compiled === undefined) {
    throw new Error("SETUP: compileEntry() has not run");
  }
  if (
    options.ports !== undefined ||
    options.previewPort === "same-as-main" ||
    options.held === true
  ) {
    const port = options.ports?.port ?? (await reserveWildcardPort());
    const previewPort =
      options.ports?.previewPort ??
      (options.previewPort === "same-as-main" ? port : await reserveWildcardPort());
    const attempt = prepareAttempt(options, port, previewPort);
    const { env, ...launch } = attempt.launch;
    return entryOf(startCompiledServer(compiled.entry, env, launch), port, attempt);
  }
  let last: Attempt | undefined;
  const { server, port } = await startCompiledServerWithRetry(compiled.entry, async (port) => {
    last = prepareAttempt(options, port, await reserveWildcardPort());
    return last.launch;
  });
  if (last === undefined) {
    throw new Error("SETUP: the retrying helper returned without launching");
  }
  return entryOf(server, port, last);
}

interface Attempt {
  root: string;
  previewPort: number;
  trace: string;
  launch: { env: Record<string, string>; orderTrace: string; requireHook?: string };
}

/** 一次尝试自己的根目录（`prepare` 在里面布置）、trace 文件与钩子文件。 */
function prepareAttempt(options: EntryOptions, port: number, previewPort: number): Attempt {
  const root = mkdtempSync(join(tmpdir(), "open-wb-startup-preview-"));
  scratch.push(root);
  options.prepare?.(root);
  const trace = join(root, "order.log");
  const hookPath = join(root, "preload.cjs");
  if (options.hook !== undefined) {
    writeFileSync(hookPath, options.hook);
  }
  return {
    root,
    previewPort,
    trace,
    launch: {
      env: compiledFixtureEnv(root, port, join(root, "bin", "missing-omp"), {
        ...(options.previewPort === "default" ? {} : { PREVIEW_PORT: String(previewPort) }),
        ...options.env?.(root),
      }),
      orderTrace: trace,
      ...(options.hook === undefined ? {} : { requireHook: hookPath }),
    },
  };
}

function entryOf(server: StartedServer, port: number, attempt: Attempt): Entry {
  const { root, previewPort, trace } = attempt;
  return {
    server,
    root,
    port,
    previewPort,
    readTrace: () => (existsSync(trace) ? readFileSync(trace, "utf8") : ""),
  };
}

/**
 * 入口启动时不建 SANDBOX_ROOT，而它不存在时 `POST /api/workspaces` 答 500（既有行为，不属本文件）：
 * 要建正式工作空间的用例先把它建好。
 */
export function makeSandboxRoot(root: string): void {
  mkdirSync(join(root, "sandbox"));
}

interface Workspace {
  cookie: string;
  id: string;
  root: string;
  /** `http://127.0.0.1:<预览端口>/w/<token>/` */
  base: string;
  /** 令牌响应里的 `officeAvailable`，原样。 */
  officeAvailable: boolean;
}

/** 登录 → 建正式工作空间 → 签发预览令牌，全部经主监听器的真实路由。 */
export async function openWorkspace(entry: Entry): Promise<Workspace> {
  const cookie = await login(entry.port);
  const post = async (path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`http://127.0.0.1:${entry.port}${path}`, {
      method: "POST",
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const created = await post("/api/workspaces", { name: "preview-entry", dir: "preview-entry" });
  expect(created.status).toBe(201);
  const { id } = created.body as { id: string };
  const issued = await post(`/api/workspaces/${id}/preview-token`);
  expect(issued.status).toBe(200);
  const { base, officeAvailable } = issued.body as { base: string; officeAvailable: boolean };
  return {
    cookie,
    id,
    // 沙箱里的落点由账号 id 与空间目录名决定（workspaces「工作空间根」），不取自响应。
    root: join(entry.root, "sandbox", ZHANGSAN, "preview-entry"),
    base,
    officeAvailable,
  };
}
