import { hasExactlyKeys } from "../../lib/api-json.js";
import type {
  ChatMessage,
  ChatMessageSnapshot,
  ChatSession,
  ChatStep,
  ChatStreamCursor,
} from "../../lib/session-contract.js";

type ChatStepView = {
  id: ChatStep["id"];
  name: ChatStep["name"];
  detail: ChatStep["detail"];
  output: ChatStep["output"];
  status: ChatStep["status"];
};

type ChatMessageView = {
  id: ChatMessage["id"];
  role: ChatMessage["role"];
  content: ChatMessage["content"];
  status: ChatMessage["status"];
  steps: ChatStepView[];
  error: string | null;
};

export type ChatState = {
  status: ChatSession["status"];
  messages: ChatMessageView[];
};

type ChatMessageTarget = { messageId: number };
type ChatStepTarget = ChatMessageTarget & { stepId: number };
type ChatTerminalStatus = "done" | "failed";

export type ChatEvent =
  | { type: "turn.start"; data: ChatMessageTarget }
  | { type: "text.delta"; data: ChatMessageTarget & { delta: string } }
  | { type: "step.start"; data: ChatStepTarget & { name: string; detail: string } }
  | { type: "step.end"; data: ChatStepTarget & { status: ChatTerminalStatus; output: string } }
  | { type: "turn.end"; data: ChatMessageTarget & { status: ChatTerminalStatus } }
  | { type: "error"; data: ChatMessageTarget & { message: string } };

type ChatEventType = ChatEvent["type"];

type SessionEventSource = {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
};

type SessionEventSourceCtor = new (url: string, init?: EventSourceInit) => SessionEventSource;

type QueuedFrame = { event: ChatEvent; cursor: ChatStreamCursor };

type SessionEventsOptions = {
  EventSourceCtor: SessionEventSourceCtor;
  initialCursor: ChatStreamCursor;
  loadSnapshot: (signal: AbortSignal) => Promise<ChatMessageSnapshot>;
  onSnapshot: (snapshot: ChatMessageSnapshot) => void;
  onEvent: (event: ChatEvent) => void;
  onGap?: () => void;
  onError: (error: unknown) => void;
};

const DATA_EVENTS = [
  "turn.start",
  "text.delta",
  "step.start",
  "step.end",
  "turn.end",
  "error",
] as const satisfies readonly ChatEventType[];
const QUEUE_CAP = 1000;
const CANONICAL_CURSOR = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;
const MAX_SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER);
const CONNECTION_FAILURE = "Session event connection failed";
const SOURCE_CONNECTING = 0;
const SOURCE_CLOSED = 2;

export function chatStateFromSnapshot(snapshot: ChatMessageSnapshot): ChatState {
  return {
    status: snapshot.session.status,
    messages: snapshot.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      status: message.status,
      steps: message.steps.map((step) => ({
        id: step.id,
        name: step.name,
        detail: step.detail,
        output: step.output,
        status: step.status,
      })),
      error: null,
    })),
  };
}

export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "turn.start":
      return replaceAssistant(
        state,
        event.data.messageId,
        (message) => ({
          id: message.id,
          role: "assistant",
          content: "",
          status: "running",
          steps: [],
          error: null,
        }),
        "running",
      );
    case "text.delta":
      return replaceAssistant(state, event.data.messageId, (message) => ({
        ...message,
        content: message.content + event.data.delta,
      }));
    case "step.start":
      return startStep(state, event.data);
    case "step.end":
      return endStep(state, event.data);
    case "error":
      return replaceAssistant(
        state,
        event.data.messageId,
        (message) => ({
          ...message,
          status: "failed",
          error: event.data.message,
        }),
        "running",
      );
    case "turn.end":
      return endTurn(state, event.data.messageId, event.data.status);
    default:
      return state;
  }
}

function startStep(
  state: ChatState,
  data: { messageId: number; stepId: number; name: string; detail: string },
): ChatState {
  return replaceAssistant(state, data.messageId, (message) => {
    if (message.steps.some((step) => step.id === data.stepId)) {
      return message;
    }
    return {
      ...message,
      steps: [
        ...message.steps,
        { id: data.stepId, name: data.name, detail: data.detail, output: "", status: "running" },
      ],
    };
  });
}

function endStep(
  state: ChatState,
  data: {
    messageId: number;
    stepId: number;
    status: "done" | "failed";
    output: string;
  },
): ChatState {
  return replaceAssistant(state, data.messageId, (message) => {
    const index = message.steps.findIndex((step) => step.id === data.stepId);
    const current = index < 0 ? undefined : message.steps[index];
    if (current === undefined) {
      return message;
    }
    const steps = message.steps.slice();
    // detail 固定为 step.start/快照中的 args，step.end 只带回状态与输出（#367）。
    steps[index] = {
      id: current.id,
      name: current.name,
      detail: current.detail,
      output: data.output,
      status: data.status,
    };
    return { ...message, steps };
  });
}

