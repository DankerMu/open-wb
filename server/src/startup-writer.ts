/**
 * 受管记录写入器（Issue #7 内部 helper，非公共 seam；server.ts 是唯一消费方）。
 *
 * 承诺：一行 application 记录经一次 write 只用三种失败路径的任意一种 settle 一次——
 * 同步 throw、write callback error、stream error 事件。
 *
 * 监听（#787）：每个 stream 至多挂一个 error 监听，由该 stream 的全部在途记录共用——
 * 同 tick 写任意多条都不会堆出逐条监听、触发 Node 的 MaxListenersExceededWarning
 * （不靠 setMaxListeners）。一次 error 事件使当时全部在途记录各自以该 error reject。
 * Node 的 EPIPE error 事件在 write callback 之后、setImmediate 之前到达，因此监听在
 * 最后一条在途记录 settle 后再过一轮 setImmediate 才摘除，保证后到的 error 事件仍被
 * 消费、不会成为未处理异常；其间有新记录进入则沿用同一个监听。
 */

/** 可写 sink 的最小结构面：真实 process.stdout/stderr 与普通 Writable 均满足。 */
export interface ManagedLineSink {
  write(chunk: string, callback?: (error: Error | null | undefined) => void): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}

/** 一个 stream 上的共享监听与在途记录；存在于 `attached` 即「监听已挂」。 */
interface StreamState {
  /** 在途记录各自的 reject；从集合里删掉自己成功者才有权 settle。 */
  readonly inFlight: Set<(error: Error) => void>;
  readonly onError: (error: Error) => void;
  /** 在途集合每次变空时加一：只有最近一次变空排下的 setImmediate 才摘监听。 */
  idleEpoch: number;
}

const attached = new WeakMap<ManagedLineSink, StreamState>();

function attach(stream: ManagedLineSink): StreamState {
  const state: StreamState = {
    inFlight: new Set(),
    onError: (error) => {
      const rejects = [...state.inFlight];
      if (rejects.length === 0) {
        return;
      }
      state.inFlight.clear();
      scheduleDetach(stream, state);
      for (const reject of rejects) {
        reject(error);
      }
    },
    idleEpoch: 0,
  };
  attached.set(stream, state);
  stream.on("error", state.onError);
  return state;
}

/** 在途集合刚变空时调用：过一轮 setImmediate 后仍空、且其间没再变空过，才摘除监听。 */
function scheduleDetach(stream: ManagedLineSink, state: StreamState): void {
  state.idleEpoch += 1;
  const epoch = state.idleEpoch;
  setImmediate(() => {
    if (state.inFlight.size > 0 || state.idleEpoch !== epoch) {
      return;
    }
    stream.removeListener("error", state.onError);
    attached.delete(stream);
  });
}

export function writeManagedLine(stream: ManagedLineSink, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const state = attached.get(stream) ?? attach(stream);
    /** 取得 settle 权：已被别的路径 settle 时返回 false。 */
    const claim = (): boolean => {
      if (!state.inFlight.delete(reject)) {
        return false;
      }
      if (state.inFlight.size === 0) {
        scheduleDetach(stream, state);
      }
      return true;
    };
    state.inFlight.add(reject);
    try {
      stream.write(line, (error) => {
        if (!claim()) {
          return;
        }
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    } catch (error) {
      if (claim()) {
        reject(error);
      }
    }
  });
}
