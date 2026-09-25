import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { expect, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { SpawnImpl } from "../src/sessions/omp/process.js";
import type { SessionStore } from "../src/sessions/store.js";
import type { SessionSupervisor } from "../src/sessions/supervisor.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor, postPrompt } from "./session-rest-helpers.js";
import { messageRows, sessionRow } from "./session-store-helpers.js";
import {
  createRpcHarness,
  DEFAULT_READY,
  type FakeChild,
  observePromise,
} from "./support/omp-rpc.js";
import { createClock, type TestClock } from "./support/omp-runtime.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
export const IDLE_MS = 10_000;
const harness = createRpcHarness();

export interface RuntimeOptions {
  bin: string;
  sandboxRoot: string;
  stateDir: string;
  modelId: string;
  idleMs: number;
  ompUser?: string;
  clock: TestClock;
  spawnImpl: SpawnImpl;
}

export interface SpawnCall {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  stdio: unknown;
  shell: unknown;
  token: string | undefined;
}

export interface RealFakeRuntime {
  runtime: RuntimeOptions;
  clock: TestClock;
  calls: SpawnCall[];
  children: ChildProcessWithoutNullStreams[];
  setScenario(scenario: string | undefined): void;
}

export interface ControlledRuntime {
  runtime: RuntimeOptions;
  clock: TestClock;
  calls: SpawnCall[];
  children: FakeChild[];
}

type EventSink = (sessionId: string, epoch: number, event: ChatEvent<number>) => void;
type ErrorSink = (error: Error) => void;
export type ObservedEvent = { sessionId: string; epoch: number; event: ChatEvent<number> };

export interface SupervisorApp {
  app: FastifyInstance;
  db: DatabaseSync;
  tokens: TokenRegistry;
  store: SessionStore;
  supervisor: SessionSupervisor;
  close(): Promise<void>;
}

export interface OpenSessionOptions {
  tokens?: TokenRegistry;
  prepare?: (db: DatabaseSync) => void;
  onError?: ErrorSink;
  onEvent?: EventSink;
  configureApp?: (app: FastifyInstance) => void;
}

export function createRealFakeRuntime(
  initialScenario: string | undefined = undefined,
): RealFakeRuntime {
  const clock = createClock();
  const calls: SpawnCall[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const temp = harness.tempOpts("issue100-runtime-unused", "session-supervisor-real-");
  let scenario = initialScenario;
  const spawnImpl: SpawnImpl = (command, args, options) => {
    calls.push(recordedSpawn(command, args, options));
    const child = harness.spawnTracked(
      [FAKE, ...args, ...(scenario === undefined ? [] : ["--scenario", scenario])],
      options,
    );
    children.push(child);
    return child;
  };
  return {
    runtime: {
      bin: FAKE,
      sandboxRoot: temp.sandboxRoot,
      stateDir: temp.stateDir,
      modelId: temp.modelId,
      idleMs: IDLE_MS,
      clock,
      spawnImpl,
    },
    clock,
    calls,
    children,
    setScenario(next) {
      scenario = next;
    },
  };
}

export function createControlledRuntime(
  configure: (child: FakeChild, call: SpawnCall, ordinal: number) => void,
): ControlledRuntime {
  const clock = createClock();
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const temp = harness.tempOpts("issue100-controlled-unused", "session-supervisor-controlled-");
  const spawnImpl: SpawnImpl = (command, args, options) => {
    const call = recordedSpawn(command, args, options);
    calls.push(call);
    const child = harness.fake();
    children.push(child);
    child.emitLine(DEFAULT_READY);
    child.replyHandshake();
    configure(child, call, children.length - 1);
    return child.spawnImpl(command, args, options);
  };
  return {
    runtime: {
      bin: FAKE,
      sandboxRoot: temp.sandboxRoot,
      stateDir: temp.stateDir,
      modelId: temp.modelId,
      idleMs: IDLE_MS,
      clock,
      spawnImpl,
    },
    clock,
    calls,
    children,
  };
}

interface OpenSupervisorAppInput extends OpenSessionOptions {
  runtime: RuntimeOptions;
}

function openSupervisorApp(input: OpenSupervisorAppInput): SupervisorApp {
  const db = openDb(":memory:");
  input.prepare?.(db);
  const tokens = input.tokens ?? new TokenRegistry();
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      tokens,
      runtime: input.runtime,
      onError: input.onError ?? (() => {}),
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    },
  });
  input.configureApp?.(app);
  const registered = app.sessions;
  return {
    app,
    db,
    tokens,
    store: registered.store,
    supervisor: registered.supervisor,
    async close() {
      try {
        await app.close();
      } finally {
        db.close();
      }
    },
  };
}

