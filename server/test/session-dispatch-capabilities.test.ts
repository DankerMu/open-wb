/**
 * Issue #1660 (s1d-experts-skills task 6.2, design D8): chat-sessions「派发前按会话设置对齐进程」 step 1's
 * capability fingerprint — a live process retires and respawns before a dispatch whose effective
 * capabilities (the visible expert's prompt, the disabled skills as `skill:<name>`) are not the
 * ones its session config files were written from; unchanged capabilities reuse it. Scenarios
 * 「会话能力变化则在下一条重启」「能力未变则复用」「在途回合中修改能力不打断」「删除使用中的专家」, the
 * regenerate alignment, experts「专家提示词注入」, and the temporary processes of fork
 * (session-metadata「继承专家与停用技能」) and undo (omp-runtime: a temporary process takes its
 * session's effective capabilities). And s1d-connectors group 5 (D8): a session's disabled
 * connectors (`mcp:<name>`) restart its live process at the next prompt; the fingerprint takes in the
 * managed `mcp.json` bytes — a connector registered, edited, disabled or deleted restarts the live
 * process before the next prompt, a probe or an account-default write does not, and a change during
 * an in-flight turn leaves it alone (「登记连接器使存活会话在下一条前重启」「连接器未变则复用」
 * 「在途回合中修改连接器不打断」), over the real `mcp.json` publisher wired as `assembly.mcpPublish`;
 * an unreadable `mcp.json` (not missing) is a step-1 failure, 502 `agent_unavailable`.
 *
 * Every world is the production createApp → registerSessions assembly over real fake-omp children
 * and a real in-memory SQLite, driven over REST (`/api/experts`, `/api/sessions/:id/capabilities`,
 * prompt, regenerate, undo). A spawn wrapper reads, at `spawnImpl` time (the files are written
 * before it), the session yml, the prompt file and the `session-config/` listing. Oracles: those
 * bytes, the spawn argv, Node's own exit state of each child, per-child stdin frames,
 * `stream_epoch` and SQLite rows; never supervisor internals. Expected prompts are the experts'
 * own, read over `GET /api/experts`; the yml lines are the spec's literals.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { createMcpPublisher } from "../src/connectors/mcp-json.js";
import { createConnectorStore } from "../src/connectors/store.js";
import { ompAgentDir } from "../src/sessions/omp/state-layout.js";
import {
  type ApprovalWorld,
  flagValue,
  openApprovalWorld,
  pendingApproval,
  REAL,
  settle,
  spawnedAt,
} from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { processOf } from "./session-composer-helpers.js";
import { forkAt, forkWorlds, openForkWorld, seedTwoTurns } from "./session-fork-helpers.js";
import { answered, sendPrompt, snapshot } from "./session-regenerate-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE, cookieFor } from "./session-rest-helpers.js";
import { requiredCall, resumePath, waitForTurn } from "./session-supervisor-helpers.js";
import { isLive } from "./session-supervisor-pool-helpers.js";
import { postUndo, seedUndoable, undone } from "./session-undo-helpers.js";

const worlds = forkWorlds();

const TEST_ENGINEER = "builtin:test-engineer";
const DATA_ANALYST = "builtin:data-analyst";
const NO_SKILLS = "disabledExtensions: []\n";
const DEPLOY = 'disabledExtensions: ["skill:deploy"]\n';

/** What one spawn was handed: its argv and, read at `spawnImpl` time, its two session files. */
interface SpawnedConfig {
  args: readonly string[];
  key: string;
  yml: string;
  /** The `--append-system-prompt` file's text; null without the flag. */
  md: string | null;
  /** `session-config/` entries at that moment, sorted. */
  listing: string[];
  ymlPath: string;
  mdPath: string | null;
  /** The managed `mcp.json` bytes at that moment; null when there is none (no publisher wired). */
  mcp: string | null;
}

type World = ApprovalWorld;

