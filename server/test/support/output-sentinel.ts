/**
 * 输出泄密哨兵的唯一实现（#2009 提出，#2018 合并）：`useIngestWorlds` 与 `useSettingsWorlds` 共用，各自传自己的哨兵列表。
 * 放在中立模块：`kb-ingest-helpers.ts` 已 import `kb-settings-helpers.ts`，放进任一边都会成环。
 */
import { format } from "node:util";
import { type MockInstance, vi } from "vitest";

/** 用例期间的输出收集器：`start()` 装 spy（透传，不吞输出），`stop()` 恢复全部 spy 并返回收集到的文本。 */
export interface OutputCollector {
  start(): void;
  stop(): string;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

export function outputCollector(): OutputCollector {
  let writes: Array<MockInstance<typeof process.stdout.write>> = [];
  let consoles: Array<MockInstance<typeof console.log>> = [];
  return {
    start() {
      writes = [vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write")];
      // vitest 截走 `console`，不经过上面两个 `write`（#2009）；spy 不给实现，照常透传给 vitest。
      consoles = CONSOLE_METHODS.map((method) => vi.spyOn(console, method));
    },
    stop() {
      const written = writes.flatMap((spy) => spy.mock.calls.map((args) => String(args[0])));
      const logged = consoles.flatMap((spy) => spy.mock.calls.map((args) => format(...args)));
      for (const spy of [...writes.splice(0), ...consoles.splice(0)]) spy.mockRestore();
      return [...written, ...logged].join("");
    },
  };
}

/** 泄密判定：文本含任一哨兵就抛错，信息只点名哨兵，不回显文本。 */
export function expectNoSentinel(text: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) {
    if (text.includes(sentinel)) {
      throw new Error(`泄密哨兵 ${sentinel} 出现在输出里`);
    }
  }
}
