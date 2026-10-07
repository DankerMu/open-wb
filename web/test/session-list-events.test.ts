import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectSessionListEvents } from "../src/lib/session-list-events.js";
import { FakeEventSource, latestListSource, resetFakeEventSources } from "./chat-stream-support.js";

const SESSION_A = "0123456789abcdef0123456789abcdef";
const SESSION_B = "fedcba9876543210fedcba9876543210";

function spies() {
  return {
    onOpen: vi.fn<(state: { reopened: boolean }) => void>(),
    onChanged: vi.fn<() => void>(),
    onRewound: vi.fn<(sessionId: string) => void>(),
  };
}

function connect() {
  const handlers = spies();
  const connection = connectSessionListEvents(handlers, { EventSourceCtor: FakeEventSource });
  return { connection, source: latestListSource(), ...handlers };
}

beforeEach(() => {
  resetFakeEventSources();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session list events connector", () => {
  it("opens one credentialed EventSource on the list events endpoint", () => {
    const { source, onOpen, onChanged, onRewound } = connect();

    expect(FakeEventSource.listInstances).toHaveLength(1);
    expect(source.url).toBe("/api/sessions/events");
    expect(source.withCredentials).toBe(true);
    expect(source.closeCount).toBe(0);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onRewound).not.toHaveBeenCalled();
  });

  it("uses the global EventSource when none is injected", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onChanged = vi.fn<() => void>();

    connectSessionListEvents({ onOpen: vi.fn(), onChanged, onRewound: vi.fn() });
    const source = latestListSource();
    source.emitNamed("sessions.changed", "{}");

    expect(source.url).toBe("/api/sessions/events");
    expect(source.withCredentials).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reports sessions.changed once per event", () => {
    const { source, onOpen, onChanged, onRewound } = connect();

    source.emitNamed("sessions.changed", "{}");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenLastCalledWith();

    source.emitNamed("sessions.changed", "{}");
    source.emitNamed("sessions.changed", "{}");
    expect(onChanged).toHaveBeenCalledTimes(3);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRewound).not.toHaveBeenCalled();
  });

  it("reports session.rewound with the session id, never merged", () => {
    const { source, onChanged, onRewound } = connect();

    source.emitNamed("session.rewound", JSON.stringify({ sessionId: SESSION_A }));
    source.emitNamed("session.rewound", JSON.stringify({ sessionId: SESSION_B }));
    source.emitNamed("session.rewound", JSON.stringify({ sessionId: SESSION_A }));

    expect(onRewound.mock.calls).toEqual([[SESSION_A], [SESSION_B], [SESSION_A]]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("reads only sessionId from session.rewound and accepts any JSON for sessions.changed", () => {
    const { source, onChanged, onRewound } = connect();

    source.emitNamed("session.rewound", JSON.stringify({ sessionId: SESSION_A, extra: 1 }));
    for (const data of ["null", "1", "[]", '{"extra":1}']) {
      source.emitNamed("sessions.changed", data);
    }

    expect(onRewound.mock.calls).toEqual([[SESSION_A]]);
    expect(onChanged).toHaveBeenCalledTimes(4);
  });

  it("tells the first open from every later one", () => {
    const { source, onOpen, onChanged, onRewound } = connect();

    source.emitOpen();
    expect(onOpen.mock.calls).toEqual([[{ reopened: false }]]);

    source.emitTransport();
    expect(onOpen).toHaveBeenCalledTimes(1);
    source.emitOpen();
    expect(onOpen.mock.calls).toEqual([[{ reopened: false }], [{ reopened: true }]]);

    source.emitTransport();
    source.emitOpen();
    expect(onOpen.mock.calls).toEqual([
      [{ reopened: false }],
      [{ reopened: true }],
      [{ reopened: true }],
    ]);
    expect(onChanged).not.toHaveBeenCalled();
    expect(onRewound).not.toHaveBeenCalled();
  });

  it.each([
    ["not json", "not json"],
    ["an empty string", ""],
    ["a truncated object", "{"],
  ])("ignores sessions.changed whose data is %s", (_label, data) => {
    const { source, onOpen, onChanged, onRewound } = connect();

    source.emitNamed("sessions.changed", data);

    expect(onChanged).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRewound).not.toHaveBeenCalled();
  });

  it("ignores sessions.changed that carries no string data", () => {
    const { source, onChanged } = connect();

    source.dispatchEvent(new Event("sessions.changed"));
    source.dispatchEvent(new MessageEvent("sessions.changed", { data: 1 }));

    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each([
    ["not json", "not json"],
    ["an array", "[]"],
    ["null", "null"],
    ["an object without sessionId", "{}"],
    ["a numeric sessionId", '{"sessionId":123}'],
    ["a null sessionId", '{"sessionId":null}'],
    ["a bare id string", JSON.stringify(SESSION_A)],
    ["an id inside an array", JSON.stringify([SESSION_A])],
    ["31 characters", JSON.stringify({ sessionId: SESSION_A.slice(1) })],
    ["33 characters", JSON.stringify({ sessionId: `${SESSION_A}0` })],
    ["uppercase hex", JSON.stringify({ sessionId: SESSION_A.toUpperCase() })],
    ["a non-hex character", JSON.stringify({ sessionId: `g${SESSION_A.slice(1)}` })],
    ["a leading space", JSON.stringify({ sessionId: ` ${SESSION_A}` })],
    ["a trailing space", JSON.stringify({ sessionId: `${SESSION_A} ` })],
    ["a trailing newline", JSON.stringify({ sessionId: `${SESSION_A}\n` })],
    ["an empty id", '{"sessionId":""}'],
  ])("ignores session.rewound whose data is %s", (_label, data) => {
    const { source, onOpen, onChanged, onRewound } = connect();

    source.emitNamed("session.rewound", data);

    expect(onRewound).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ignores session.rewound that carries no string data", () => {
    const { source, onRewound } = connect();

    source.dispatchEvent(new Event("session.rewound"));
    source.dispatchEvent(new MessageEvent("session.rewound", { data: { sessionId: SESSION_A } }));

    expect(onRewound).not.toHaveBeenCalled();
  });

  it("keeps delivering after an ignored event", () => {
    const { source, onChanged, onRewound } = connect();

    source.emitNamed("sessions.changed", "not json");
    source.emitNamed("session.rewound", '{"sessionId":123}');
    source.emitNamed("sessions.changed", "{}");
    source.emitNamed("session.rewound", JSON.stringify({ sessionId: SESSION_B }));

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onRewound.mock.calls).toEqual([[SESSION_B]]);
  });

  it("ignores unknown event names, plain messages and transport errors", () => {
    const { source, onOpen, onChanged, onRewound } = connect();

    source.emitNamed("message", "{}");
    source.emitNamed("message", JSON.stringify({ sessionId: SESSION_A }));
    source.emitNamed("sessions.deleted", "{}");
    source.emitNamed("session.changed", "{}");
    source.emitNamed("sessions.rewound", JSON.stringify({ sessionId: SESSION_A }));
    source.emitNamed("turn.end", JSON.stringify({ sessionId: SESSION_A }));
    source.emitTransport();
    source.emitTransport(FakeEventSource.CLOSED);

    expect(onOpen).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onRewound).not.toHaveBeenCalled();
    expect(source.closeCount).toBe(0);
  });

  it("fires nothing after close and closes the source exactly once", () => {
    const { connection, source, onOpen, onChanged, onRewound } = connect();
    source.emitOpen();
    source.emitNamed("sessions.changed", "{}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);

    connection.close();
    expect(source.closeCount).toBe(1);

    source.emitOpen();
    source.emitNamed("sessions.changed", "{}");
    source.emitNamed("session.rewound", JSON.stringify({ sessionId: SESSION_A }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onRewound).not.toHaveBeenCalled();

    connection.close();
    expect(source.closeCount).toBe(1);
    expect(FakeEventSource.listInstances).toHaveLength(1);
  });

  it("stops within the same dispatch when a callback closes the connection", () => {
    const onRewound = vi.fn<(sessionId: string) => void>();
    const connection = connectSessionListEvents(
      {
        onOpen: vi.fn(),
        onChanged() {
          connection.close();
        },
        onRewound,
      },
      { EventSourceCtor: FakeEventSource },
    );
    const source = latestListSource();

    source.emitNamed("sessions.changed", "{}");
    source.emitNamed("session.rewound", JSON.stringify({ sessionId: SESSION_A }));

    expect(source.closeCount).toBe(1);
    expect(onRewound).not.toHaveBeenCalled();
  });

  it.each([
    ["no option is passed", undefined],
    ["the injected constructor is undefined", { EventSourceCtor: undefined }],
  ])("returns a no-op connection without an EventSource when %s", (_label, options) => {
    vi.stubGlobal("EventSource", undefined);
    const { onOpen, onChanged, onRewound } = spies();

    const connection = connectSessionListEvents({ onOpen, onChanged, onRewound }, options);

    expect(FakeEventSource.listInstances).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(() => {
      connection.close();
      connection.close();
    }).not.toThrow();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onRewound).not.toHaveBeenCalled();
  });
});
