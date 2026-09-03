/**
 * 启动记录写入器（Issue #7 内部 helper，非公共 seam；server.ts 是唯一消费方）。
 *
 * 承诺：一行 application 记录经一次 write 只用三种失败路径的任意一种 settle 一次——
 * 同步 throw、write callback error、stream error 事件。Node 的 EPIPE error 事件在
 * write callback 之后、setImmediate 之前到达，因此监听在 settle 后的 setImmediate
 * 移除，保证后到的 error 事件仍被消费、不会成为未处理异常。
 */

/** 可写 sink 的最小结构面：真实 process.stdout/stderr 与普通 Writable 均满足。 */
export interface ManagedLineSink {
  write(chunk: string, callback?: (error: Error | null | undefined) => void): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}

export function writeManagedLine(stream: ManagedLineSink, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      scheduleRemoval();
      reject(error);
    };
    const scheduleRemoval = (): void => {
      setImmediate(() => {
        stream.removeListener("error", onError);
      });
    };
    stream.on("error", onError);
    try {
      stream.write(line, (error) => {
        if (settled) {
          return;
        }
        settled = true;
        scheduleRemoval();
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    } catch (error) {
      if (settled) {
        return;
      }
      settled = true;
      scheduleRemoval();
      reject(error);
    }
  });
}
