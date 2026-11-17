/**
 * 输出泄密哨兵的唯一实现（#2009 提出，#2018 合并，#2021 推到 server 测试里的全部泄密断言）：各处传自己的哨兵列表。
 * 放在中立模块：`kb-ingest-helpers.ts` 已 import `kb-settings-helpers.ts`，放进任一边都会成环。
 */
import { format } from "node:util";
import { type MockInstance, vi } from "vitest";

/**
 * 用例期间的输出收集器：`start()` 装 spy（透传，不吞输出），`stop()` 恢复自己装的 spy 并返回收集到的文本。
 * 可嵌套：`start()` 时方法已是 mock（外层收集器或用例自己装的），就不再 `spyOn`——vitest 4 对已是 mock 的方法 `spyOn`
 * 返回同一个 mock，`mockRestore` 会清空它的调用记录——只记下当时的调用数，`stop()` 只读其后的调用、不恢复它。
 */
export interface OutputCollector {
  start(): void;
  stop(): string;
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

interface Channel {
  spy: MockInstance;
  /** 起点：`start()` 时已有的调用数，只读其后的调用。 */
  from: number;
  /** 自己装的 spy，`stop()` 恢复；借用的不恢复。 */
  owned: boolean;
}

type Methods = Record<string, (...args: unknown[]) => unknown>;

function claim(target: object, method: string): Channel {
  const current: unknown = (target as Methods)[method];
  if (vi.isMockFunction(current)) {
    return { spy: current, from: current.mock.calls.length, owned: false };
  }
  return { spy: vi.spyOn(target as Methods, method), from: 0, owned: true };
}

const callsOf = ({ spy, from }: Channel): unknown[][] => spy.mock.calls.slice(from);

/** `write` 的块：字符串原样，`Uint8Array`/`Buffer` 按 UTF-8 解码。 */
const decode = (chunk: unknown): string =>
  typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");

export function outputCollector(): OutputCollector {
  let writes: Channel[] = [];
  let consoles: Channel[] = [];
  return {
    start() {
      writes = [claim(process.stdout, "write"), claim(process.stderr, "write")];
      // vitest 截走 `console`，不经过上面两个 `write`（#2009）；spy 不给实现，照常透传给 vitest。
      consoles = CONSOLE_METHODS.map((method) => claim(console, method));
    },
    stop() {
      const written = writes.flatMap((channel) => callsOf(channel).map((args) => decode(args[0])));
      const logged = consoles.flatMap((channel) => callsOf(channel).map((args) => format(...args)));
      for (const { spy, owned } of [...writes.splice(0), ...consoles.splice(0)]) {
        if (owned) spy.mockRestore();
      }
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
