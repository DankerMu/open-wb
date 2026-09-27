/**
 * Issue #473 stop test plumbing, composed over the #464 approval world (production createApp →
 * registerSessions, real fake-omp children, per-child stdin record, injected clock): opens a world
 * for one abort/approval scenario and provides the oracles the stop cases share — abort frames
 * counted by `type`, the probe `frames=` record, public REST reads, the "no error" check and an
 * unhandledRejection collector. The underlying helpers are used unchanged.
 */
import { dirname, join } from "node:path";
import { expect } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  type ApprovalWorld,
  ofType,
  openApprovalWorld,
  prompted,
  sessionEvents,
  waitForEvent,
} from "./session-approval-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";

export type StopScenario =
  | "abort-ok"
  | "abort-ignored"
  | "approval-then-abort"
  | "approval-parallel"
  | "approval-chain-abort-ignored";

export const GRACE_MS = 8_000;

interface PublicStep {
  id: number;
  status: string;
  output: string;
}

interface PublicMessage {
  id: number;
  role: string;
  content: string;
  status: string;
  steps: PublicStep[];
}

interface PublicHistory {
  session: { id: string; status: string };
  messages: PublicMessage[];
}

type TurnEnd = Extract<ChatEvent<number>, { type: "turn.end" }>;

/** Spawn is lazy: the scenario is switched before the first prompt spawns the child. */
export async function openStopWorld(scenario: StopScenario): Promise<ApprovalWorld> {
  const world = await openApprovalWorld(
    scenario === "approval-parallel" ? "approval-parallel" : "approval",
  );
  world.rt.setScenario(scenario);
  return world;
}

export function stop(world: ApprovalWorld): Promise<void> {
  return world.fixture.supervisor.stop(world.session);
}

/** Prompts and waits until the turn published its first two text deltas ("Hello ", "from "). */
export async function heldTurn(world: ApprovalWorld): Promise<void> {
  await prompted(world);
  await waitForEvent(world, "text.delta", 2);
}

/** Frames the child read after the turn's first `prompt` frame. */
export function afterPrompt(frames: readonly OmpFrame[]): OmpFrame[] {
  const index = frames.findIndex((frame) => frame.type === "prompt");
  return index === -1 ? [] : frames.slice(index + 1);
}

/** After the prompt: exactly these select answers (`[id, value]`, in order), then one abort. */
export function expectAnswersThenAbort(
  frames: readonly OmpFrame[],
  answers: ReadonlyArray<readonly [string, string]>,
): void {
  const written = afterPrompt(frames);
  expect(written.map((frame) => frame.type)).toEqual([
    ...answers.map(() => "extension_ui_response"),
    "abort",
  ]);
  expect(written.slice(0, answers.length)).toEqual(
    answers.map(([id, value]) => ({ type: "extension_ui_response", id, value })),
  );
}

/** The runtime writes `{type:"abort",id}`: counted by type, never deep-equal to `{type:"abort"}`. */
export function abortCount(frames: readonly OmpFrame[]): number {
  return frames.filter((frame) => frame.type === "abort").length;
}

export function turnEnds(world: ApprovalWorld): TurnEnd[] {
  return ofType(sessionEvents(world), "turn.end");
}

/** "No error": no `error` event and no failed turn.end on this session's observed stream. */
export function expectNoError(world: ApprovalWorld): void {
  expect(ofType(sessionEvents(world), "error")).toEqual([]);
  expect(turnEnds(world).filter((event) => event.data.status === "failed")).toEqual([]);
}

/** Index of the first observed event of this session matching `match`, -1 when absent. */
export function eventIndex(
  world: ApprovalWorld,
  match: (event: ChatEvent<number>) => boolean,
): number {
  return sessionEvents(world).findIndex((entry) => match(entry.event));
}

export async function history(world: ApprovalWorld): Promise<PublicHistory> {
  const response = await world.fixture.app.inject({
    method: "GET",
    url: `/api/sessions/${world.session}/messages`,
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<PublicHistory>();
}

/** The session's status as `GET /api/sessions` lists it. */
export async function listedStatus(world: ApprovalWorld): Promise<string | undefined> {
  const response = await world.fixture.app.inject({
    method: "GET",
    url: "/api/sessions",
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(200);
  const { sessions } = response.json<{ sessions: Array<{ id: string; status: string }> }>();
  return sessions.find((session) => session.id === world.session)?.status;
}

/**
 * REST probe prompt on the same session: 202 with exactly {userMessageId, assistantMessageId},
 * then one `done` turn.end for that assistant; returns the fake's per-process `frames=` record.
 */
export async function probeFrames(world: ApprovalWorld): Promise<string> {
  const ended = turnEnds(world).length;
  const writePath = join(dirname(world.rt.runtime.sandboxRoot), "probe.txt");
  const message = `probe:${String(process.pid)}:${writePath}`;
  const response = await postPrompt(
    world.fixture.app,
    world.session,
    world.cookie,
    JSON.stringify({ message }),
  );
  expect(response.statusCode).toBe(202);
  const body = response.json<{ userMessageId: number; assistantMessageId: number }>();
  expect(Object.keys(body).sort()).toEqual(["assistantMessageId", "userMessageId"]);
  const ends = await waitForEvent(world, "turn.end", ended + 1);
  expect(ends.at(-1)).toEqual({
    type: "turn.end",
    data: { messageId: body.assistantMessageId, status: "done" },
  });
  const probe = (await history(world)).messages.find(
    (entry) => entry.id === body.assistantMessageId,
  );
  const text = probe?.content ?? "";
  return / frames=(\S*) cwd=/u.exec(text)?.[1] ?? `<no frames= in ${text}>`;
}

export interface RejectionLog {
  reasons: unknown[];
  dispose(): void;
}

/** Collects process-level unhandled rejections until `dispose()`. */
export function collectRejections(): RejectionLog {
  const reasons: unknown[] = [];
  const listener = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", listener);
  return {
    reasons,
    dispose() {
      process.off("unhandledRejection", listener);
    },
  };
}
