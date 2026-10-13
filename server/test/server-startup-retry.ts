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
  stdout?: number;
}

/**
 * 每次尝试：取一个端口 → `launchFor(port)` → `startCompiledServer` → 等 `server_started`。
 * - 这次等待没有等到 `server_started`（子进程先退出，或等待超时），而此刻 stderr 里已有一行
 *   `reason` 为 `listen` 或 `preview_listen` 的失败记录时，回收子进程（整组强杀并等关闭）再换
 *   端口重来，至多 `ATTEMPTS` 次。超时的那一种是：记录已写出、子进程却还没退出。
 * - 其余一律不动子进程，连同这次用的端口原样交还：等到了 `server_started`；没等到（退出或超时）
 *   而 stderr 里没有监听类失败记录；以及最后一次尝试，不论结果。调用方照旧调
 *   `waitForStarted()` / `waitForClose()`，结果与直接用 `startCompiledServer` 相同
 *   （`waitForStarted` 每次调用都从头判定）。
 * 子进程要活着停在 `server_started` 之前、由用例自己推进的启动（预加载钩子扣住某一步）不能用它：
 * 它会先等满 `waitForStarted` 的时限。
 * `launchFor` 每次尝试调用一次。失败的那次尝试会留下东西（读既有用例的断言得出：主端口被占 →
 * DB 文件已建、状态目录没有，orderTrace 里有 `listener-close:-` 与 `db-close` 两行；预览端口被占 →
 * 另有托管布局的目录与主监听器的两行）。所以显式的 `PREVIEW_PORT` 要在 `launchFor` 里新取（否则
 * 被占的预览端口换不掉），orderTrace 与钩子自己追加的记录文件要每次用新的或先删掉；根目录在
 * 用例事先往里放了东西时沿用同一个，否则每次新建。
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
