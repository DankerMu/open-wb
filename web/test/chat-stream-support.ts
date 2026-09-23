import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
  connectSessionEvents,
} from "../src/features/chat/stream.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";

export const SESSION_ID = "0123456789abcdef0123456789abcdef";
export const ENCODED_SESSION_ID = "sess/%#?+ 中";
export const ENCODED_SESSION_EVENTS_URL = "/api/sessions/sess%2F%25%23%3F%2B%20%E4%B8%AD/events";
const USER_CONTENT = "\u0000\uFEFFKeep BOM 中文 😀";
export const COMPLETED_BODY = "X";

export const CONNECTING = 0;
const OPEN = 1;
export const CLOSED = 2;

export const historyUser = {
  id: -3,
  role: "user" as const,
  content: USER_CONTENT,
  status: "done" as const,
  createdAt: -1,
  steps: [] as [],
};

export const userView = {
  id: -3,
  role: "user" as const,
  content: USER_CONTENT,
  status: "done" as const,
  steps: [] as [],
  error: null,
};

export function runningSession(status: "idle" | "running" | "done" | "failed" = "running") {
  return {
    id: SESSION_ID,
    title: "saved title",
    status,
    createdAt: 1_740_000_000_000,
    updatedAt: 1_740_000_000_023,
  };
}

export function chatSnapshot(
  options: {
    status?: "idle" | "running" | "done" | "failed";
    content?: string;
    assistantStatus?: "running" | "done" | "failed";
    steps?: ChatMessageSnapshot["messages"][number]["steps"];
    cursor?: { epoch: number; seq: number | null };
    sessionId?: string;
  } = {},
): ChatMessageSnapshot {
  return {
    session: {
      ...runningSession(options.status ?? "running"),
      id: options.sessionId ?? SESSION_ID,
    },
    messages: [
      historyUser,
      {
        id: 0,
        role: "assistant",
        content: options.content ?? "",
        status: options.assistantStatus ?? "running",
        createdAt: 0,
        steps: options.steps ?? [],
      },
    ],
    streamCursor: options.cursor ?? { epoch: 1, seq: 0 },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function settle() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function observeUnhandledRejections() {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    unhandled,
    stop() {
      process.off("unhandledRejection", onUnhandled);
    },
  };
}

export function callableThenable(run: (self: unknown) => PromiseLike<unknown>) {
  const callable = () => undefined;
  // biome-ignore lint/suspicious/noThenProperty: intentional invalid consumer-guard fixture
  Reflect.defineProperty(callable, "then", {
    configurable: true,
    enumerable: false,
    writable: true,
    value(this: unknown, onFulfilled?: unknown, onRejected?: unknown) {
      return run(this).then(onFulfilled as never, onRejected as never);
    },
  });
  return callable;
}

export function onceThenGetter(firstThen: unknown) {
  const owner = {};
  let reads = 0;
  // biome-ignore lint/suspicious/noThenProperty: intentional invalid consumer-guard fixture
  Reflect.defineProperty(owner, "then", {
    configurable: true,
    enumerable: false,
    get() {
      reads += 1;
      return reads === 1 ? firstThen : undefined;
    },
  });
  return { owner, reads: () => reads };
}

export class ForeignNamedEvent extends Event {
  readonly data: string;
  readonly lastEventId: string;

  constructor(type: string, data: string, lastEventId: string) {
    super(type);
    this.data = data;
    this.lastEventId = lastEventId;
  }
}

export class FakeEventSource extends EventTarget {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSED = CLOSED;

  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readyState = CONNECTING;
  closeCount = 0;

  constructor(url: string, init?: EventSourceInit) {
    super();
    this.url = url;
    this.withCredentials = init?.withCredentials === true;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closeCount += 1;
    this.readyState = CLOSED;
  }

  emitOpen() {
    this.readyState = OPEN;
    this.dispatchEvent(new Event("open"));
  }

  emitNamed(type: string, data: string, lastEventId = "") {
    this.dispatchEvent(new MessageEvent(type, { data, lastEventId }));
  }

  emitData(type: string, lastEventId: string, data: unknown) {
    this.emitNamed(type, JSON.stringify(data), lastEventId);
  }

  emitGap() {
    this.emitNamed("replay.gap", "{}", "");
  }

  emitTransport(readyState = CONNECTING) {
    this.readyState = readyState;
    this.dispatchEvent(new Event("error"));
  }

  emitForeign(type: string, lastEventId: string, data: unknown) {
    this.dispatchEvent(new ForeignNamedEvent(type, JSON.stringify(data), lastEventId));
  }
}

export function latestSource() {
  const source = FakeEventSource.instances.at(-1);
  if (source === undefined) {
    throw new Error("expected an EventSource instance");
  }
  return source;
}

export function resetFakeEventSources() {
  FakeEventSource.instances = [];
}

export type ChatConnectContext = {
  handle: { close(): void };
  source: FakeEventSource;
  loads: Array<{
    promise: Promise<ChatMessageSnapshot>;
    resolve: (snapshot: ChatMessageSnapshot) => void;
    reject: (reason: unknown) => void;
    signal: AbortSignal;
  }>;
  snapshots: ChatMessageSnapshot[];
  events: ChatEvent[];
  gaps: number;
  errors: unknown[];
  state: ChatState;
};

export function connectChat(
  snapshot: ChatMessageSnapshot,
  hooks: {
    onSnapshot?: (context: ChatConnectContext, snapshot: ChatMessageSnapshot) => unknown;
    onEvent?: (context: ChatConnectContext, event: ChatEvent) => unknown;
    onGap?: (context: ChatConnectContext) => unknown;
    onError?: (context: ChatConnectContext, error: unknown) => unknown;
  } = {},
): ChatConnectContext {
  const context = {
    loads: [],
    snapshots: [],
    events: [],
    gaps: 0,
    errors: [],
    state: chatStateFromSnapshot(snapshot),
  } as unknown as ChatConnectContext;
  context.handle = connectSessionEvents(snapshot.session.id, {
    EventSourceCtor: FakeEventSource,
    initialCursor: snapshot.streamCursor,
    loadSnapshot(signal) {
      const load = { ...deferred<ChatMessageSnapshot>(), signal };
      context.loads.push(load);
      return load.promise;
    },
    onSnapshot(next) {
      context.snapshots.push(next);
      context.state = chatStateFromSnapshot(next);
      return hooks.onSnapshot?.(context, next);
    },
    onEvent(event) {
      context.events.push(event);
      context.state = applyChatEvent(context.state, event);
      return hooks.onEvent?.(context, event);
    },
    onGap() {
      context.gaps += 1;
      return hooks.onGap?.(context);
    },
    onError(error) {
      context.errors.push(error);
      return hooks.onError?.(context, error);
    },
  });
  context.source = latestSource();
  return context;
}

export function assistantContent(state: ChatState, messageId = 0) {
  return state.messages.find((message) => message.id === messageId)?.content;
}

export function assistantSteps(state: ChatState, messageId = 0) {
  return state.messages.find((message) => message.id === messageId)?.steps;
}
