/**
 * Issue #1648 (s1d-model-registry task 6.2, design D19): `reusable()` — chat-sessions「派发前按会话设置
 * 对齐进程」 step 1 as a pure decision. A live slot serves a dispatch only when it was started under the
 * effective mode AND its spawn-time model set holds the effective model; a model inside the set needs
 * no restart (step 2's `set_model` switches it).
 */
import { describe, expect, it } from "vitest";
import { reusable } from "../src/sessions/composer-align.js";

const live = { approvalMode: "write", modelIds: new Set(["m1", "m2"]) } as const;

describe("reusable (chat-sessions「派发前按会话设置对齐进程」step 1)", () => {
  it("same mode, effective model in the spawn-time set → reusable, whichever model of the set", () => {
    expect(reusable(live, { approvalMode: "write", modelId: "m1" })).toBe(true);
    expect(reusable(live, { approvalMode: "write", modelId: "m2" })).toBe(true);
  });

  it("another mode → not reusable, even with the model in the set", () => {
    expect(reusable(live, { approvalMode: "yolo", modelId: "m1" })).toBe(false);
    expect(reusable(live, { approvalMode: "always-ask", modelId: "m2" })).toBe(false);
  });

  it("effective model outside the spawn-time set → not reusable, even under the same mode", () => {
    expect(reusable(live, { approvalMode: "write", modelId: "m3" })).toBe(false);
    const empty = { ...live, modelIds: new Set<string>() };
    expect(reusable(empty, { approvalMode: "write", modelId: "m1" })).toBe(false);
  });
});
