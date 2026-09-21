/**
 * Canonical prompt frame stream. Queue, terminal, drain and cancellation live here.
 */
import type { OmpFrame } from "./frame.js";

interface FrameWaiter {
  resolve: (result: IteratorResult<OmpFrame>) => void;
  reject: (error: Error) => void;
}

export class FrameStream implements AsyncIterable<OmpFrame> {
  onCancel: (() => void) | undefined;
  #queue: OmpFrame[] = [];
  #done = false;
  #error: Error | undefined;
  #wait: FrameWaiter | undefined;

  push(frame: OmpFrame): void {
    if (this.#done) {
      return;
    }
    const waiter = this.#wait;
    if (waiter !== undefined) {
      this.#wait = undefined;
      waiter.resolve({ value: frame, done: false });
      return;
    }
    this.#queue.push(frame);
  }

  end(): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#wait?.resolve({ value: undefined, done: true });
    this.#wait = undefined;
  }

  fail(error: Error): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#error = error;
    this.#wait?.reject(error);
    this.#wait = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<OmpFrame> {
    return {
      next: () => this.#next(),
      return: () => this.#return(),
    };
  }

  #next(): Promise<IteratorResult<OmpFrame>> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return Promise.resolve({ value: queued, done: false });
    }
    if (this.#error !== undefined) {
      return Promise.reject(this.#error);
    }
    if (this.#done) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.#wait = { resolve, reject };
    });
  }

  async #return(): Promise<IteratorResult<OmpFrame>> {
    if (!this.#done) {
      this.onCancel?.();
      this.#done = true;
    }
    this.#queue.length = 0;
    this.#error = undefined;
    const waiter = this.#wait;
    this.#wait = undefined;
    waiter?.resolve({ value: undefined, done: true });
    return { value: undefined, done: true };
  }
}
