/**
 * Change kb-search-approval-scope D2 (#2011): `CommandRefusedError`, the error `runtime.command`
 * throws for a `success:false` answer. `refusedWith` matches omp's `error` exactly (omp-runtime
 * 「`kb_search` 的注册」: a prefix or a suffix is not the conflict); the text stays out of `message`,
 * the own enumerable properties and the inspected form. The conflict text is v18.12.3's, record §2.10.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentUnavailableError } from "../src/sessions/omp/process.js";
import { CommandRefusedError } from "../src/sessions/omp/runtime.js";

const CONFLICT = 'RPC host tool "kb_search" conflicts with an existing tool';

describe("CommandRefusedError.refusedWith", () => {
  it("is true only for exactly the same string", () => {
    expect(new CommandRefusedError("set_host_tools", CONFLICT).refusedWith(CONFLICT)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["a prefix", `x${CONFLICT}`],
    ["a suffix", `${CONFLICT}.`],
    ["another tool name", 'RPC host tool "kb_search_extra" conflicts with an existing tool'],
    ["a trailing space", `${CONFLICT} `],
    ["no error field", undefined],
    ["a non-string error", { message: CONFLICT }],
    ["an array error", [CONFLICT]],
  ])("is false for %s", (_label, ompError) => {
    expect(new CommandRefusedError("set_host_tools", ompError).refusedWith(CONFLICT)).toBe(false);
  });

  it("is an AgentUnavailableError whose message, own properties and inspection omit omp's text", () => {
    const error = new CommandRefusedError("set_host_tools", CONFLICT);

    expect(error).toBeInstanceOf(AgentUnavailableError);
    expect(error.message).toBe("set_host_tools failed");
    expect(error.code).toBe("agent_unavailable");
    expect(JSON.stringify(error)).not.toContain("conflicts");
    expect(inspect(error, { depth: 5, showHidden: true })).not.toContain("conflicts");
  });
});