function endTurn(state: ChatState, messageId: number, status: "done" | "failed"): ChatState {
  return replaceAssistant(
    state,
    messageId,
    (message) => ({
      ...message,
      status,
      error: status === "done" ? null : message.error,
      steps: message.steps.some((step) => step.status === "running")
        ? message.steps.map((step) => (step.status === "running" ? { ...step, status } : step))
        : message.steps,
    }),
    status,
  );
}

function emptyAssistant(messageId: number): ChatMessageView {
  return {
    id: messageId,
    role: "assistant",
    status: "running",
    content: "",
    steps: [],
    error: null,
  };
}

function replaceAssistant(
  state: ChatState,
  messageId: number,
  update: (message: ChatMessageView) => ChatMessageView,
  sessionStatus?: ChatSession["status"],
): ChatState {
  const index = state.messages.findIndex((message) => message.id === messageId);
  const current = index < 0 ? undefined : state.messages[index];
  if (current?.role === "user") {
    return state;
  }
  const source = current ?? emptyAssistant(messageId);
  const next = update(source);
  if (next === source && current !== undefined) {
    return sessionStatus === undefined || state.status === sessionStatus
      ? state
      : { ...state, status: sessionStatus };
  }
  if (next === source && current === undefined) {
    return state;
  }
  const messages = state.messages.slice();
  if (current === undefined) {
    messages.push(next);
  } else {
    messages[index] = next;
  }
  return {
    status: sessionStatus ?? state.status,
    messages,
  };
}

