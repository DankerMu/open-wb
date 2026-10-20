// CI job browser-image, step 4 (browser-runtime「CI browser-image job」, scenario「真实浏览器打开工作空间页面
// 并截图」; change omp-browser-integration design D8, omp-pin-18-12 D9: each turn is one `eval` call). Driven by
// .github/scripts/ci-browser-image.sh against the reference image's service on the loopback: usage
// `node ci-browser-e2e.mjs <base-url> <forward-port>`.
// The controlled upstream runs in process with the per-turn tool-round scope (the screenshot turn's history
// already holds a `tool` message); in front of it a forwarder on <forward-port> notes whether each request
// body carries an `image_url` part and passes the bytes on (the upstream's own request log keeps no content).
// Neither cookies nor request headers are ever printed.
import { request as httpRequest, createServer } from "node:http";
import { start } from "../../server/test/support/fake-upstream.mjs";

const [base, forwardPortArg] = process.argv.slice(2);
const forwardPort = Number(forwardPortArg);
const TURN_MS = 180_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PAGE = '<!doctype html><meta charset="utf-8"><title>browser-ci</title><h1>WorkBuddy browser CI</h1>\n';

class Failure extends Error {}
const check = (ok, message, detail) => {
  if (!ok) throw new Failure(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
};
const firstLine = (text) => String(text).split("\n", 1)[0];
const log = (message) => process.stdout.write(`browser-e2e: ${message}\n`);

/** `{at, image}` per chat request seen by the forwarder, in arrival order. */
const seen = [];
function carriesImage(body) {
  try {
    const messages = JSON.parse(body.toString("utf8")).messages;
    return (
      Array.isArray(messages) &&
      messages.some(
        (m) => Array.isArray(m?.content) && m.content.some((part) => part?.type === "image_url"),
      )
    );
  } catch {
    return false;
  }
}

function forwarder(upstreamPort) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ at: Date.now(), image: carriesImage(body) });
      const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
      const out = httpRequest(
        { host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      out.on("error", () => res.destroy());
      out.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(forwardPort, "127.0.0.1", () => resolve(server));
  });
}

let cookie = "";
async function call(method, path, body, raw) {
  const headers = cookie ? { cookie } : {};
  let payload;
  if (raw !== undefined) {
    headers["content-type"] = "application/octet-stream";
    payload = raw;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const bytes = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, bytes, json: type.includes("json") ? JSON.parse(bytes.toString("utf8")) : null };
}

