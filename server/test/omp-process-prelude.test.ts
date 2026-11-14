/**
 * Issue #1566 (omp-pin-18-12 task 2.2, design D3): omp-runtime「RPC IO and child observation」 at the
 * OmpProcess seam over synthetic frames — scenario「Prelude card is answered by the transport」 (the
 * two prelude titles are answered `Approve` at once and observed as `preludeApproval{id}`; the five
 * variants are cancelled) and the two shapes scenario「Approval request is surfaced, not
 * cancelled」 adds (the three-item session-grant options, with the tool name or a policy key in the
 * middle item). Frames and expected answers are literals from those scenarios; the oracle is the
 * stdin record of the fake child and the owner's observations.
 *
 * Change s2c-kb-session 3.6 (#1965): scenario「kb_search card by approval mode」 and the positive and
 * negative cases of tasks.md「组 3 第二刀约定」 over the same synthetic frames (id `k1`): under
 * `write` / `yolo` the exact `Allow tool: kb_search` select is answered `Approve` by the transport
 * and never registered; under `always-ask` it is an approval; near-miss titles stay approvals and
 * non-closed shapes stay cancelled. `yolo` is only reachable here (the fake omp sends no select).
 *
 * Change kb-search-approval-scope D1 (#2011): the pass-through needs this process to have registered
 * `kb_search` — the last successful answer to a `set_host_tools` the host itself sent lists it.
 * Scenario「kb_search card without host registration」 and tool-approval「这一代没有注册时不放行」
 * 「撤下后再注册恢复放行」: never registered, withdrawn (`[]`), `success:false`, re-registered, and a
 * `response` frame whose id matches no host request. The pass-through cases register first.
 */
import { describe, expect, it } from "vitest";
import type { ApprovalMode } from "../src/model-catalog.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { OmpProcess } from "../src/sessions/omp/process.js";
import type { ApprovalRequest } from "../src/sessions/omp/ui-requests.js";
import { createRpcHarness, type FakeChild, startFakeProcess } from "./support/omp-rpc.js";

const TOKEN = "wb-issue1566-secret-token";
const QUIET_MS = 300;
const TWO = ["Approve", "Deny"];
const BASH = "Allow tool: bash\nCommand: echo workbuddy-smoke";
const KB = "Allow tool: kb_search";
const KB_THREE = ["Approve", "Approve kb_search for this session", "Deny"];
const harness = createRpcHarness();

interface Run {
  child: FakeChild;
  proc: OmpProcess;
  written: OmpFrame[];
  approvals: ApprovalRequest[];
  preludes: unknown[];
  errors: unknown[];
}

