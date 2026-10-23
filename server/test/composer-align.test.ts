/**
 * Issue #1648 (s1d-model-registry task 6.2, design D19) and #1660 (s1d-experts-skills task 6.2,
 * design D1/D8): chat-sessions「派发前按会话设置对齐进程」 step 1 as a pure decision. A live slot serves
 * a dispatch only when it was started under the effective mode, its spawn-time model set holds the
 * effective model AND its capability fingerprint is the effective capabilities' one; a model inside
 * the set needs no restart (step 2's `set_model` switches it).
 *
 * The capability side: a session's effective capabilities (experts「专家提示词注入」: the expert's
 * prompt only while its owner can see it; every disabled skill prefixed `skill:`) and their
 * fingerprint, the SHA-256 of the two session config files' content (`<key>` not in it). Expected
 * values are spec literals and the bytes `writeSessionConfig` puts on disk, read back.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { effectiveCapabilities, reusable } from "../src/sessions/composer-align.js";
import {
  type SessionCapabilities,
  sessionConfigContent,
  sessionConfigFingerprint,
  writeSessionConfig,
} from "../src/sessions/omp/session-config.js";
import { ensureOmpStateLayout } from "../src/sessions/omp/state-layout.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const NONE: SessionCapabilities = { disabledExtensions: [], appendSystemPrompt: null };
const EXPERT: SessionCapabilities = { disabledExtensions: [], appendSystemPrompt: "P" };
const FP = sessionConfigFingerprint(NONE);
const live = { approvalMode: "write", modelIds: new Set(["m1", "m2"]), fingerprint: FP } as const;

describe("reusable (chat-sessions「派发前按会话设置对齐进程」step 1)", () => {
  it("same mode, effective model in the spawn-time set → reusable, whichever model of the set", () => {
    expect(reusable(live, { approvalMode: "write", modelId: "m1", fingerprint: FP })).toBe(true);
    expect(reusable(live, { approvalMode: "write", modelId: "m2", fingerprint: FP })).toBe(true);
  });

  it("another mode → not reusable, even with the model in the set", () => {
    expect(reusable(live, { approvalMode: "yolo", modelId: "m1", fingerprint: FP })).toBe(false);
    expect(reusable(live, { approvalMode: "always-ask", modelId: "m2", fingerprint: FP })).toBe(
      false,
    );
  });

  it("effective model outside the spawn-time set → not reusable, even under the same mode", () => {
    expect(reusable(live, { approvalMode: "write", modelId: "m3", fingerprint: FP })).toBe(false);
    const empty = { ...live, modelIds: new Set<string>() };
    expect(reusable(empty, { approvalMode: "write", modelId: "m1", fingerprint: FP })).toBe(false);
  });

  it("another capability fingerprint → not reusable, even with the same mode and model", () => {
    const other = sessionConfigFingerprint(EXPERT);
    expect(reusable(live, { approvalMode: "write", modelId: "m1", fingerprint: other })).toBe(
      false,
    );
  });
});

describe("sessionConfigFingerprint (omp-runtime「会话配置文件」, design D1/D8)", () => {
  it("is a SHA-256 hex digest, the same for the same capabilities however the list is given", () => {
    expect(FP).toMatch(/^[0-9a-f]{64}$/u);
    expect(sessionConfigFingerprint(NONE)).toBe(FP);
    const listed = (disabledExtensions: string[]) =>
      sessionConfigFingerprint({ disabledExtensions, appendSystemPrompt: "P" });
    // The file holds the list deduplicated and sorted: these are one file, one fingerprint.
    expect(listed(["skill:b", "skill:a", "skill:a"])).toBe(listed(["skill:a", "skill:b"]));
  });

  it("with and without an expert differ; so do another prompt and another disabled list", () => {
    const all = [
      NONE,
      EXPERT,
      { disabledExtensions: [], appendSystemPrompt: "P2" },
      { disabledExtensions: ["skill:deploy"], appendSystemPrompt: "P" },
      { disabledExtensions: ["skill:deploy"], appendSystemPrompt: null },
      // A prompt that spells what the no-expert case could be mistaken for.
      { disabledExtensions: [], appendSystemPrompt: "null" },
      { disabledExtensions: [], appendSystemPrompt: "" },
    ].map(sessionConfigFingerprint);
    expect(new Set(all).size).toBe(all.length);
  });

  it("is the digest of the two files the spawn writes, in order .yml then .md; the key is not in it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "composer-align-")));
    roots.push(root);
    const state = join(root, "state");
    ensureOmpStateLayout(state);
    for (const capabilities of [NONE, EXPERT, { ...EXPERT, disabledExtensions: ["skill:x"] }]) {
      const first = await writeSessionConfig(state, capabilities);
      const second = await writeSessionConfig(state, capabilities);
      expect(second.key).not.toBe(first.key);
      const dir = join(state, "session-config");
      const yml = readFileSync(join(dir, `${first.key}.yml`), "utf8");
      const mdPath = join(dir, `${first.key}.md`);
      const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : null;
      // Write and compare share one content function.
      expect(sessionConfigContent(capabilities)).toEqual({ yml, md });
      expect(sessionConfigFingerprint(capabilities)).toBe(
        createHash("sha256")
          .update(JSON.stringify([yml, md]))
          .digest("hex"),
      );
      first.remove();
      second.remove();
    }
  });

  it("content is the spec's: one disabledExtensions line, the prompt verbatim or no .md", () => {
    expect(
      sessionConfigContent({ disabledExtensions: ["skill:deploy"], appendSystemPrompt: "你好\n" }),
    ).toEqual({ yml: 'disabledExtensions: ["skill:deploy"]\n', md: "你好\n" });
    expect(sessionConfigContent(NONE)).toEqual({ yml: "disabledExtensions: []\n", md: null });
  });
});

describe("effectiveCapabilities (experts「专家提示词注入」, chat-sessions step 1)", () => {
  const prompts: Record<string, string> = { "u1/e1": "E1 的提示词" };
  const lookups: string[] = [];
  const expertPrompt = (ownerId: string, expertId: string): string | null => {
    lookups.push(`${ownerId}/${expertId}`);
    return prompts[`${ownerId}/${expertId}`] ?? null;
  };

  it("a visible expert's prompt and every disabled skill prefixed skill:", () => {
    lookups.length = 0;
    expect(
      effectiveCapabilities(expertPrompt)({
        ownerId: "u1",
        capabilities: { expertId: "e1", disabledSkills: ["deploy", "lint"] },
      }),
    ).toEqual({
      appendSystemPrompt: "E1 的提示词",
      disabledExtensions: ["skill:deploy", "skill:lint"],
    });
    expect(lookups).toEqual(["u1/e1"]);
  });

  it("no expert, or one the owner cannot see → no prompt; no expert asks nothing", () => {
    lookups.length = 0;
    const none = { expertId: null, disabledSkills: [] };
    expect(effectiveCapabilities(expertPrompt)({ ownerId: "u1", capabilities: none })).toEqual(
      NONE,
    );
    expect(lookups).toEqual([]);
    const foreign = { expertId: "e1", disabledSkills: [] };
    expect(effectiveCapabilities(expertPrompt)({ ownerId: "u2", capabilities: foreign })).toEqual(
      NONE,
    );
    expect(lookups).toEqual(["u2/e1"]);
  });
});
