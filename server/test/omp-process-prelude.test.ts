/**
 * Issue #1566 (omp-pin-18-12 task 2.2, design D3): omp-runtime「RPC IO and child observation」 at the
 * OmpProcess seam over synthetic frames — scenario「Prelude card is answered by the transport」 (the
 * two prelude titles are answered `Approve` at once and observed as `preludeApproval{id}`; the five
 * variants are cancelled) and the two shapes scenario「Approval request is surfaced, not
 * cancelled」 adds (the three-item session-grant options, with the tool name or a policy key in the
 * middle item). Frames and expected answers are literals from those scenarios; the oracle is the
 * stdin record of the fake child and the owner's observations.
 */
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { OmpProcess } from "../src/sessions/omp/process.js";
import type { ApprovalRequest } from "../src/sessions/omp/ui-requests.js";
import { createRpcHarness, type FakeChild, startFakeProcess } from "./support/omp-rpc.js";

const TOKEN = "wb-issue1566-secret-token";
const QUIET_MS = 300;
const TWO = ["Approve", "Deny"];
const BASH = "Allow tool: bash\nCommand: echo workbuddy-smoke";
const harness = createRpcHarness();

interface Run {
  child: FakeChild;
  proc: OmpProcess;
  written: OmpFrame[];
  approvals: ApprovalRequest[];
  preludes: unknown[];
  errors: unknown[];
}

async function startRun(): Promise<Run> {
  const { child, proc, errors } = await startFakeProcess(harness, TOKEN, {
    prefix: "omp-prelude-",
  });
  const written: OmpFrame[] = [];
  child.stdin.on("data", (chunk: Buffer | string) => {
    for (const line of chunk
      .toString()
      .split("\n")
      .filter((part) => part.trim().length > 0)) {
      written.push(JSON.parse(line) as OmpFrame);
    }
  });
  const approvals: ApprovalRequest[] = [];
  const preludes: unknown[] = [];
  proc.on("approval", (request) => approvals.push(request));
  proc.on("preludeApproval", (payload) => preludes.push(payload));
  return { child, proc, written, approvals, preludes, errors };
}

function select(id: string, title: string, options: unknown): OmpFrame {
  return { type: "extension_ui_request", id, method: "select", title, options };
}

function uiAnswers(written: OmpFrame[]): OmpFrame[] {
  return written.filter((frame) => frame.type === "extension_ui_response");
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
}

describe("omp-runtime「Prelude card is answered by the transport」", () => {
  it("both prelude titles get Approve at once and a preludeApproval observation, no approval request", async () => {
    const run = await startRun();
    run.child.emitLine(select("p1", "Allow tool: browser", TWO));
    run.child.emitLine(select("p2", "Allow tool: browser\nReason: target not yet approved", TWO));
    await settle();

    expect(uiAnswers(run.written)).toEqual([
      { type: "extension_ui_response", id: "p1", value: "Approve" },
      { type: "extension_ui_response", id: "p2", value: "Approve" },
    ]);
    expect(run.preludes).toEqual([{ id: "p1" }, { id: "p2" }]);
    expect(run.approvals).toEqual([]);
    expect(run.errors).toEqual([]);
  });

  it("a prelude card is not an outstanding approval: respondApproval for its id writes nothing", async () => {
    const run = await startRun();
    run.child.emitLine(select("p1", "Allow tool: browser", TWO));
    await settle();
    run.proc.respondApproval("p1", "deny");
    await settle();

    expect(uiAnswers(run.written)).toEqual([
      { type: "extension_ui_response", id: "p1", value: "Approve" },
    ]);
  });

  it("the five variants are cancelled, not approved, not surfaced and not observed as prelude", async () => {
    const run = await startRun();
    const variants: OmpFrame[] = [
      select("v1", "Allow tool: browser", ["Approve", "Approve browser for this session", "Deny"]),
      { type: "extension_ui_request", id: "v2", method: "confirm", title: "Allow tool: browser" },
      select("v3", "Allow tool: browser\nAction: open\nTab: main\nURL: https://example.com", TWO),
      select("v4", "Allow tool: browser\nReason: a\nb", TWO),
      select("v5", "Allow tool: browser ", TWO),
    ];
    for (const variant of variants) {
      run.child.emitLine(variant);
    }
    await settle();

    expect(uiAnswers(run.written)).toEqual(
      variants.map((variant) => ({
        type: "extension_ui_response",
        id: variant.id,
        cancelled: true,
      })),
    );
    expect(run.approvals).toEqual([]);
    expect(run.preludes).toEqual([]);
    expect(run.errors).toEqual([]);
  });
});

describe("omp-runtime「Approval request is surfaced, not cancelled」: the three-item shapes", () => {
  it.each([
    ["the tool name", ["Approve", "Approve bash for this session", "Deny"]],
    ["a policy key", ["Approve", "Approve shell:ls for this session", "Deny"]],
    ["the two-item shape (control)", TWO],
  ])(
    "options naming %s in the middle are surfaced with tool bash and the original title",
    async (_label, options) => {
      const run = await startRun();
      run.child.emitLine(select("r1", BASH, options));
      await settle();

      expect(run.approvals).toEqual([{ id: "r1", tool: "bash", title: BASH }]);
      expect(uiAnswers(run.written)).toEqual([]);
      expect(run.preludes).toEqual([]);

      run.proc.respondApproval("r1", "allow");
      await settle();
      expect(uiAnswers(run.written)).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
    },
  );
});