/** Wraps the runtime's spawnImpl (before any spawn) to record each spawn's session config. */
function recordConfigs(world: World): SpawnedConfig[] {
  const records: SpawnedConfig[] = [];
  const dir = join(world.rt.runtime.stateDir, "session-config");
  const mcpPath = join(ompAgentDir(world.rt.runtime.stateDir), "mcp.json");
  const inner = world.rt.runtime.spawnImpl;
  world.rt.runtime.spawnImpl = (command, args, options) => {
    const configs = args.flatMap((arg, index) => (arg === "--config" ? [args[index + 1]] : []));
    const ymlPath = String(configs[1]);
    const mdPath = flagValue(args, "--append-system-prompt") ?? null;
    records.push({
      args: [...args],
      key: basename(ymlPath, ".yml"),
      yml: readFileSync(ymlPath, "utf8"),
      md: mdPath === null ? null : readFileSync(mdPath, "utf8"),
      listing: readdirSync(dir).sort(),
      ymlPath,
      mdPath,
      mcp: existsSync(mcpPath) ? readFileSync(mcpPath, "utf8") : null,
    });
    return inner(command, args, options);
  };
  return records;
}

function configAt(records: readonly SpawnedConfig[], index: number): SpawnedConfig {
  const record = records[index];
  if (record === undefined) {
    throw new Error(`no spawn ${String(index)}`);
  }
  return record;
}