export function connectSessionEvents(sessionId: string, options: SessionEventsOptions) {
  const ownedInitial = copyCursor(options.initialCursor);
  const source = new options.EventSourceCtor(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
    { withCredentials: true },
  );
  let closed = false;
  let sourceClosed = false;
  let generation = 0;
  let recovering = false;
  let draining = false;
  let load: AbortController | undefined;
  let snapshotCursor: ChatStreamCursor | undefined;
  let delivered: ChatStreamCursor | undefined;
  let queue: Array<QueuedFrame | undefined> = [];
  let queueHead = 0;
  let pending = 0;

  const listeners: Array<[string, (event: Event) => void]> = [
    ["open", onOpen],
    ["replay.gap", onGapFrame],
    ["error", onNamedError],
    ...DATA_EVENTS.filter((type) => type !== "error").map(
      (type) => [type, onDataFrame] as [string, (event: Event) => void],
    ),
  ];
  for (const [type, listener] of listeners) {
    source.addEventListener(type, listener);
  }

  function onOpen() {
    if (closed) {
      return;
    }
    beginRecovery();
  }

  function onGapFrame() {
    if (closed) {
      return;
    }
    beginRecovery({ notifyGap: true });
  }

  function onNamedError(event: Event) {
    if (closed) {
      return;
    }
    if (namedData(event) !== undefined) {
      onDataFrame(event);
      return;
    }
    if (source.readyState === SOURCE_CONNECTING) {
      return;
    }
    if (source.readyState === SOURCE_CLOSED) {
      fail(new Error(CONNECTION_FAILURE));
    }
  }

  function onDataFrame(event: Event) {
    if (closed) {
      return;
    }
    const type = event.type;
    if (!isDataEventType(type)) {
      return;
    }
    const named = namedData(event);
    if (named === undefined) {
      return;
    }
    const cursor = parseEventCursor(named.lastEventId);
    const decoded = parseEventPayload(type, named.data);
    if (cursor === undefined || decoded === undefined) {
      beginRecovery();
      return;
    }
    enqueue({ event: decoded, cursor });
    if (!recovering && !draining) {
      drain(generation);
    }
  }

  function beginRecovery(request?: { notifyGap?: boolean; retain?: QueuedFrame }) {
    if (closed) {
      return;
    }
    generation += 1;
    const token = generation;
    recovering = true;
    draining = false;
    if (!invalidateLoad() || token !== generation) {
      return;
    }
    queue = request?.retain === undefined ? [] : [request.retain];
    queueHead = 0;
    pending = queue.length;
    if (request?.notifyGap && (!notify(options.onGap) || closed || token !== generation)) {
      return;
    }
    startLoad(token);
  }

  function invalidateLoad(): boolean {
    const previous = load;
    load = undefined;
    previous?.abort();
    return !closed;
  }

  function startLoad(token: number) {
    if (closed || token !== generation) {
      return;
    }
    const controller = new AbortController();
    load = controller;
    let requested: Promise<ChatMessageSnapshot>;
    try {
      requested = options.loadSnapshot(controller.signal);
    } catch (error) {
      if (!closed && token === generation) {
        fail(error);
      }
      return;
    }
    void requested.then(
      (snapshot) => {
        if (!closed && token === generation) {
          installSnapshot(snapshot, token);
        }
      },
      (error: unknown) => {
        if (!closed && token === generation) {
          fail(error);
        }
      },
    );
  }

  function installSnapshot(snapshot: ChatMessageSnapshot, token: number) {
    if (snapshot.session.id !== sessionId || isRegressive(snapshot.streamCursor)) {
      fail(new Error("Session snapshot is not current"));
      return;
    }
    const accepted = copyCursor(snapshot.streamCursor);
    if (!notify(() => options.onSnapshot(snapshot)) || closed || token !== generation) {
      return;
    }
    snapshotCursor = accepted;
    delivered = accepted;
    recovering = false;
    drain(token);
  }

  function drain(token: number) {
    if (draining) {
      return;
    }
    draining = true;
    while (!closed && token === generation) {
      const frame = dequeue();
      if (frame === undefined) {
        break;
      }
      if (!deliverOrDrop(frame, token)) {
        break;
      }
    }
    if (token === generation) {
      draining = false;
    }
  }

  function deliverOrDrop(frame: QueuedFrame, token: number): boolean {
    const boundary = delivered ?? snapshotCursor ?? ownedInitial;
    if (!isSuccessor(frame.cursor, boundary)) {
      return true;
    }
    if (!notify(() => options.onEvent(frame.event)) || closed || token !== generation) {
      return false;
    }
    if (token === generation) {
      delivered = copyCursor(frame.cursor);
    }
    return true;
  }

  function enqueue(frame: QueuedFrame) {
    if (pending >= QUEUE_CAP) {
      beginRecovery({ retain: frame });
      return;
    }
    queue.push(frame);
    pending += 1;
  }

  function dequeue(): QueuedFrame | undefined {
    if (pending === 0) {
      queue = [];
      queueHead = 0;
      return undefined;
    }
    const frame = queue[queueHead];
    queue[queueHead] = undefined;
    queueHead += 1;
    pending -= 1;
    if (queueHead > 32 && queueHead * 2 >= queue.length) {
      queue = queue.slice(queueHead);
      queueHead = 0;
    }
    return frame;
  }

  function isRegressive(cursor: ChatStreamCursor): boolean {
    const progress = delivered ?? snapshotCursor ?? ownedInitial;
    if (cursor.epoch < progress.epoch) {
      return true;
    }
    if (cursor.epoch > progress.epoch) {
      return false;
    }
    if (progress.seq === null) {
      return cursor.seq !== null;
    }
    if (cursor.seq === null) {
      return false;
    }
    return cursor.seq < progress.seq;
  }

  function fail(error: unknown) {
    if (closed) {
      return;
    }
    close();
    notify(() => options.onError(error));
  }

  function close() {
    if (closed) {
      return;
    }
    closed = true;
    generation += 1;
    recovering = false;
    draining = false;
    queue = [];
    queueHead = 0;
    pending = 0;
    load?.abort();
    load = undefined;
    for (const [type, listener] of listeners) {
      source.removeEventListener(type, listener);
    }
    if (!sourceClosed) {
      sourceClosed = true;
      source.close();
    }
  }

  function notify(callback: (() => void) | undefined): boolean {
    if (callback === undefined) {
      return true;
    }
    const token = generation;
    try {
      const result: unknown = callback();
      const captured = captureThenable(result);
      if (captured !== undefined) {
        containCapturedThenable(captured);
        if (!closed && token === generation) {
          fail(new Error("Session event consumer must be synchronous"));
        }
        return false;
      }
    } catch (error) {
      if (!closed && token === generation) {
        fail(error);
      }
      return false;
    }
    return !closed && token === generation;
  }

  return { close };
}

function copyCursor(cursor: ChatStreamCursor): ChatStreamCursor {
  return { epoch: cursor.epoch, seq: cursor.seq };
}

function isSuccessor(cursor: ChatStreamCursor, boundary: ChatStreamCursor): boolean {
  if (cursor.epoch < boundary.epoch) {
    return false;
  }
  if (cursor.epoch > boundary.epoch) {
    return true;
  }
  if (boundary.seq === null || cursor.seq === null) {
    return false;
  }
  return cursor.seq > boundary.seq;
}

