/**
 * http/listener-shutdown — 有界、无损的 listener 关停，主实例与预览监听器共用同一份实现与同一个预算缺省值。
 */
import type { FastifyInstance } from "fastify";

/**
 * listener 关停预算默认值。生产入口有两个监听器，各用一次本预算、先后关停。监听器与 runtime 三段
 * 至多为预览监听器 2s + native 8s（TERM 5s + KILL 3s）+ 主监听器 2s = 12s，超过 docker 默认 stop
 * grace 10s——三段都耗尽时进程会在收尾完成之前被 KILL（已知取舍，不是隐含保证）。
 * 12s 不是进程退出的上界：之外还要加上在途那一轮回收目录 `sweep` 的剩余时间，它没有上界（到期批次
 * 很大时）——入口关停只清定时器，不等待也不中止在途的一轮，也不调 `process.exit`（`server.ts` 的
 * `publishStarted` 与 `releaseOwned`；#1070 偏离记录「关停不等待、不中止在途的 sweep」）。
 * 以上均为读代码推出，未实测。
 */
export const LISTENER_CLOSE_BUDGET_MS = 2_000;
/** Node setTimeout 可表示的最大延迟；超出会被静默改成 1ms。 */
const TIMER_MAX_MS = 2_147_483_647;

export function validateListenerCloseBudget(budgetMs: number): number {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > TIMER_MAX_MS) {
    throw new Error(`listener close budget must be an integer in 1..${TIMER_MAX_MS} ms`);
  }
  return budgetMs;
}

/**
 * 有界、无损的 listener 关停：Node server.close() 只在调用瞬间回收一次空闲连接，
 * 之后才完成的 keep-alive 响应会把关停拖到 keepAliveTimeout。closing 期间每个完成的响应
 * 都在下一个宏任务再回收一次空闲连接（Node 跳过仍有未完成请求的连接，不切断在飞请求）；
 * 预算到期仍未关闭才 closeAllConnections() 并通知一次。从未 listen 的 app 全部为 no-op。
 *
 * Fastify 在某个根 preClose complete(err) 或超时后会跳过其后全部根 preClose，但无论结果
 * 如何都会在 preClose 链之后经属性查找调用一次 `instance.server.close()`。因此 closing 标记
 * 由第一个根 preClose 设置，预算由包裹 `app.server.close` 的委托在 native 关停之后才布防，
 * 两者都不依赖 preClose 链成功。
 */
export function registerListenerShutdown(
  app: FastifyInstance,
  budgetMs: number,
  onForceClose: (() => void) | undefined,
): void {
  const server = app.server;
  let closing = false;
  let closed = false;
  let budget: NodeJS.Timeout | undefined;
  const settle = (): void => {
    closed = true;
    clearTimeout(budget);
  };
  const escalate = (): void => {
    if (closed) {
      return;
    }
    server.closeAllConnections();
    try {
      onForceClose?.();
    } catch {
      // 通知方故障不得打断关停；记录与否由通知方自己负责。
    }
  };

  app.addHook("preClose", (complete) => {
    if (server.listening) {
      closing = true;
    }
    complete();
  });
  const nativeClose = server.close;
  server.close = function closeWithinBudget(this: typeof server, ...args) {
    // 未 listen 时 Fastify 也会调用 close()（防泄漏），此时不布防。
    if (server.listening && budget === undefined) {
      closing = true;
      server.once("close", settle);
      budget = setTimeout(escalate, budgetMs);
      budget.unref();
    }
    return nativeClose.apply(this, args);
  } satisfies typeof server.close;
  app.addHook("onResponse", (_request, _reply, done) => {
    if (closing) {
      setImmediate(() => {
        if (!closed) {
          server.closeIdleConnections();
        }
      });
    }
    done();
  });
  app.addHook("onClose", (_instance, done) => {
    settle();
    done();
  });
}
