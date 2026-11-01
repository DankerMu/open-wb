/**
 * 知识库的两种进程内锁（design D20；knowledge-bases「同一知识库的写操作串行」、ragflow-backend 的设置锁）。
 *
 * 只管「一段工作何时开始」：不读库，不发请求。取锁之后重判存在性、`state` 与上限，以及把「重建中」
 * 译成 409 `kb_rebuilding`，都归调用方。
 *
 * - 每库写锁：写操作与重建器共用。锁正被重建器持有时写操作不排队，立即得到 `rebuilding`。重建器自己
 *   排队，等排在它之前的写操作结束；它还在等锁时到达的写操作照常排在它之后，取锁后由调用方重判。
 * - 设置锁：进程只有一把，持锁者都是写操作，没有重建器。
 *
 * 两把锁交锁规则相同。准入是同步的：调用返回之前，这个调用要么已经开始，要么已经入队，要么已经被
 * 拒绝，到达次序就是调用次序。放行时同一步交给队首，锁没有空着的片刻，新来者插不了队。
 */

type Holder = "writer" | "rebuilder";

type WriteOutcome<T> = { outcome: "ok"; value: T } | { outcome: "rebuilding" };

class FifoLock {
  readonly #onIdle: () => void;
  readonly #queue: (() => void)[] = [];
  #holder: Holder | null = null;

  /** `onIdle` 在锁变得无人持有、也无人排队时调用。 */
  constructor(onIdle: () => void = () => undefined) {
    this.#onIdle = onIdle;
  }

  get holder(): Holder | null {
    return this.#holder;
  }

  /** 排队而尚未拿到锁的个数：持锁者不算，交到锁的那一刻减一。 */
  get waiters(): number {
    return this.#queue.length;
  }

  run<T>(holder: Holder, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.#holder = holder;
        // 在 executor 里调用：同步抛出的也变成拒绝，同样走到放行。
        new Promise<T>((settle) => {
          settle(work());
        }).then(
          (value) => {
            this.#release();
            resolve(value);
          },
          (reason: unknown) => {
            this.#release();
            reject(reason);
          },
        );
      };
      if (this.#holder === null) {
        start();
      } else {
        this.#queue.push(start);
      }
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.#holder = null;
    this.#onIdle();
  }
}

export function createKbLocks(): {
  /** 在该库的写锁下执行 `work`；锁正被重建器持有时不排队、不执行，得到 `rebuilding`。 */
  write<T>(kbId: string, work: () => Promise<T>): Promise<WriteOutcome<T>>;
  /** 在该库的写锁下执行重建器的 `work`：从不被拒绝，按到达次序等锁。 */
  rebuild<T>(kbId: string, work: () => Promise<T>): Promise<T>;
  /** 在进程级设置锁下执行 `work`。 */
  settings<T>(work: () => Promise<T>): Promise<T>;
  /** 该库写锁当前的等待者个数（含排队的重建器）。 */
  writeWaiters(kbId: string): number;
  /** 设置锁当前的等待者个数。 */
  settingsWaiters(): number;
  /** 正被占用的写锁个数：空闲的库不占条目，锁表不随知识库增长。 */
  writeLockCount(): number;
} {
  const writeLocks = new Map<string, FifoLock>();
  const settingsLock = new FifoLock();

  function writeLock(kbId: string): FifoLock {
    let lock = writeLocks.get(kbId);
    if (lock === undefined) {
      lock = new FifoLock(() => writeLocks.delete(kbId));
      writeLocks.set(kbId, lock);
    }
    return lock;
  }

  return {
    write<T>(kbId: string, work: () => Promise<T>): Promise<WriteOutcome<T>> {
      const lock = writeLock(kbId);
      if (lock.holder === "rebuilder") {
        return Promise.resolve({ outcome: "rebuilding" });
      }
      return lock.run("writer", work).then((value) => ({ outcome: "ok", value }));
    },
    rebuild(kbId, work) {
      return writeLock(kbId).run("rebuilder", work);
    },
    settings(work) {
      return settingsLock.run("writer", work);
    },
    writeWaiters(kbId) {
      return writeLocks.get(kbId)?.waiters ?? 0;
    },
    settingsWaiters() {
      return settingsLock.waiters;
    },
    writeLockCount() {
      return writeLocks.size;
    },
  };
}
