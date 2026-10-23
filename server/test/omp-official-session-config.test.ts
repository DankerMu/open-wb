/**
 * s1d-experts-skills group 1 (issue #1656): the session config file against the official omp binary
 * — skill-switches scenario「停用的技能不进系统提示词」and the omp premises of omp-runtime「会话配置
 * 文件」(design Risks「第二个 `--config` 在 18.12.3 上的叠加」「观察面」): a second `--config` overlays
 * the host overlay, `skill:<name>` in its `disabledExtensions` drops that skill, the session yml's
 * list replaces the project layer's `disabledExtensions` as a whole, and `--append-system-prompt`
 * reads the `.md` file (a path omp failed to read would be injected literally, without the sentinel).
 *
 * The world is support/omp-official-proxied.ts (model proxy → fake upstream; the fake upstream does
 * not record message bodies). The oracle is omp's own RPC `get_state.systemPrompt` after one turn
 * (precedent: omp-official-overlay-pins.test.ts `readState`). omp lists skills in the system prompt
 * only when its tools include `read` (the default set does) and the SKILL.md has no `hide: true`.
 *
 * Run locally (`OMP_BIN` absolute):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-session-config.test.ts --coverage=false
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import { openProxiedWorld, type ProxiedWorld } from "./support/omp-official-proxied.js";
import { collectPrompt } from "./support/omp-runtime.js";

const TURN = { timeout: 90_000 };
const ALPHA = "ALPHA-SKILL-SENTINEL-1656";
const BETA = "BETA-SKILL-SENTINEL-1656";
const EXPERT = "EXPERT-SENTINEL-1";
/** A prompt with a newline and CJK text: the file's bytes, not its path, reach the system prompt. */
const EXPERT_PROMPT = `你是一位测试工程师（${EXPERT}）。\n先写用例，再改代码。`;

function writeSkill(skillsDir: string, name: string, description: string): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(
    join(skillsDir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${name} 的正文\n`,
  );
}

/** The two platform skills, installed before the first prompt spawns the child. */
function installSkills(world: ProxiedWorld): void {
  writeSkill(join(world.agentDir, "skills"), "alpha", ALPHA);
  writeSkill(join(world.agentDir, "skills"), "beta", BETA);
}

async function systemPromptAfterTurn(runtime: SessionRuntime): Promise<string> {
  await collectPrompt(runtime.prompt("你好"));
  const state = (await runtime.command({ type: "get_state" })) as unknown as {
    systemPrompt: string[];
  };
  return state.systemPrompt.join("\n");
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: session config file`, () => {
  it(
    "drops skill:alpha through the second --config and appends the expert prompt read from the .md",
    TURN,
    async () => {
      const world = await openProxiedWorld({
        capabilities: { disabledExtensions: ["skill:alpha"], appendSystemPrompt: EXPERT_PROMPT },
      });
      installSkills(world);

      const prompt = await systemPromptAfterTurn(world.runtime);

      expect(prompt).toContain(BETA);
      expect(prompt).not.toContain(ALPHA);
      expect(prompt).toContain(EXPERT_PROMPT);
      expect(prompt).not.toContain("session-config");
    },
  );

  it(
    "with no expert and nothing disabled lists both skills: the session list replaces the project layer's",
    TURN,
    async () => {
      const world = await openProxiedWorld();
      installSkills(world);
      mkdirSync(join(world.workspaceRoot, ".omp"), { recursive: true });
      writeFileSync(
        join(world.workspaceRoot, ".omp", "config.yml"),
        'disabledExtensions: ["skill:beta"]\n',
      );

      const prompt = await systemPromptAfterTurn(world.runtime);

      expect(prompt).toContain(ALPHA);
      expect(prompt).toContain(BETA);
      expect(prompt).not.toContain(EXPERT);
    },
  );
});