export interface RecordingWorld {
  fixture: SupervisorApp;
  errors: Error[];
  events: ObservedEvent[];
  cookie: string;
  session: string;
}

export async function openBareSession(
  runtime: RuntimeOptions,
  extra: OpenSessionOptions = {},
): Promise<{ fixture: SupervisorApp; cookie: string; session: string }> {
  const fixture = openSupervisorApp({ runtime, ...extra });
  const owned = await openOwnedSession(fixture);
  return { fixture, ...owned };
}

export async function openRecordingSession(
  runtime: RuntimeOptions,
  extra: OpenSessionOptions = {},
): Promise<RecordingWorld> {
  const errors: Error[] = [];
  const events: ObservedEvent[] = [];
  const opened = await openBareSession(runtime, {
    ...extra,
    onError(error) {
      errors.push(error);
      extra.onError?.(error);
    },
    onEvent(sessionId, epoch, event) {
      events.push({ sessionId, epoch, event });
      extra.onEvent?.(sessionId, epoch, event);
    },
  });
  return { ...opened, errors, events };
}

export async function openAdmittedSession(
  runtime: RuntimeOptions,
  text: string,
): Promise<{
  fixture: SupervisorApp;
  cookie: string;
  session: string;
  admitted: { userMessageId: number; assistantMessageId: number };
}> {
  const opened = await openBareSession(runtime);
  return {
    ...opened,
    admitted: opened.fixture.store.acceptPrompt(opened.session, OWNER_ID, text),
  };
}

export async function closeAfterRetainedFault(
  fixture: SupervisorApp | undefined,
  shutdownReported: boolean,
): Promise<void> {
  if (fixture === undefined) {
    return;
  }
  if (shutdownReported) {
    await fixture.close().catch(() => undefined);
  } else {
    await fixture.close();
  }
}

export function createStartEofRuntime(
  onPrompt?: (child: FakeChild, frame: OmpFrame) => void,
): ControlledRuntime {
  return createControlledRuntime((child) => {
    closeOnEof(child);
    child.onCommand("prompt", (frame) => {
      child.emitLine({ type: "agent_start" });
      onPrompt?.(child, frame);
    });
  });
}

export function emitAssistantDelta(child: FakeChild, delta: string): void {
  child.emitLine({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
    message: { role: "assistant", content: [] },
  });
}

export function expectRunningAdmission(
  fixture: SupervisorApp,
  session: string,
  token: string,
  admitted: { userMessageId: number; assistantMessageId: number },
): void {
  expect(fixture.tokens.lookup(token)).toBe(session);
  expect(sessionRow(fixture.db, session).status).toBe("running");
  expect(fixture.store.runtimeState(session)?.activeTurn).toEqual({
    userMessageId: admitted.userMessageId,
    assistantMessageId: admitted.assistantMessageId,
  });
}

export function expectCompensatedIdleSession(fixture: SupervisorApp, session: string): void {
  expect(messageRows(fixture.db).filter((row) => row.session_id === session)).toEqual([]);
  expect(sessionRow(fixture.db, session)).toMatchObject({
    status: "idle",
    omp_session_file: null,
    stream_epoch: 1,
  });
}

