/**
 * Issue #515 file-change candidate extraction at countDiffLines/fileChangeCandidates: omp numbered
 * diff counting, perFileResults precedence, failure and prototype-key rejection. Expected values
 * are fixture literals from the turn-artifacts spec, not production logic.
 */
import { describe, expect, it } from "vitest";
import { countDiffLines, fileChangeCandidates } from "../src/sessions/file-changes.js";

const APP_DIFF = "+3|a\n+4|b\n-3|x\n 2|ctx";
const APP_PATH = "/ws/src/app.ts";

function ok(details: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: "ok" }], details };
}

describe("countDiffLines (omp numbered diff)", () => {
  it.each([
    ["added and removed numbered lines", APP_DIFF, 2, 1],
    ["context line only", " 2|ctx", 0, 0],
    ["unnumbered, doubled and empty-number prefixes", "+x\n-x\n++1|a\n+|x\n-|y\n--2|z", 0, 0],
    ["CRLF line endings", "+1|a\r\n-2|b\r\n", 1, 1],
    ["empty diff", "", 0, 0],
    ["removed line alone", "-12|gone", 0, 1],
    ["marker only at line start", "a +1|x\n\t-2|y", 0, 0],
  ])("%s", (_name, diff, added, removed) => {
    expect(countDiffLines(diff)).toEqual({ added, removed });
  });
});

describe("fileChangeCandidates: edit", () => {
  it("top-level path and diff yield one candidate", () => {
    expect(fileChangeCandidates("edit", ok({ diff: APP_DIFF, path: APP_PATH }))).toEqual([
      { path: APP_PATH, added: 2, removed: 1, kind: "edit" },
    ]);
  });

  it("nonempty perFileResults win over top-level, skipping invalid items in order", () => {
    const perFileResults = [
      { diff: "-1|old\n+1|new\n+2|more", path: "z.md" },
      "not-an-object",
      { diff: "+1|y", path: "" },
      null,
      ["y.md", "+1|q"],
      { diff: 7, path: "x.md" },
      { diff: "", path: "w.md" },
    ];
    const details = { perFileResults, path: "top.md", diff: "+1|top" };
    expect(fileChangeCandidates("edit", ok(details))).toEqual([
      { path: "z.md", added: 2, removed: 1, kind: "edit" },
      { path: "w.md", added: 0, removed: 0, kind: "edit" },
    ]);
  });

  it("nonempty perFileResults with no valid item do not fall back to top-level", () => {
    const details = { path: "top.md", diff: "+1|top", perFileResults: [{ path: "", diff: "" }] };
    expect(fileChangeCandidates("edit", ok(details))).toEqual([]);
  });

  it("empty perFileResults fall back to top-level", () => {
    const details = { path: "top.md", diff: "+1|t\n+2|u", perFileResults: [] };
    expect(fileChangeCandidates("edit", ok(details))).toEqual([
      { path: "top.md", added: 2, removed: 0, kind: "edit" },
    ]);
  });

  it.each([
    ["empty path", { path: "", diff: "+1|x" }],
    ["missing diff", { path: "a.md" }],
    ["non-string diff", { path: "a.md", diff: ["+1|x"] }],
    ["non-string path", { path: 1, diff: "+1|x" }],
  ])("%s yields nothing", (_name, details) => {
    expect(fileChangeCandidates("edit", ok(details))).toEqual([]);
  });
});

describe("fileChangeCandidates: write", () => {
  it("resolvedPath yields a write candidate with null counts", () => {
    expect(fileChangeCandidates("write", ok({ resolvedPath: "/ws/out/index.html" }))).toEqual([
      { path: "/ws/out/index.html", added: null, removed: null, kind: "write" },
    ]);
  });

  it.each([
    ["missing resolvedPath", {}],
    ["empty resolvedPath", { resolvedPath: "" }],
    ["non-string resolvedPath", { resolvedPath: 3 }],
    ["edit-shaped details", { path: "a.md", diff: "+1|x" }],
  ])("%s yields nothing", (_name, details) => {
    expect(fileChangeCandidates("write", ok(details))).toEqual([]);
  });
});

