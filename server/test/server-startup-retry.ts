/**
 * 带重试的启动辅助函数（#1273 的前一半，change s1-followups-batch design D2）。
 * `reserveWildcardPort()` 取到端口号后就关掉探针，端口号再交给子进程去 `listen`：两步之间别的
 * 进程可以先占住同一个端口，子进程以监听类失败退出（读代码推出；#1273 记录的那次假红未在本机
 * 复现）。这里包住「取端口 → `startCompiledServer` → 等 `server_started`」，遇监听类失败就换端口
 * 重来。有意让端口被占的用例不用它，继续用原来的两个函数。
 */
import {
  reserveWildcardPort,
  type StartedServer,
  startCompiledServer,
} from "./server-startup-helpers.js";

/** 一共起几次（含第一次）。 */
const ATTEMPTS = 3;
/** 换端口能解决的失败阶段；两个取值都在入口的失败阶段枚举里。 */
const LISTEN_REASONS: readonly unknown[] = ["listen", "preview_listen"];

/** 一次尝试的启动参数，含义同 `startCompiledServer` 的 `env` 与 `options`。 */
interface Launch {
  env: Record<string, string>;
  orderTrace?: string;
  requireHook?: string;
}

/**
 * 每次尝试：取一个端口 → `launchFor(port)` → `startCompiledServer` → 等 `server_started`。
 * - 子进程在 `server_started` 之前留下 `reason` 为 `listen` 或 `preview_listen` 的失败记录时，
 *   回收它（整组强杀并等关闭）再换端口重来，至多 `ATTEMPTS` 次。
 * - 成功、其它阶段的失败、等待超时、以及最后一次的监听类失败，都不动子进程，连同这次用的端口
 *   原样交还：调用方照旧调 `waitForStarted()` / `waitForClose()`，结果与直接用
 *   `startCompiledServer` 相同（`waitForStarted` 每次调用都从头判定）。
 * `launchFor` 每次尝试调用一次：与某次尝试绑定的东西（临时根目录、orderTrace 文件、显式的
 * `PREVIEW_PORT`）要在它里面新取，否则前一次失败的尝试留下的 DB 与 trace 行会带进下一次，
 * 被占的预览端口也换不掉。
 */
export async function startCompiledServerWithRetry(
  entry: string,
  launchFor: (port: number) => Launch | Promise<Launch>,
): Promise<{ server: StartedServer; port: number }> {
  for (let attempt = 1; ; attempt += 1) {
    const port = await reserveWildcardPort();
    const { env, ...options } = await launchFor(port);
    const server = startCompiledServer(entry, env, options);
    const started = await server.waitForStarted().then(
      () => true,
      () => false,
    );
    if (started || attempt === ATTEMPTS || !failedOnListen(server.stderr())) {
      return { server, port };
    }
    await server.dispose();
  }
}

/** stderr 里有没有一行 `server_start_failed` 记录，其 `reason` 是监听类；非 JSON 的行跳过。 */
function failedOnListen(stderr: string): boolean {
  for (const line of stderr.split("\n")) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) {
      continue;
    }
    const { event, reason } = record as { event?: unknown; reason?: unknown };
    if (event === "server_start_failed" && LISTEN_REASONS.includes(reason)) {
      return true;
    }
  }
  return false;
}