export async function createSession(app: FastifyInstance, cookie: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(201);
  const body: unknown = response.json();
  if (body === null || typeof body !== "object" || !("id" in body) || typeof body.id !== "string") {
    throw new Error("session creation response omitted id");
  }
  return body.id;
}

export async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = vi.getRealSystemTime() + 8_000;
  while (true) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (vi.getRealSystemTime() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await waitImmediate();
  }
}

export function resumePath(args: readonly string[]): string | undefined {
  const index = args.indexOf("--resume");
  return index === -1 ? undefined : args[index + 1];
}

export function recordedSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): SpawnCall {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  const token = env.WORKBUDDY_MODEL_TOKEN;
  return {
    command,
    args: [...args],
    cwd: typeof options.cwd === "string" ? options.cwd : undefined,
    env,
    stdio: options.stdio,
    shell: options.shell,
    token,
  };
}

export function sudoPrefix(user: string, bin: string, tmpdir?: string): string[] {
  return [
    "-n",
    "-u",
    user,
    "--preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN",
    ...(tmpdir === undefined ? [] : [`TMPDIR=${tmpdir}`]),
    "--",
    "/usr/bin/setpriv",
    "--pdeathsig",
    "KILL",
    "--",
    bin,
  ];
}

export const OWNER_ID = "u1";

async function openOwnedSession(
  fixture: SupervisorApp,
  account = "zhangsan",
): Promise<{ cookie: string; session: string }> {
  const cookie = await cookieFor(fixture.app, account);
  const session = await createSession(fixture.app, cookie);
  return { cookie, session };
}

export function closeOnEof(child: FakeChild): void {
  child.stdin.once("finish", () => {
    child.endStdout();
    child.exit(0);
  });
}

export interface ControlledSession {
  runtime: ControlledRuntime;
  fixture: SupervisorApp;
  cookie: string;
  session: string;
}

export interface HeldPromptSession extends ControlledSession {
  child: FakeChild;
}

export function createStartHeldRuntime(): ControlledRuntime {
  let prompts = 0;
  return createControlledRuntime((child) => {
    closeOnEof(child);
    child.onCommand("prompt", () => {
      child.emitLine({ type: "agent_start" });
      emitAssistantDelta(child, "Hello");
      prompts += 1;
      if (prompts > 1) {
        child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
      }
    });
  });
}

function createManyDeltaRuntime(count: number, delta: string): ControlledRuntime {
  return createControlledRuntime((child) => {
    closeOnEof(child);
    child.onCommand("prompt", () => {
      child.emitLine({ type: "agent_start" });
      for (let n = 0; n < count; n += 1) {
        emitAssistantDelta(child, delta);
      }
    });
  });
}

export function completeHeldTurn(child: { emitLine(frame: object): void }): void {
  child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
}

export async function waitForChild(runtime: ControlledRuntime): Promise<FakeChild> {
  return waitFor(() => runtime.children[0], "controlled child");
}

export async function waitForContent(
  fixture: SupervisorApp,
  session: string,
  content: string,
): Promise<void> {
  await waitFor(
    () =>
      fixture.store.getMessages(session, OWNER_ID)?.messages[1]?.content === content
        ? true
        : undefined,
    `assistant content ${content}`,
  );
}

export async function openStartHeldSession(): Promise<ControlledSession> {
  const runtime = createStartHeldRuntime();
  return { runtime, ...(await openBareSession(runtime.runtime)) };
}

export async function startHeldTurn(opened: ControlledSession, text = "held"): Promise<FakeChild> {
  const response = await postPrompt(
    opened.fixture.app,
    opened.session,
    opened.cookie,
    JSON.stringify({ message: text }),
  );
  expect(response.statusCode).toBe(202);
  const child = await waitForChild(opened.runtime);
  await waitForContent(opened.fixture, opened.session, "Hello");
  return child;
}

export async function openHeldPromptSession(text = "held"): Promise<HeldPromptSession> {
  const opened = await openStartHeldSession();
  return closeOnFixtureFailure(opened.fixture, async () => ({
    ...opened,
    child: await startHeldTurn(opened, text),
  }));
}

