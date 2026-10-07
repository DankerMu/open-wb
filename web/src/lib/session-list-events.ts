/**
 * Session list event connection (`GET /api/sessions/events`). The stream only notifies: it carries
 * no session data, no ids to resume from and no replay, so a consumer re-reads on every open and
 * on every `sessions.changed`. Reconnection is the `EventSource`'s own; nothing here retries.
 */

type ListEventSource = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
};

type ListEventSourceCtor = new (url: string, init?: EventSourceInit) => ListEventSource;

type SessionListEventHandlers = {
  /** The connection entered the open state. `reopened` is false the first time only. */
  onOpen: (state: { reopened: boolean }) => void;
  /** One `sessions.changed`: the list may differ from what was last read. */
  onChanged: () => void;
  /** One `session.rewound`: a message of this session was undone. */
  onRewound: (sessionId: string) => void;
};

type SessionListEventsOptions = {
  /** Defaults to the global `EventSource`. */
  EventSourceCtor?: ListEventSourceCtor | undefined;
};

type SessionListEventConnection = {
  /** Closes the source; no handler runs afterwards, even if it still delivers. Idempotent. */
  close(): void;
};

const LIST_EVENTS_PATH = "/api/sessions/events";
const SESSION_ID = /^[0-9a-f]{32}$/;
const NO_CONNECTION: SessionListEventConnection = { close() {} };
const INVALID = Symbol("invalid list event data");

/**
 * Opens the list event connection. Events whose `data` is not valid JSON, and `session.rewound`
 * events without a 32 lowercase hex `sessionId`, are ignored. Without an `EventSource` the result
 * is a connection that does nothing.
 */
export function connectSessionListEvents(
  handlers: SessionListEventHandlers,
  options?: SessionListEventsOptions,
): SessionListEventConnection {
  const EventSourceCtor: ListEventSourceCtor | undefined =
    options?.EventSourceCtor ?? globalThis.EventSource;
  if (typeof EventSourceCtor !== "function") {
    return NO_CONNECTION;
  }
  const source = new EventSourceCtor(LIST_EVENTS_PATH, { withCredentials: true });
  let closed = false;
  let opened = false;

  source.addEventListener("open", onOpen);
  source.addEventListener("sessions.changed", onChanged);
  source.addEventListener("session.rewound", onRewound);

  function onOpen() {
    if (closed) {
      return;
    }
    const reopened = opened;
    opened = true;
    handlers.onOpen({ reopened });
  }

  function onChanged(event: Event) {
    if (closed || parseData(event) === INVALID) {
      return;
    }
    handlers.onChanged();
  }

  function onRewound(event: Event) {
    if (closed) {
      return;
    }
    const sessionId = rewoundSessionId(parseData(event));
    if (sessionId !== undefined) {
      handlers.onRewound(sessionId);
    }
  }

  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      source.close();
    },
  };
}

/** The event's `data` parsed as JSON; `INVALID` when it is absent, not a string or not JSON. */
function parseData(event: Event): unknown {
  const data: unknown = "data" in event ? event.data : undefined;
  if (typeof data !== "string") {
    return INVALID;
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return INVALID;
  }
}

function rewoundSessionId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const sessionId: unknown = "sessionId" in payload ? payload.sessionId : undefined;
  return typeof sessionId === "string" && SESSION_ID.test(sessionId) ? sessionId : undefined;
}