async function startRun(approvalMode?: ApprovalMode): Promise<Run> {
  const { child, proc, errors } = await startFakeProcess(harness, TOKEN, {
    prefix: "omp-prelude-",
    ...(approvalMode === undefined ? {} : { approvalMode }),
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

/**
 * One host `set_host_tools` on the process, answered by the child with `success` and `toolNames`
 * (a refusal carries `error`, and with `refusedWithData` also `data.toolNames`); resolves with the
 * response frame the request resolved to.
 */
async function register(
  run: Run,
  toolNames: string[],
  success = true,
  refusedWithData = false,
): Promise<OmpFrame> {
  const sent = run.written.length;
  const reply = run.proc.request({ type: "set_host_tools", tools: [] });
  await settle();
  const request = run.written.slice(sent).find((frame) => frame.type === "set_host_tools");
  run.child.emitLine({
    id: request?.id,
    type: "response",
    command: "set_host_tools",
    success,
    ...(success || refusedWithData ? { data: { toolNames } } : {}),
    ...(success ? {} : { error: "host tools rejected" }),
  });
  return reply;
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

describe("omp-runtime「kb_search card by approval mode」", () => {
  const OUTSIDE_ALWAYS_ASK: ApprovalMode[] = ["write", "yolo"];

  it.each(
    OUTSIDE_ALWAYS_ASK.flatMap((mode) => [
      [mode, "three-item", KB_THREE],
      [mode, "two-item", TWO],
    ]),
  )(
    "%s: the exact %s kb_search select is answered Approve at once, never registered",
    async (mode, _label, options) => {
      const run = await startRun(mode as ApprovalMode);
      await register(run, ["kb_search"]);
      run.child.emitLine(select("k1", KB, options));
      await settle();

      expect(uiAnswers(run.written)).toEqual([
        { type: "extension_ui_response", id: "k1", value: "Approve" },
      ]);
      expect(run.approvals).toEqual([]);
      expect(run.preludes).toEqual([]);
      run.proc.respondApproval("k1", "deny");
      await settle();
      expect(uiAnswers(run.written)).toHaveLength(1);
      expect(run.errors).toEqual([]);
    },
  );

  it("always-ask: the same select is surfaced with tool kb_search and answered only by the owner", async () => {
    const run = await startRun("always-ask");
    run.child.emitLine(select("k1", KB, KB_THREE));
    await settle();

    expect(run.approvals).toEqual([{ id: "k1", tool: "kb_search", title: KB }]);
    expect(uiAnswers(run.written)).toEqual([]);
    expect(run.preludes).toEqual([]);
    run.proc.respondApproval("k1", "allow");
    await settle();
    expect(uiAnswers(run.written)).toEqual([
      { type: "extension_ui_response", id: "k1", value: "Approve" },
    ]);
    expect(run.errors).toEqual([]);
  });

  it.each(OUTSIDE_ALWAYS_ASK)(
    "%s: near-miss titles are ordinary approvals, not answered by the transport",
    async (mode) => {
      const run = await startRun(mode);
      await register(run, ["kb_search"]);
      run.child.emitLine(select("n1", `${KB}\nReason: x`, KB_THREE));
      run.child.emitLine(select("n2", `${KB}_extra`, KB_THREE));
      run.child.emitLine(select("n3", `${KB} `, KB_THREE));
      await settle();

      expect(run.approvals).toEqual([
        { id: "n1", tool: "kb_search", title: `${KB}\nReason: x` },
        { id: "n2", tool: "kb_search_extra", title: `${KB}_extra` },
        { id: "n3", tool: "kb_search", title: `${KB} ` },
      ]);
      expect(uiAnswers(run.written)).toEqual([]);
      expect(run.preludes).toEqual([]);
    },
  );

  it.each(OUTSIDE_ALWAYS_ASK)(
    "%s: the exact title with non-closed options or as confirm is cancelled",
    async (mode) => {
      const run = await startRun(mode);
      await register(run, ["kb_search"]);
      run.child.emitLine(select("x1", KB, ["Approve", "Approve kb_search", "Deny"]));
      run.child.emitLine({ type: "extension_ui_request", id: "x2", method: "confirm", title: KB });
      await settle();

      expect(uiAnswers(run.written)).toEqual([
        { type: "extension_ui_response", id: "x1", cancelled: true },
        { type: "extension_ui_response", id: "x2", cancelled: true },
      ]);
      expect(run.approvals).toEqual([]);
      expect(run.preludes).toEqual([]);
    },
  );
});

describe("omp-runtime「kb_search card without host registration」 (#2011 D1)", () => {
  const KB_SURFACED = { id: "k1", tool: "kb_search", title: KB };

  /** The card is surfaced to the owner with its title and gets no answer from the transport. */
  function expectSurfaced(run: Run): void {
    expect(run.approvals).toEqual([KB_SURFACED]);
    expect(uiAnswers(run.written)).toEqual([]);
    expect(run.preludes).toEqual([]);
    expect(run.errors).toEqual([]);
  }

  it("write, never registered: the exact kb_search select is an approval with tool kb_search", async () => {
    const run = await startRun("write");
    run.child.emitLine(select("k1", KB, KB_THREE));
    await settle();

    expectSurfaced(run);
  });

  it("write, registered then withdrawn with toolNames []: the select is an approval again", async () => {
    const run = await startRun("write");
    await register(run, ["kb_search"]);
    await register(run, []);
    run.child.emitLine(select("k1", KB, KB_THREE));
    await settle();

    expectSurfaced(run);
  });

  it("write, a success:false answer as the only one: the select is an approval", async () => {
    const run = await startRun("write");
    await expect(register(run, ["kb_search"], false)).resolves.toMatchObject({ success: false });
    run.child.emitLine(select("k1", KB, KB_THREE));
    await settle();

    expectSurfaced(run);
  });

  it("write, a success:false answer after a registration leaves it registered: Approve", async () => {
    const run = await startRun("write");
    await register(run, ["kb_search"]);
    await register(run, ["kb_search"], false);
    run.child.emitLine(select("k1", KB, KB_THREE));
    await settle();

    expect(uiAnswers(run.written)).toEqual([
      { type: "extension_ui_response", id: "k1", value: "Approve" },
    ]);
    expect(run.approvals).toEqual([]);
  });

  it("write, success:false carrying data.toolNames [kb_search] as the only answer: still an approval", async () => {
    const run = await startRun("write");
    await expect(register(run, ["kb_search"], false, true)).resolves.toMatchObject({
      success: false,
      data: { toolNames: ["kb_search"] },
    });
    run.child.emitLine(select("k1", KB, KB_THREE));
    await settle();

    expectSurfaced(run);
  });

  it("write, success:false carrying data.toolNames [] after a registration: still Approve", async () => {
    const run = await startRun("write");
    await register(run, ["kb_search"]);
    await register(run, [], false, true);
    run.child.emitLine(select("k1", KB, KB_THREE));
    await settle();

    expect(uiAnswers(run.written)).toEqual([
      { type: "extension_ui_response", id: "k1", value: "Approve" },
    ]);
    expect(run.approvals).toEqual([]);
  });

  it("write, withdrawn then registered again: the select is answered Approve at once", async () => {
    const run = await startRun("write");
    await register(run, ["kb_search"]);
    await register(run, []);
    await register(run, ["kb_search"]);
    run.child.emitLine(select("k1", KB, KB_THREE));
    await settle();

    expect(uiAnswers(run.written)).toEqual([
      { type: "extension_ui_response", id: "k1", value: "Approve" },
    ]);
    expect(run.approvals).toEqual([]);
  });

  it("write, an unsolicited set_host_tools success whose id matches no host request changes nothing", async () => {
    const run = await startRun("write");
    run.child.emitLine({
      id: "omp-own-1",
      type: "response",
      command: "set_host_tools",
      success: true,
      data: { toolNames: ["kb_search"] },
    });
    await settle();
    run.child.emitLine(select("k1", KB, KB_THREE));
    await settle();

    expectSurfaced(run);
  });

  it("write, a set_host_tools response matching a pending request of another command changes nothing", async () => {
    const run = await startRun("write");
    const sent = run.written.length;
    const pending = run.proc.request({ type: "get_state" });
    await settle();
    const request = run.written.slice(sent).find((frame) => frame.type === "get_state");
    run.child.emitLine({
      id: request?.id,
      type: "response",
      command: "set_host_tools",
      success: true,
      data: { toolNames: ["kb_search"] },
    });
    run.child.emitLine(select("k1", KB, KB_THREE));
    await settle();

    expectSurfaced(run);
    run.child.emitLine({ id: request?.id, type: "response", command: "get_state", success: true });
    await expect(pending).resolves.toMatchObject({ command: "get_state" });
  });
});