describe("fileChangeCandidates: rejected results", () => {
  it("result.isError true yields nothing for edit and write", () => {
    expect(
      fileChangeCandidates("edit", { isError: true, details: { path: "a.md", diff: "+1|x" } }),
    ).toEqual([]);
    expect(
      fileChangeCandidates("write", { isError: true, details: { resolvedPath: "/a" } }),
    ).toEqual([]);
  });

  it.each([
    ["array details", [{ path: "a.md", diff: "+1|x" }]],
    ["string details", "a.md"],
    ["null details", null],
    ["missing details", undefined],
  ])("%s yields nothing", (_name, details) => {
    const result = details === undefined ? { content: [] } : { details };
    expect(fileChangeCandidates("edit", result)).toEqual([]);
    expect(fileChangeCandidates("write", result)).toEqual([]);
  });

  it.each([
    ["null result", null],
    ["undefined result", undefined],
    ["string result", "done"],
    ["array result", [{ details: { path: "a.md", diff: "+1|x" } }]],
  ])("%s yields nothing", (_name, result) => {
    expect(fileChangeCandidates("edit", result)).toEqual([]);
  });

  it.each([
    ["ast_edit", { path: "a.ts", diff: "+1|x", totalReplacements: 1 }],
    ["read", { resolvedPath: "/ws/a.md" }],
    ["bash", { exitCode: 0, path: "a.md", diff: "+1|x" }],
    ["memory_edit", { path: "a.md", diff: "+1|x", resolvedPath: "/ws/a.md" }],
  ])("tool %s never yields candidates", (toolName, details) => {
    expect(fileChangeCandidates(toolName, ok(details))).toEqual([]);
  });
});

describe("fileChangeCandidates: prototype keys are not read", () => {
  it("prototype isError on result does not block own details", () => {
    const result = Object.create({ isError: true }) as Record<string, unknown>;
    result.details = { path: "a.md", diff: "+1|x" };
    expect(fileChangeCandidates("edit", result)).toEqual([
      { path: "a.md", added: 1, removed: 0, kind: "edit" },
    ]);
  });

  it("prototype details on result yield nothing", () => {
    const result = Object.create({ details: { path: "a.md", diff: "+1|x" } });
    expect(fileChangeCandidates("edit", result)).toEqual([]);
    const writeResult = Object.create({ details: { resolvedPath: "/ws/a.md" } });
    expect(fileChangeCandidates("write", writeResult)).toEqual([]);
  });

  it.each([
    ["path and diff", Object.create({ path: "p.md", diff: "+1|x" })],
    ["diff only", Object.assign(Object.create({ diff: "+1|x" }), { path: "p.md" })],
    ["path only", Object.assign(Object.create({ path: "p.md" }), { diff: "+1|x" })],
    ["perFileResults", Object.create({ perFileResults: [{ path: "p.md", diff: "+1|x" }] })],
  ])("edit details with prototype-only %s yield nothing", (_name, details) => {
    expect(fileChangeCandidates("edit", { details })).toEqual([]);
  });

  it("write details with prototype-only resolvedPath yield nothing", () => {
    const details = Object.create({ resolvedPath: "/ws/a.md" });
    expect(fileChangeCandidates("write", { details })).toEqual([]);
  });

  it("prototype-only perFileResults item is skipped", () => {
    const inherited = Object.create({ path: "p.md", diff: "+1|x" });
    const details = { perFileResults: [inherited, { path: "q.md", diff: "-1|y" }] };
    expect(fileChangeCandidates("edit", { details })).toEqual([
      { path: "q.md", added: 0, removed: 1, kind: "edit" },
    ]);
  });

  it("holes in perFileResults are skipped", () => {
    const perFileResults: unknown[] = [];
    perFileResults[1] = { path: "q.md", diff: "+1|y" };
    expect(fileChangeCandidates("edit", { details: { perFileResults } })).toEqual([
      { path: "q.md", added: 1, removed: 0, kind: "edit" },
    ]);
  });

  it("prototype perFileResults fall back to own top-level path and diff", () => {
    const details = Object.assign(
      Object.create({ perFileResults: [{ path: "p.md", diff: "+1|x" }] }),
      { path: "top.md", diff: "+1|t\n-1|u" },
    );
    expect(fileChangeCandidates("edit", { details })).toEqual([
      { path: "top.md", added: 1, removed: 1, kind: "edit" },
    ]);
  });
});
