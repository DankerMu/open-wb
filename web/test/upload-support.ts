// `uploadFile()` 的可控 `XMLHttpRequest` 替身（#1023 起在 api-upload.test.ts，#1024 搬到这里共用）：
// API 客户端测试与整页测试用同一个类。整页用例在挂载之后调 `installFakeXhr()`，`cleanupChatPage` 负责卸掉。
import { vi } from "vitest";

/** Records what the client does to it; the case drives `upload`, `load`, `error` and `abort`. */
export class FakeXhr extends EventTarget {
  static instances: FakeXhr[] = [];

  readonly upload = new EventTarget();
  status = 0;
  responseText = "";
  withCredentials = false;
  responseType = "";
  timeout = 0;
  readonly opens: unknown[][] = [];
  readonly headers: [string, string][] = [];
  readonly bodies: unknown[] = [];
  aborts = 0;

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }

  open(...args: unknown[]) {
    this.opens.push(args);
  }

  setRequestHeader(name: string, value: string) {
    this.headers.push([name, value]);
  }

  send(body: unknown) {
    this.bodies.push(body);
  }

  /** Like the browser, an in-flight `abort()` reports itself with an `abort` event. */
  abort() {
    this.aborts += 1;
    this.dispatchEvent(new Event("abort"));
  }

  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.dispatchEvent(new ProgressEvent("progress", { lengthComputable, loaded, total }));
  }

  respond(status: number, responseText: string) {
    this.status = status;
    this.responseText = responseText;
    this.dispatchEvent(new Event("load"));
  }
}

/** 把全局 `XMLHttpRequest` 换成 `FakeXhr`；`vi.unstubAllGlobals()` 换回去。 */
export function installFakeXhr() {
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
}

/** 最近创建的那个请求替身。 */
export function lastFakeXhr(): FakeXhr {
  const xhr = FakeXhr.instances.at(-1);
  if (!xhr) {
    throw new Error("expected uploadFile to create a request");
  }

  return xhr;
}

export function resetFakeXhr() {
  FakeXhr.instances = [];
}