export async function openBulkDeltaSession(
  count: number,
  delta: string,
): Promise<ControlledSession> {
  const runtime = createManyDeltaRuntime(count, delta);
  const opened = { runtime, ...(await openBareSession(runtime.runtime)) };
  return closeOnFixtureFailure(opened.fixture, async () => {
    const response = await postPrompt(
      opened.fixture.app,
      opened.session,
      opened.cookie,
      JSON.stringify({ message: "bulk" }),
    );
    expect(response.statusCode).toBe(202);
    await waitForContent(opened.fixture, opened.session, delta.repeat(count));
    return opened;
  });
}

async function closeOnFixtureFailure<T>(
  fixture: SupervisorApp,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await fixture.close().catch(() => undefined);
    throw error;
  }
}

export async function waitForTurn(
  fixture: SupervisorApp,
  sessionId: string,
  status: "done" | "failed",
) {
  return waitFor(() => {
    const tree = fixture.store.getMessages(sessionId, OWNER_ID);
    return tree?.session.status === status ? tree : undefined;
  }, `${sessionId} to become ${status}`);
}

export async function expectHistory(
  fixture: SupervisorApp,
  cookie: string,
  session: string,
  streamCursor: { epoch: number; seq: number | null },
): Promise<void> {
  const history = await fixture.app.inject({
    method: "GET",
    url: `/api/sessions/${session}/messages`,
    headers: { cookie },
  });
  expect(history.statusCode).toBe(200);
  expect(history.headers["cache-control"]).toBe("no-store");
  expect(history.json()).toMatchObject({ streamCursor });
  expect(fixture.supervisor.streamCursor(session)).toEqual(streamCursor);
}

export function eventsFor(events: readonly ObservedEvent[], sessionId: string): ObservedEvent[] {
  return events.filter((entry) => entry.sessionId === sessionId);
}

export function requiredCall(calls: readonly SpawnCall[], index: number): SpawnCall {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(`missing runtime spawn ${index}`);
  }
  return call;
}

export function requiredToken(token: string | undefined): string {
  if (token === undefined) {
    throw new Error("missing runtime token");
  }
  return token;
}

export async function capturedFailure(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected async operation to fail");
}

export function assistantIdFor(fixture: SupervisorApp, sessionId: string): number {
  const assistant = messageRows(fixture.db).find(
    (row) => row.session_id === sessionId && row.role === "assistant",
  );
  if (assistant === undefined) {
    throw new Error("missing assistant row");
  }
  return assistant.id;
}

export function containsMessage(error: unknown, message: string): boolean {
  if (error instanceof Error && error.message.includes(message)) {
    return true;
  }
  if (error === null || typeof error !== "object") {
    return false;
  }
  if ("cause" in error && containsMessage(error.cause, message)) {
    return true;
  }
  if ("errors" in error && Array.isArray(error.errors)) {
    return error.errors.some((item) => containsMessage(item, message));
  }
  return false;
}

export async function assertRetainedFaultOnShutdown(fixture: SupervisorApp, message: string) {
  const shutdownFailure = await capturedFailure(() => fixture.app.close());
  expect(containsMessage(shutdownFailure, message)).toBe(true);
  expect(fixture.db.prepare("SELECT 1 AS usable").get()).toEqual({ usable: 1 });
}

export async function closeFixture(fixture: SupervisorApp | undefined): Promise<void> {
  await fixture?.close();
}

export async function expectSettled(
  work: Promise<unknown>,
  description: string,
  outcome: "resolved" | "rejected",
  boundMs = 5_000,
): Promise<unknown> {
  const deadline = Date.now() + boundMs;
  const observation = observePromise(work);
  while (observation.outcome === "pending" && Date.now() < deadline) {
    await waitImmediate();
  }
  expect(observation.outcome, description).toBe(outcome);
  if (outcome === "resolved") {
    return work;
  }
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error(`${description} resolved instead of rejecting`);
}