function namedData(event: Event): { data: unknown; lastEventId: string } | undefined {
  if (!("data" in event)) {
    return undefined;
  }
  const lastEventId =
    "lastEventId" in event && typeof event.lastEventId === "string" ? event.lastEventId : "";
  return { data: event.data, lastEventId };
}

function isDataEventType(type: string): type is ChatEventType {
  return (DATA_EVENTS as readonly string[]).includes(type);
}

function parseEventCursor(lastEventId: string): ChatStreamCursor | undefined {
  const match = CANONICAL_CURSOR.exec(lastEventId);
  const epochText = match?.[1];
  const seqText = match?.[2];
  if (epochText === undefined || seqText === undefined) {
    return undefined;
  }
  if (!fitsSafeInteger(epochText) || !fitsSafeInteger(seqText)) {
    return undefined;
  }
  const seq = Number(seqText);
  if (seq < 1) {
    return undefined;
  }
  return { epoch: Number(epochText), seq };
}

function fitsSafeInteger(digits: string): boolean {
  if (digits.length > MAX_SAFE_DIGITS.length) {
    return false;
  }
  return digits.length < MAX_SAFE_DIGITS.length || digits <= MAX_SAFE_DIGITS;
}

function parseEventPayload(type: ChatEventType, raw: unknown): ChatEvent | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return decodeEvent(type, parsed);
}

function decodeEvent(type: ChatEventType, value: unknown): ChatEvent | undefined {
  switch (type) {
    case "turn.start":
      return decodeTurnStart(value);
    case "text.delta":
      return decodeTextDelta(value);
    case "step.start":
      return decodeStepStart(value);
    case "step.end":
      return decodeStepEnd(value);
    case "turn.end":
      return decodeTurnEnd(value);
    case "error":
      return decodeError(value);
  }
}

function decodeTurnStart(value: unknown): ChatEvent | undefined {
  return hasExactlyKeys(value, ["messageId"]) && isSafeInteger(value.messageId)
    ? { type: "turn.start", data: { messageId: value.messageId } }
    : undefined;
}

function decodeTextDelta(value: unknown): ChatEvent | undefined {
  return hasExactlyKeys(value, ["messageId", "delta"]) &&
    isSafeInteger(value.messageId) &&
    typeof value.delta === "string"
    ? { type: "text.delta", data: { messageId: value.messageId, delta: value.delta } }
    : undefined;
}

function decodeStepStart(value: unknown): ChatEvent | undefined {
  return hasExactlyKeys(value, ["messageId", "stepId", "name", "detail"]) &&
    isSafeInteger(value.messageId) &&
    isSafeInteger(value.stepId) &&
    typeof value.name === "string" &&
    typeof value.detail === "string"
    ? {
        type: "step.start",
        data: {
          messageId: value.messageId,
          stepId: value.stepId,
          name: value.name,
          detail: value.detail,
        },
      }
    : undefined;
}

function decodeStepEnd(value: unknown): ChatEvent | undefined {
  return hasExactlyKeys(value, ["messageId", "stepId", "status", "output"]) &&
    isSafeInteger(value.messageId) &&
    isSafeInteger(value.stepId) &&
    isTerminalStatus(value.status) &&
    typeof value.output === "string"
    ? {
        type: "step.end",
        data: {
          messageId: value.messageId,
          stepId: value.stepId,
          status: value.status,
          output: value.output,
        },
      }
    : undefined;
}

function decodeTurnEnd(value: unknown): ChatEvent | undefined {
  return hasExactlyKeys(value, ["messageId", "status"]) &&
    isSafeInteger(value.messageId) &&
    isTerminalStatus(value.status)
    ? { type: "turn.end", data: { messageId: value.messageId, status: value.status } }
    : undefined;
}

function decodeError(value: unknown): ChatEvent | undefined {
  return hasExactlyKeys(value, ["messageId", "message"]) &&
    isSafeInteger(value.messageId) &&
    typeof value.message === "string"
    ? { type: "error", data: { messageId: value.messageId, message: value.message } }
    : undefined;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isTerminalStatus(value: unknown): value is ChatTerminalStatus {
  return value === "done" || value === "failed";
}

type CapturedThenable = {
  owner: object;
  then: (onFulfilled?: unknown, onRejected?: unknown) => unknown;
};

function captureThenable(value: unknown): CapturedThenable | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const owner = value;
  const then = Reflect.get(owner, "then");
  return typeof then === "function" ? { owner, then } : undefined;
}

function containCapturedThenable(captured: CapturedThenable) {
  try {
    captured.then.call(captured.owner, undefined, () => undefined);
  } catch {
    // then() faults are still a consumer-contract violation already being reported.
  }
}