function call(
  world: World,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  cookie = world.cookie,
): Promise<LightMyRequestResponse> {
  return world.fixture.app.inject({
    method,
    url,
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/** The owner's own expert with `prompt` and no declared skill; returns its id. */
async function createExpert(world: World, prompt: string): Promise<string> {
  const response = await call(world, "POST", "/api/experts", {
    name: "自建专家",
    category: "开发",
    prompt,
    skills: [],
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

async function promptOf(world: World, expertId: string): Promise<string> {
  const response = await call(world, "GET", "/api/experts");
  expect(response.statusCode).toBe(200);
  const experts = (response.json() as { experts: Array<{ id: string; prompt: string }> }).experts;
  const prompt = experts.find((expert) => expert.id === expertId)?.prompt;
  if (prompt === undefined) {
    throw new Error(`expert ${expertId} not listed`);
  }
  return prompt;
}

async function putCaps(world: World, body: object, expected: object): Promise<void> {
  const response = await call(world, "PUT", `/api/sessions/${world.session}/capabilities`, body);
  expect([response.statusCode, response.json()]).toEqual([200, expected]);
}

/**
 * The dispatch after `before` restarted: one more spawn, `--resume` at the file the last turn
 * persisted, `stream_epoch` exactly one up, the previous key's files gone, a new key.
 */
function expectRestart(
  world: World,
  records: readonly SpawnedConfig[],
  before: ReturnType<typeof processOf>,
): SpawnedConfig {
  const index = before.spawns;
  expect(processOf(world)).toMatchObject({ epoch: before.epoch + 1, spawns: index + 1 });
  const previous = configAt(records, index - 1);
  const fresh = configAt(records, index);
  expect(resumePath(fresh.args)).toBe(before.file);
  expect(fresh.key).not.toBe(previous.key);
  expect(existsSync(previous.ymlPath)).toBe(false);
  if (previous.mdPath !== null) {
    expect(existsSync(previous.mdPath)).toBe(false);
  }
  // The previous process had exited when this one spawned: never two alive.
  expect(isLive(spawnedAt(world, index - 1).child)).toBe(false);
  expect(fresh.listing.filter((entry) => !entry.startsWith(fresh.key))).toEqual([]);
  return fresh;
}

function setColumns(db: DatabaseSync, session: string, expertId: string, disabled: string): void {
  db.prepare("UPDATE chat_sessions SET expert_id = ?, disabled_skills = ? WHERE id = ?").run(
    expertId,
    disabled,
    session,
  );
}

describe("派发前按会话设置对齐进程：会话能力 (chat-sessions, design D8)", () => {
  it(
    "会话能力变化则在下一条重启：换自建专家、改其提示词、改停用列表各在下一条退役重启，argv 与文件内容随之变化",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const records = recordConfigs(world);
      await putCaps(
        world,
        { expertId: DATA_ANALYST },
        { expertId: DATA_ANALYST, disabledSkills: [], disabledConnectors: [] },
      );
      await answered(world);
      expect(configAt(records, 0)).toMatchObject({
        yml: NO_SKILLS,
        md: await promptOf(world, DATA_ANALYST),
      });

      const e = await createExpert(world, "你是自建专家 E。\n原提示词。");
      await putCaps(
        world,
        { expertId: e },
        { expertId: e, disabledSkills: [], disabledConnectors: [] },
      );
      let before = processOf(world);
      await answered(world);
      let fresh = expectRestart(world, records, before);
      expect([fresh.yml, fresh.md]).toEqual([NO_SKILLS, "你是自建专家 E。\n原提示词。"]);
      expect(flagValue(fresh.args, "--append-system-prompt")).toBe(fresh.mdPath);

      const edited = await call(world, "PUT", `/api/experts?id=${e}`, {
        name: "自建专家",
        category: "开发",
        prompt: "你是自建专家 E。\n改后的提示词。",
        skills: [],
      });
      expect(edited.statusCode).toBe(200);
      before = processOf(world);
      await answered(world);
      fresh = expectRestart(world, records, before);
      expect([fresh.yml, fresh.md]).toEqual([NO_SKILLS, "你是自建专家 E。\n改后的提示词。"]);

      await putCaps(
        world,
        { disabledSkills: ["deploy"] },
        { expertId: e, disabledSkills: ["deploy"], disabledConnectors: [] },
      );
      before = processOf(world);
      await answered(world);
      fresh = expectRestart(world, records, before);
      expect([fresh.yml, fresh.md]).toEqual([DEPLOY, "你是自建专家 E。\n改后的提示词。"]);
      expect(world.errors).toEqual([]);

      // 能力未变则复用: nothing changed, then a PUT of the same values (E declares no skill).
      const settled = processOf(world);
      const live = spawnedAt(world, settled.spawns - 1);
      await answered(world);
      expect(processOf(world)).toEqual(settled);
      await putCaps(
        world,
        { expertId: e, disabledSkills: ["deploy"] },
        { expertId: e, disabledSkills: ["deploy"], disabledConnectors: [] },
      );
      await answered(world);
      expect(processOf(world)).toEqual(settled);
      expect(isLive(live.child)).toBe(true);
      expect(records).toHaveLength(settled.spawns);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "regenerate 同样按当前能力对齐：PUT 测试工程师后 regenerate 202，处理它的新进程 argv 带其提示词文件",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const records = recordConfigs(world);
      await answered(world);
      expect(configAt(records, 0)).toMatchObject({ yml: NO_SKILLS, md: null, mdPath: null });
      await putCaps(
        world,
        { expertId: TEST_ENGINEER },
        { expertId: TEST_ENGINEER, disabledSkills: [], disabledConnectors: [] },
      );
      const before = processOf(world);

      const response = await postSessionAction(
        world.fixture.app,
        "regenerate",
        world.session,
        world.cookie,
      );

      expect(response.statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");
      await settle();
      const fresh = expectRestart(world, records, before);
      expect([fresh.yml, fresh.md]).toEqual([NO_SKILLS, await promptOf(world, TEST_ENGINEER)]);
      expect(spawnedAt(world, 1).stdin.map((frame) => frame.type)).toContain("branch");
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "删除使用中的专家（空闲）：DELETE 204 不动进程，能力读出 null；下一条重启且 argv 无 --append-system-prompt、无新 key 的 .md",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const records = recordConfigs(world);
      const e = await createExpert(world, "将被删除的专家 E");
      await putCaps(
        world,
        { expertId: e },
        { expertId: e, disabledSkills: [], disabledConnectors: [] },
      );
      await answered(world);
      expect(configAt(records, 0).md).toBe("将被删除的专家 E");
      const child = spawnedAt(world, 0);
      const frames = child.stdin.length;
      const before = processOf(world);

      expect((await call(world, "DELETE", `/api/experts?id=${e}`)).statusCode).toBe(204);
      const caps = await call(world, "GET", `/api/sessions/${world.session}/capabilities`);
      expect(caps.json()).toEqual({ expertId: null, disabledSkills: [], disabledConnectors: [] });
      await settle();
      expect(processOf(world)).toEqual(before);
      expect([child.stdin.length, isLive(child.child)]).toEqual([frames, true]);

      await answered(world);
      const fresh = expectRestart(world, records, before);
      expect(fresh.args).not.toContain("--append-system-prompt");
      expect(fresh.listing).not.toContain(`${fresh.key}.md`);
      expect([fresh.yml, fresh.md]).toEqual([NO_SKILLS, null]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "停用连接器在下一条重启：PUT disabledConnectors [gitlab] 不动进程；下一条重启且 disabledExtensions 含 mcp:gitlab，再一条复用",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const records = recordConfigs(world);
      await answered(world);
      const child = spawnedAt(world, 0);
      const frames = child.stdin.length;
      const before = processOf(world);

      await putCaps(
        world,
        { disabledConnectors: ["gitlab"] },
        { expertId: null, disabledSkills: [], disabledConnectors: ["gitlab"] },
      );
      await settle();
      expect(processOf(world)).toEqual(before);
      expect([child.stdin.length, isLive(child.child)]).toEqual([frames, true]);

      await answered(world);
      const fresh = expectRestart(world, records, before);
      expect([fresh.yml, fresh.md]).toEqual(['disabledExtensions: ["mcp:gitlab"]\n', null]);

      const settled = processOf(world);
      await answered(world);
      expect(processOf(world)).toEqual(settled);
      expect(isLive(spawnedAt(world, settled.spawns - 1).child)).toBe(true);
      expect(records).toHaveLength(settled.spawns);
      expect(world.errors).toEqual([]);
    },
  );
});

/**
 * A turn held on its approval with `change` applied meanwhile: the PUT / DELETE answers at once,
 * the child gets no frame and keeps running, the approval ends the turn done; the next prompt
 * (on a `branch` child) restarts. Returns that next spawn's record.
 */
async function duringTurn(
  world: World,
  records: readonly SpawnedConfig[],
  change: () => Promise<void>,
): Promise<SpawnedConfig> {
  const pending = await pendingApproval(world);
  const child = spawnedAt(world, 0);
  const frames = child.stdin.length;

  await change();

  expect(child.stdin).toHaveLength(frames);
  expect(world.rt.calls).toHaveLength(1);
  expect(child.child.exitCode).toBeNull();
  const allowed = await call(
    world,
    "POST",
    `/api/sessions/${world.session}/approvals/${String(pending.id)}`,
    { decision: "allow" },
  );
  expect(allowed.statusCode).toBe(200);
  await waitForTurn(world.fixture, world.session, "done");
  await settle();
  expect(child.stdin.slice(frames).map((frame) => frame.type)).toEqual(["extension_ui_response"]);
  expect(world.rt.calls).toHaveLength(1);

  const before = processOf(world);
  world.rt.setScenario("branch");
  expect((await sendPrompt(world, "after the change")).statusCode).toBe(202);
  await waitForTurn(world.fixture, world.session, "done");
  await settle();
  return expectRestart(world, records, before);
}

describe("在途回合期间改能力 (chat-sessions「在途回合中修改能力不打断」「删除使用中的专家」)", () => {
  it(
    "回合挂在审批上时 PUT 测试工程师：即时 200、不发帧不退进程；回合照常结束，下一条重启并带其提示词",
    REAL,
    async () => {
      const world = await openApprovalWorld("approval");
      try {
        const records = recordConfigs(world);
        const fresh = await duringTurn(world, records, async () => {
          await putCaps(
            world,
            { expertId: TEST_ENGINEER },
            { expertId: TEST_ENGINEER, disabledSkills: [], disabledConnectors: [] },
          );
        });
        expect(configAt(records, 0).md).toBeNull();
        expect([fresh.yml, fresh.md]).toEqual([NO_SKILLS, await promptOf(world, TEST_ENGINEER)]);
        expect(world.errors).toEqual([]);
      } finally {
        await world.fixture.close();
      }
    },
  );

  it(
    "回合挂在审批上时删除使用中的专家：即时 204、回合不受影响；下一条重启且 argv 无 --append-system-prompt、无新 key 的 .md",
    REAL,
    async () => {
      const world = await openApprovalWorld("approval");
      try {
        const records = recordConfigs(world);
        const e = await createExpert(world, "回合中被删除的专家 E");
        await putCaps(
          world,
          { expertId: e },
          { expertId: e, disabledSkills: [], disabledConnectors: [] },
        );
        const fresh = await duringTurn(world, records, async () => {
          expect((await call(world, "DELETE", `/api/experts?id=${e}`)).statusCode).toBe(204);
        });
        expect(configAt(records, 0).md).toBe("回合中被删除的专家 E");
        expect(fresh.args).not.toContain("--append-system-prompt");
        expect(fresh.listing).not.toContain(`${fresh.key}.md`);
        expect(fresh.md).toBeNull();
        expect(world.errors).toEqual([]);
      } finally {
        await world.fixture.close();
      }
    },
  );
});

describe("临时进程用其会话的有效能力 (session-metadata「继承专家与停用技能」, omp-runtime)", () => {
  it(
    "fork：源会话专家为自建 E、停用 deploy → 临时进程带 E 的提示词文件与 skill:deploy；源会话指向不存在的专家 → 不带 --append-system-prompt",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const records = recordConfigs(world);
      const e = await createExpert(world, "fork 源会话的专家 E");
      await putCaps(
        world,
        { expertId: e },
        { expertId: e, disabledSkills: [], disabledConnectors: [] },
      );
      await putCaps(
        world,
        { disabledSkills: ["deploy"] },
        { expertId: e, disabledSkills: ["deploy"], disabledConnectors: [] },
      );
      const seeded = seedTwoTurns(world);

      await forkAt(world, seeded.u2);

      expect(world.rt.calls).toHaveLength(1);
      const temp = configAt(records, 0);
      expect(flagValue(temp.args, "--append-system-prompt")).toBe(temp.mdPath);
      expect([temp.yml, temp.md]).toEqual([DEPLOY, "fork 源会话的专家 E"]);

      setColumns(world.fixture.db, world.session, "builtin:nope", "[]");
      await forkAt(world, seeded.u2);

      expect(world.rt.calls).toHaveLength(2);
      const other = configAt(records, 1);
      expect(other.args).not.toContain("--append-system-prompt");
      expect([other.yml, other.md]).toEqual([NO_SKILLS, null]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "undo：临时进程以该会话自己的有效能力启动（测试工程师的提示词与 skill:deploy）",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const records = recordConfigs(world);
      await putCaps(
        world,
        { expertId: TEST_ENGINEER, disabledSkills: ["deploy"] },
        { expertId: TEST_ENGINEER, disabledSkills: ["deploy"], disabledConnectors: [] },
      );
      const { u2, file } = seedUndoable(world);

      undone(await postUndo(world, u2));

      expect(world.rt.calls).toHaveLength(1);
      const temp = configAt(records, 0);
      expect(resumePath(requiredCall(world.rt.calls, 0).args)).toBe(file);
      expect([temp.yml, temp.md]).toEqual([DEPLOY, await promptOf(world, TEST_ENGINEER)]);
      expect(world.errors).toEqual([]);
    },
  );
});

const COMMAND = "/nonexistent/gitlab-mcp";
const EMPTY_MCP = '{\n  "mcpServers": {}\n}\n';

/** The spec's `mcp.json` text rule for one stdio `gitlab` with no args and no env. */
function gitlabMcp(command: string): string {
  const gitlab = { type: "stdio", command, args: [], env: {} };
  return `${JSON.stringify({ mcpServers: { gitlab } }, null, 2)}\n`;
}

/**
 * An approval world whose `assembly.mcpPublish` is the real publisher over its own state layout (the
 * entry's single publisher; the default is a no-op, so REST writes would not touch `mcp.json`), with
 * the entry's startup publication done: the empty-table bytes are on disk before the first spawn.
 * Returns it with lisi's (admin) cookie.
 */
async function openConnectorWorld(): Promise<{ world: World; admin: string }> {
  let stateDir: string | null = null;
  let publish: () => Promise<void> = () => Promise.reject(new Error("publisher not built"));
  const world = await openApprovalWorld("approval", {
    prepare(db) {
      publish = createMcpPublisher({
        agentDir: () => (stateDir === null ? null : ompAgentDir(stateDir)),
        store: createConnectorStore(db),
      }).publish;
    },
    assembly: { mcpPublish: () => publish() },
  });
  stateDir = world.rt.runtime.stateDir;
  await publish();
  return { world, admin: await cookieFor(world.fixture.app, "lisi") };
}

function mcpNow(world: World): string {
  return readFileSync(join(ompAgentDir(world.rt.runtime.stateDir), "mcp.json"), "utf8");
}

async function connectorWrite(
  world: World,
  admin: string,
  method: "POST" | "PUT",
  body: object,
): Promise<void> {
  const url = method === "POST" ? "/api/connectors" : "/api/connectors?name=gitlab";
  const response = await call(world, method, url, body, admin);
  expect(response.statusCode).toBe(method === "POST" ? 201 : 200);
}

describe("派发前按会话设置对齐进程：连接器 (chat-sessions, s1d-connectors D8)", () => {
  it(
    "登记 / 修改 / 停用连接器各使存活会话在下一条前重启，spawn 时读到新的 mcp.json；不变、探活与账号缺省则复用",
    REAL,
    async () => {
      const { world, admin } = await openConnectorWorld();
      try {
        world.rt.setScenario("branch");
        const records = recordConfigs(world);
        await answered(world);
        expect(configAt(records, 0)).toMatchObject({ yml: NO_SKILLS, mcp: EMPTY_MCP });

        await connectorWrite(world, admin, "POST", {
          name: "gitlab",
          type: "stdio",
          command: COMMAND,
        });
        let before = processOf(world);
        await answered(world);
        expect(expectRestart(world, records, before).mcp).toBe(gitlabMcp(COMMAND));

        await connectorWrite(world, admin, "PUT", { command: `${COMMAND}2` });
        before = processOf(world);
        await answered(world);
        expect(expectRestart(world, records, before).mcp).toBe(gitlabMcp(`${COMMAND}2`));

        await connectorWrite(world, admin, "PUT", { command: `${COMMAND}2`, enabled: false });
        before = processOf(world);
        await answered(world);
        const fresh = expectRestart(world, records, before);
        expect([fresh.mcp, fresh.yml]).toEqual([EMPTY_MCP, NO_SKILLS]);

        // 连接器未变则复用: nothing changed; then a probe and the account default, neither of
        // which rewrites `mcp.json` or the session's own list.
        const settled = processOf(world);
        const live = spawnedAt(world, settled.spawns - 1);
        await answered(world);
        expect(processOf(world)).toEqual(settled);
        const probed = await call(
          world,
          "POST",
          "/api/connectors/probe?name=gitlab",
          undefined,
          admin,
        );
        expect([
          probed.statusCode,
          (probed.json() as { probe: { status: string } }).probe.status,
        ]).toEqual([200, "failed"]);
        const defaults = await call(world, "PUT", "/api/connectors/defaults", {
          disabledConnectors: ["gitlab"],
        });
        expect(defaults.statusCode).toBe(200);
        expect(mcpNow(world)).toBe(EMPTY_MCP);
        await answered(world);
        expect(processOf(world)).toEqual(settled);
        expect(isLive(live.child)).toBe(true);
        expect(records).toHaveLength(settled.spawns);
        expect(world.errors).toEqual([]);
      } finally {
        await world.fixture.close();
      }
    },
  );

  it(
    "在途回合中修改连接器不打断：PUT 即时 200 且 mcp.json 已重写；回合照常结束，下一条重启并读到改后的参数",
    REAL,
    async () => {
      const { world, admin } = await openConnectorWorld();
      try {
        await connectorWrite(world, admin, "POST", {
          name: "gitlab",
          type: "stdio",
          command: COMMAND,
        });
        const records = recordConfigs(world);
        const fresh = await duringTurn(world, records, async () => {
          await connectorWrite(world, admin, "PUT", { command: `${COMMAND}2` });
          expect(mcpNow(world)).toBe(gitlabMcp(`${COMMAND}2`));
        });
        expect(configAt(records, 0).mcp).toBe(gitlabMcp(COMMAND));
        expect([fresh.mcp, fresh.yml]).toEqual([gitlabMcp(`${COMMAND}2`), NO_SKILLS]);
        expect(world.errors).toEqual([]);
      } finally {
        await world.fixture.close();
      }
    },
  );

  it(
    "删除启用的连接器使存活会话在下一条前重启，spawn 时 mcp.json 为空表；再一条复用",
    REAL,
    async () => {
      const { world, admin } = await openConnectorWorld();
      try {
        world.rt.setScenario("branch");
        const records = recordConfigs(world);
        await connectorWrite(world, admin, "POST", {
          name: "gitlab",
          type: "stdio",
          command: COMMAND,
        });
        await answered(world);
        expect(configAt(records, 0).mcp).toBe(gitlabMcp(COMMAND));
        const child = spawnedAt(world, 0);
        const frames = child.stdin.length;
        const before = processOf(world);

        const deleted = await call(
          world,
          "DELETE",
          "/api/connectors?name=gitlab",
          undefined,
          admin,
        );
        expect(deleted.statusCode).toBe(204);
        expect(mcpNow(world)).toBe(EMPTY_MCP);
        await settle();
        expect(processOf(world)).toEqual(before);
        expect([child.stdin.length, isLive(child.child)]).toEqual([frames, true]);

        await answered(world);
        expect(expectRestart(world, records, before).mcp).toBe(EMPTY_MCP);

        const settled = processOf(world);
        await answered(world);
        expect(processOf(world)).toEqual(settled);
        expect(records).toHaveLength(settled.spawns);
        expect(world.errors).toEqual([]);
      } finally {
        await world.fixture.close();
      }
    },
  );

  it(
    "mcp.json 读取失败（目录，EISDIR）属第 1 步失败：502 agent_unavailable，受理对被补偿，存活进程不收帧不退出；复原后 202 且复用",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const mcpPath = join(ompAgentDir(world.rt.runtime.stateDir), "mcp.json");
      await answered(world);
      const child = spawnedAt(world, 0);
      const frames = child.stdin.length;
      const rows = snapshot(world.fixture.db, world.session, true);
      const before = processOf(world);
      mkdirSync(mcpPath);

      const response = await sendPrompt(world, "while mcp.json is unreadable");

      expect([response.statusCode, response.json()]).toEqual([502, AGENT_UNAVAILABLE_ENVELOPE]);
      await settle();
      expect(snapshot(world.fixture.db, world.session, true)).toEqual(rows);
      expect(processOf(world)).toEqual(before);
      expect([child.stdin.length, isLive(child.child)]).toEqual([frames, true]);

      rmdirSync(mcpPath);
      await answered(world);
      expect(processOf(world)).toEqual(before);
      expect(child.stdin.slice(frames).map((frame) => frame.type)).toContain("prompt");
      expect(world.errors).toEqual([]);
    },
  );
});
