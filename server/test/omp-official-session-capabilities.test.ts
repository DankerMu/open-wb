/**
 * Issue #1660 (s1d-experts-skills task 6.2, design D8): experts「专家提示词注入」 scenario「提示词进入系统
 * 提示词」 against the official omp v18.12.3 binary — the omp premise of chat-sessions「派发前按会话设置
 * 对齐进程」's capability fingerprint: after the session's expert is switched, the next prompt runs on
 * a restarted process (`stream_epoch` one up) whose system prompt holds the new expert's sentinel
 * and no longer the old one. The fake omp builds no system prompt; only the real binary shows it.
 *
 * The world is `openProxiedApp` (support/omp-official-proxied.ts): the production sessions assembly
 * (createApp → registerSessions → SessionSupervisor) in front of the binary, the model proxy, the
 * fake upstream (which records no message body). Experts are created over `POST /api/experts`, the
 * session's expert is set over `PUT /api/sessions/:id/capabilities`; `stream_epoch` is read from the
 * app's database. The oracle is omp's own RPC `get_state.systemPrompt`, taken through the helper's
 * `probeState` seam after each turn has ended (precedent: omp-official-session-config.test.ts).
 *
 * Run locally (`OMP_BIN` absolute):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-session-capabilities.test.ts --coverage=false
 */
import { describe, expect, it } from "vitest";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import {
  openAppSession,
  openProxiedApp,
  type ProxiedApp,
  publishedOf,
  until,
} from "./support/omp-official-proxied.js";

const CASE = { timeout: 400_000 };
const SENTINEL_1 = "EXPERT-SENTINEL-1";
const SENTINEL_2 = "EXPERT-SENTINEL-2";

function inject(world: ProxiedApp, method: "POST" | "PUT", url: string, body: unknown) {
  return world.app.inject({
    method,
    url,
    headers: { cookie: world.cookie, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

async function createExpert(world: ProxiedApp, prompt: string): Promise<string> {
  const response = await inject(world, "POST", "/api/experts", {
    name: "哨兵专家",
    category: "开发",
    prompt,
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

async function setExpert(world: ProxiedApp, session: string, expertId: string): Promise<void> {
  const response = await inject(world, "PUT", `/api/sessions/${session}/capabilities`, {
    expertId,
  });
  expect([response.statusCode, response.json()]).toEqual([
    200,
    { expertId, disabledSkills: [], disabledConnectors: [] },
  ]);
}

/** One prompt to its published `turn.end`. */
async function turn(world: ProxiedApp, session: string, text: string): Promise<void> {
  const ended = () => publishedOf(world, session).filter((e) => e.type === "turn.end").length;
  const before = ended();
  const response = await inject(world, "POST", `/api/sessions/${session}/prompt`, {
    message: text,
  });
  expect(response.statusCode).toBe(202);
  await until(() => ended() > before, `the turn of ${text}`);
}

function epochOf(world: ProxiedApp, session: string): number {
  const row = world.db
    .prepare("SELECT stream_epoch FROM chat_sessions WHERE id = ?")
    .get(session) as { stream_epoch: number };
  return Number(row.stream_epoch);
}

async function systemPrompt(world: ProxiedApp): Promise<string> {
  const state = await world.probeState();
  const prompt = state.systemPrompt;
  return Array.isArray(prompt) ? prompt.join("\n") : String(prompt);
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: session expert prompt`, () => {
  it(
    "the expert's prompt reaches get_state.systemPrompt; after switching experts the next prompt restarts and only the new sentinel is there",
    CASE,
    async () => {
      const world = await openProxiedApp();
      const first = await createExpert(
        world,
        `你是第一位哨兵专家（${SENTINEL_1}）。\n回答尽量简短。`,
      );
      const second = await createExpert(
        world,
        `你是第二位哨兵专家（${SENTINEL_2}）。\n回答尽量简短。`,
      );
      const session = await openAppSession(world);

      await setExpert(world, session, first);
      await turn(world, session, "你好");
      const epoch = epochOf(world, session);
      const before = await systemPrompt(world);
      console.log(
        `[session-capabilities] ${JSON.stringify({ epoch, sentinel1: before.includes(SENTINEL_1), sentinel2: before.includes(SENTINEL_2) })}`,
      );
      expect(before).toContain(SENTINEL_1);
      expect(before).not.toContain(SENTINEL_2);

      await setExpert(world, session, second);
      await turn(world, session, "再说一句");
      const after = await systemPrompt(world);
      console.log(
        `[session-capabilities] ${JSON.stringify({ epoch: epochOf(world, session), sentinel1: after.includes(SENTINEL_1), sentinel2: after.includes(SENTINEL_2) })}`,
      );

      expect(epochOf(world, session)).toBe(epoch + 1);
      expect(after).toContain(SENTINEL_2);
      expect(after).not.toContain(SENTINEL_1);
      expect(after).not.toContain("session-config");
      expect(world.faults).toEqual([]);
    },
  );
});