/** One prompt to the end of its turn, allowing each approval; returns the assistant message. */
async function turn(sessionId, message) {
  const prompt = await call("POST", `/api/sessions/${sessionId}/prompt`, { message });
  check(prompt.status === 202, "prompt status", prompt.status);
  const id = prompt.json.assistantMessageId;
  const allowed = new Set();
  const deadline = Date.now() + TURN_MS;
  while (Date.now() < deadline) {
    const { json } = await call("GET", `/api/sessions/${sessionId}/messages`);
    const reply = json.messages.find((m) => m.id === id);
    for (const approval of reply?.approvals ?? []) {
      if (approval.decision === null && !allowed.has(approval.id)) {
        allowed.add(approval.id);
        const r = await call("POST", `/api/sessions/${sessionId}/approvals/${approval.id}`, { decision: "allow" });
        check(r.status === 200, "approval answer status", r.status);
      }
    }
    if (reply?.status === "failed" || json.session.status === "failed") {
      throw new Failure(`turn failed: ${JSON.stringify({ steps: reply?.steps, approvals: reply?.approvals })}`);
    }
    if (reply?.status === "done" && json.session.status === "done") return reply;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Failure(`turn did not finish within ${TURN_MS / 1000} s`);
}

/**
 * The single `eval` approval and step of a turn (omp v18.12.3 drives the browser from the eval prelude;
 * the prelude's own `Allow tool: browser` card is answered by the host and never listed): the card is
 * `Allow tool: eval`, `Language: javascript`, then the code, which must contain `needle`.
 */
function expectEvalCall(reply, needle) {
  const approvals = reply.approvals.map((a) => ({ tool: a.tool, lines: String(a.title).split("\n"), decision: a.decision }));
  check(approvals.length === 1 && approvals[0].tool === "eval", "one eval approval", approvals);
  const [head, language, ...code] = approvals[0].lines;
  check(head === "Allow tool: eval" && language === "Language: javascript", "eval approval title", approvals);
  check(code.join("\n").includes(needle) && approvals[0].decision === "allow", `approval code with ${needle}`, approvals);
  const steps = reply.steps.map((s) => ({ name: s.name, status: s.status, detail: firstLine(s.detail), changes: s.changes }));
  check(steps.length === 1 && steps[0].name === "eval" && steps[0].status === "done", "one done eval step", steps);
  log(`approval and step: eval / ${needle}`);
  return steps[0];
}

const upstream = await start({ toolRoundScope: "turn" });
const proxy = await forwarder(upstream.port);
try {
  const login = await call("POST", "/api/auth/login", { account: "zhangsan", password: "demo" });
  check(login.status === 200, "login status", login.status);
  const space = await call("POST", "/api/workspaces", { name: "browser-ci" });
  check(space.status === 201 && typeof space.json.root === "string", "workspace", space.status);
  const upload = await call("POST", `/api/workspaces/${space.json.id}/uploads?name=index.html`, undefined, PAGE);
  check(upload.status === 201 && typeof upload.json.path === "string", "upload", upload.json);
  check(upload.json.path === "uploads/index.html", "upload path", upload.json.path);
  const session = await call("POST", "/api/sessions", { workspaceId: space.json.id, approvalMode: "write" });
  check(session.status === 201, "session status", session.status);
  const sessionId = session.json.id;

  const url = `file://${space.json.root}/${upload.json.path}`;
  const open = expectEvalCall(await turn(sessionId, `打开页面 WORKBUDDY_BROWSER_OPEN:${url}`), "browser.open");
  check(open.changes === null, "no changes on the open step", open.changes);

  const second = Date.now();
  const shot = expectEvalCall(await turn(sessionId, "截图 WORKBUDDY_BROWSER_SHOT"), "screenshot");
  check(Array.isArray(shot.changes) && shot.changes.length === 1, "one screenshot change", shot.changes);
  const [change] = shot.changes;
  check(/^screenshots\/screenshot-[^/]+\.png$/u.test(change.path) && change.kind === "write", "screenshot change", change);
  const file = await call("GET", `/api/workspaces/${space.json.id}/file?path=${encodeURIComponent(change.path)}`);
  check(file.status === 200 && file.bytes.subarray(0, 8).equals(PNG_SIGNATURE), "screenshot file is a PNG", file.status);
  log(`screenshot ${change.path} (${file.bytes.length} bytes, PNG signature)`);

  const first = seen.filter((r) => r.at < second);
  const later = seen.filter((r) => r.at >= second);
  check(first.length > 0 && later.length > 0, "forwarder saw requests in both turns", [first.length, later.length]);
  check(first.every((r) => !r.image), "want no image_url in turn 1", first);
  check(later.some((r) => r.image), "want an image_url in turn 2", later);
  log(`forwarder: turn 1 ${first.length} request(s) without image_url; turn 2 ${later.filter((r) => r.image).length} of ${later.length} with image_url`);

  const audit = await call("GET", "/api/audit?limit=200");
  check(audit.status === 200, "audit status", audit.status);
  // One audit per browser call, from the eval step's statusEvents (`open main <url>`, `main.screenshot()`).
  const browserEvents = audit.json.events.filter((e) => e.kind === "session.browser" && e.detail?.sessionId === sessionId);
  const details = browserEvents.map((e) => e.detail);
  check(details.length === 2 && details.every((d) => d.error === null && !("elided" in d)), "two session.browser audits", details);
  const calls = details.map((d) => String(d.detail));
  check(calls.filter((c) => c.startsWith("open main file://")).length === 1, "an open main file:// audit", calls);
  check(calls.filter((c) => !c.startsWith("open main ") && c.includes("screenshot")).length === 1, "a screenshot audit", calls);
  log(`audit: two session.browser events (${calls.map((c) => c.split(" ", 1)[0]).join(", ")})`);
  await call("POST", "/api/auth/logout");
} catch (error) {
  process.stderr.write(`browser-e2e: FAIL ${error instanceof Failure ? error.message : error}\n`);
  process.exitCode = 1;
} finally {
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  await upstream.close();
}
