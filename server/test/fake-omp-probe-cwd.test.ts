/**
 * Issue #520 fake-omp probe `cwd=` (parent s1c-session-metadata-presentation 6.2).
 * probe 回报在 ` frames=` 之后以 ` cwd=<process.cwd()>` 收尾；宿主以所选目录的 realpath 比较
 * （macOS tmpdir 为 /var → /private/var 符号链接）。临时目录名同时含空格与 ` cwd=`，
 * 证明「末标签取余量」切分无歧义。解析器与 uid-isolation.test.ts 私有的 parseLabeledReport 同规则。
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  closeSession,
  type Frame,
  HANDSHAKE,
  isTextDelta,
  response,
  type Session,
  startFake,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

const HOME = "/tmp/fake-omp-cwd home";
const AGENT = "/tmp/fake-omp-cwd agent";
/** 显式钉住 __CF_USER_TEXT_ENCODING，macOS 与 Linux 的 env 键表一致。 */
const ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/bin",
  HOME,
  PI_CODING_AGENT_DIR: AGENT,
  __CF_USER_TEXT_ENCODING: "0:0:0",
};
const ENV_KEYS = "HOME,PATH,PI_CODING_AGENT_DIR,__CF_USER_TEXT_ENCODING";
const FRAMES = "negotiate_protocol,get_state,prompt";
const LABELS = ["uid", "gid", "env", "home", "agent", "environ", "wrote", "frames", "cwd"] as const;
const ENVIRON = process.platform === "linux" ? "readable" : "ENOENT";
const UID = process.getuid?.();
const GID = process.getgid?.();
if (typeof UID !== "number" || typeof GID !== "number") {
  throw new Error("posix uid/gid unavailable");
}

const temps: string[] = [];

afterEach(async () => {
  await stopFakeChildren();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fake omp probe cwd field", () => {
  it("ends the whole probe delta with frames=... cwd=<realpath of the spawn cwd>", async () => {
    const { session, real, delta } = await probeInTempDir();
    expect(delta).toBe(
      `uid=${String(UID)} gid=${String(GID)} env=${ENV_KEYS} home=${HOME} agent=${AGENT} environ=${ENVIRON} wrote=ok frames=${FRAMES} cwd=${real}`,
    );
    expect(delta.endsWith(` frames=${FRAMES} cwd=${real}`)).toBe(true);
    await closeSession(session);
  });

  it("splits frames without the cwd suffix and cwd as the remainder with space and =", async () => {
    const { session, real, delta } = await probeInTempDir();
    const parsed = parseReport(delta);
    expect(parsed.wrote).toBe("ok");
    expect(parsed.frames).toBe(FRAMES);
    expect(parsed.cwd).toBe(real);
    expect(parsed.cwd).toContain(" cwd=probe-");
    await closeSession(session);
  });

  it("keeps the probe turn frame order: ack, agent_start, one delta, stop, terminal end", async () => {
    const { session, ack, delta, end } = await probeInTempDir();
    expect(session.frames.slice(session.frames.indexOf(ack))).toEqual([
      ack,
      { type: "agent_start" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta },
        message: { role: "assistant", content: [] },
      },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } },
      end,
    ]);
    await closeSession(session);
  });
});

/** 路径同时含空格与 ` cwd=`；比较值取 realpath（macOS /var → /private/var）。 */
async function probeInTempDir(): Promise<{
  session: Session;
  real: string;
  ack: Frame;
  delta: string;
  end: Frame;
}> {
  const dir = mkdtempSync(join(tmpdir(), "open wb cwd=probe-"));
  temps.push(dir);
  const real = realpathSync(dir);
  const probe = await probeIn(dir, join(dir, "probe out.txt"));
  return { ...probe, real };
}

async function probeIn(
  cwd: string,
  writePath: string,
): Promise<{ session: Session; ack: Frame; delta: string; end: Frame }> {
  const session = startFake({ scenario: "normal", cwd, env: ENV });
  await session.wait((frame) => frame.type === "ready");
  session.write(HANDSHAKE);
  await session.wait(response("protocol-1", "negotiate_protocol"));
  await session.wait(response("state-1", "get_state"));
  session.write({
    id: "req_probe",
    type: "prompt",
    message: `probe:${String(process.pid)}:${writePath}`,
  });
  const ack = await session.wait(response("req_probe", "prompt"));
  expect(ack).toEqual({
    id: "req_probe",
    type: "response",
    command: "prompt",
    success: true,
    data: { agentInvoked: true },
  });
  const end = await session.wait(
    (frame) => frame.type === "agent_end" && frame.isTerminal === true,
  );
  expect(end).toEqual({ type: "agent_end", messages: [], isTerminal: true });
  const deltas = session.frames.filter(isTextDelta);
  expect(deltas).toHaveLength(1);
  const delta = asRecord(deltas[0]?.assistantMessageEvent).delta;
  expect(typeof delta).toBe("string");
  return { session, ack, delta: String(delta), end };
}

/** 与 parseLabeledReport 同规则：按标签次序在 ` <next>=` 处切分，末标签取余量。 */
function parseReport(report: string): Record<(typeof LABELS)[number], string> {
  const parsed: Partial<Record<(typeof LABELS)[number], string>> = {};
  let rest = report;
  for (let index = 0; index < LABELS.length; index += 1) {
    const label = LABELS[index];
    const prefix = `${String(label)}=`;
    if (label === undefined || !rest.startsWith(prefix)) {
      throw new Error(`probe report missing ${String(label)}=`);
    }
    rest = rest.slice(prefix.length);
    const next = LABELS[index + 1];
    if (next === undefined) {
      parsed[label] = rest;
      break;
    }
    const splitAt = rest.indexOf(` ${next}=`);
    if (splitAt === -1) {
      throw new Error(`probe report missing ${next}=`);
    }
    parsed[label] = rest.slice(0, splitAt);
    rest = rest.slice(splitAt + 1);
  }
  const { uid, gid, env, home, agent, environ, wrote, frames, cwd } = parsed;
  if (
    uid === undefined ||
    gid === undefined ||
    env === undefined ||
    home === undefined ||
    agent === undefined ||
    environ === undefined ||
    wrote === undefined ||
    frames === undefined ||
    cwd === undefined
  ) {
    throw new Error("probe report is truncated");
  }
  return { uid, gid, env, home, agent, environ, wrote, frames, cwd };
}
