/**
 * Issue #909 task 1.3: the failure markers of the fake upstream — model-proxy「假上游夹具契约」
 * scenarios「Scripted failure markers」「Fail first n then succeed」「Delayed scripted status」
 * 「Hang and cut」. Expected bodies are the contract's literals, not imported from the fixture.
 * Issue #1769: scenario「omp 的日期提醒不算最后一条 user 消息」.
 */
import { spawn } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseDataRecords, startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const KEY = "fake";
const FAKE = fileURLToPath(new URL("./support/fake-upstream.mjs", import.meta.url));
const handles: FakeUpstreamServer[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
});

interface Reply {
  status: number;
  contentType: string | null;
  contentLength: string | null;
  text: string;
}

/** One user message `text`, or the whole `messages` array as given. */
function chatBody(text: string | unknown[]): string {
  const messages = typeof text === "string" ? [{ role: "user", content: text }] : text;
  return JSON.stringify({ model: "m1", messages, stream: true });
}

function post(port: number, text: string | unknown[], signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: chatBody(text),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function reply(port: number, text: string | unknown[]): Promise<Reply> {
  const response = await post(port, text);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    text: await response.text(),
  };
}

function isToolRound(answer: Reply): boolean {
  return (
    answer.status === 200 &&
    answer.text.includes('"tool_calls"') &&
    answer.text.endsWith("data: [DONE]\n\n")
  );
}

/** Everything a raw client reads until the server ends or destroys the connection. */
function rawRead(
  port: number,
  text: string,
): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const body = chatBody(text);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        const done = (): void =>
          resolve({
            status: response.statusCode ?? 0,
            type: String(response.headers["content-type"]),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        response.on("error", done);
        response.on("close", done);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return outcome;
}

/** A request held open by the fixture; `settled` says how it ended. */
function rawPending(port: number, text: string): { destroy(): void; settled: Promise<string> } {
  const body = chatBody(text);
  const req = request({
    host: "127.0.0.1",
    port,
    path: "/v1/chat/completions",
    method: "POST",
    agent: false,
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  const settled = new Promise<string>((resolve) => {
    req.on("response", () => resolve("response"));
    req.on("error", () => resolve("error"));
    req.on("close", () => resolve("closed"));
  });
  req.end(body);
  return { destroy: () => req.destroy(), settled };
}

function timeouts(): number {
  return process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
}

async function expectRefused(port: number): Promise<void> {
  await expect(reply(port, "x")).rejects.toBeInstanceOf(Error);
}

describe("fake-upstream failure markers", () => {
  it("Scripted failure markers: each status with the named body, no SSE, every request recorded", async () => {
    const handle = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    const port = handle.port;
    expect(await reply(port, "x WORKBUDDY_FAKE_STATUS=401")).toMatchObject({
      status: 401,
      contentType: "application/json",
      text: '{"error":{"message":"scripted upstream 401","type":"scripted_error"}}',
    });
    expect(
      await reply(port, "x WORKBUDDY_FAKE_STATUS=404 WORKBUDDY_FAKE_BODY=model"),
    ).toMatchObject({
      status: 404,
      contentType: "application/json",
      text: '{"error":{"message":"The model `x` does not exist","type":"model_not_found"}}',
    });
    expect(
      await reply(port, "x WORKBUDDY_FAKE_STATUS=429 WORKBUDDY_FAKE_BODY=quota"),
    ).toMatchObject({
      status: 429,
      contentType: "application/json",
      text: '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}',
    });
    expect(await reply(port, "x WORKBUDDY_FAKE_STATUS=503 WORKBUDDY_FAKE_BODY=text")).toMatchObject(
      {
        status: 503,
        contentType: "text/plain",
        text: "503 Service Unavailable",
      },
    );
    expect(await reply(port, "x WORKBUDDY_FAKE_STATUS=400 WORKBUDDY_FAKE_BODY=empty")).toEqual({
      status: 400,
      contentType: null,
      contentLength: "0",
      text: "",
    });
    const secret = await reply(port, "x WORKBUDDY_FAKE_STATUS=500 WORKBUDDY_FAKE_BODY=secret");
    expect(secret).toMatchObject({ status: 500, contentType: "application/json" });
    const message = (JSON.parse(secret.text) as { error: { message: string } }).error.message;
    expect(message).toContain(KEY);
    const order = [
      KEY,
      "Bearer leak-token-0123456789",
      "sk-leakleakleakleakleak",
      "\nraw-http-request=/tmp/leak.json",
    ];
    const at = order.map((part) => message.indexOf(part));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(handle.requests()).toHaveLength(6);
  });

  it("answers the text body of 524 with `Unknown` and the big body with 20000 code points", async () => {
    const handle = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    expect(
      await reply(handle.port, "x WORKBUDDY_FAKE_STATUS=524 WORKBUDDY_FAKE_BODY=text"),
    ).toMatchObject({
      status: 524,
      text: "524 Unknown",
    });
    const big = await reply(handle.port, "x WORKBUDDY_FAKE_STATUS=502 WORKBUDDY_FAKE_BODY=big");
    expect(big).toMatchObject({ status: 502, contentType: "text/plain" });
    expect(Array.from(big.text)).toHaveLength(20_000);
    expect(big.text).toContain("\n");
  });

  it("Fail first n then succeed: counts per instance and per text", async () => {
    const first = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    const second = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    const text = "x WORKBUDDY_FAKE_STATUS=503 WORKBUDDY_FAKE_FAIL_TIMES=2";
    const answers = [];
    for (let index = 0; index < 4; index += 1) {
      answers.push(await reply(first.port, text));
    }
    expect(answers.map((answer) => answer.status)).toEqual([503, 503, 200, 200]);
    expect(answers.slice(2).every(isToolRound)).toBe(true);
    expect((await reply(second.port, text)).status).toBe(503);
    // Another text on the first instance has its own count.
    expect((await reply(first.port, `${text} again`)).status).toBe(503);
  });

  it("Delayed scripted status: headers after the delay, an aborted wait released, close leaves no timer", async () => {
    const handle = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    const startedAt = Date.now();
    const answer = await reply(
      handle.port,
      "x WORKBUDDY_FAKE_STATUS=504 WORKBUDDY_FAKE_DELAY=2000",
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(answer).toMatchObject({
      status: 504,
      text: '{"error":{"message":"scripted upstream 504","type":"scripted_error"}}',
    });
    // Raw clients without an agent: the only timers counted are the fixture's delays.
    const before = timeouts();
    const aborted = rawPending(
      handle.port,
      "x WORKBUDDY_FAKE_STATUS=504 WORKBUDDY_FAKE_DELAY=2000",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(timeouts()).toBe(before + 1);
    aborted.destroy();
    await aborted.settled;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The aborted request's delay went with its connection: nothing is written late.
    expect(timeouts()).toBe(before);
    const pending = rawPending(
      handle.port,
      "x WORKBUDDY_FAKE_STATUS=504 WORKBUDDY_FAKE_DELAY=60000",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(timeouts()).toBe(before + 1);
    expect(await settledWithin(handle.close(), 1_000)).toBe(true);
    expect(await pending.settled).toBe("error");
    expect(timeouts()).toBe(before);
    await expectRefused(handle.port);
  });

  it("Hang and cut: no headers until the client leaves; two deltas then a destroyed socket", async () => {
    const handle = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    const abort = new AbortController();
    const hung = post(handle.port, "x WORKBUDDY_FAKE_HANG", abort.signal);
    expect(await settledWithin(hung, 500)).toBe(false);
    abort.abort();
    await expect(hung).rejects.toBeInstanceOf(Error);
    const cut = await rawRead(handle.port, "x WORKBUDDY_FAKE_CUT");
    expect(cut.status).toBe(200);
    expect(cut.type).toBe("text/event-stream");
    const records = parseDataRecords(cut.body);
    expect(records).not.toContain("[DONE]");
    const deltas = records.map(
      (record) =>
        (JSON.parse(record) as { choices: [{ delta: unknown; finish_reason: unknown }] })
          .choices[0],
    );
    expect(deltas).toEqual([
      { index: 0, delta: { content: "你好，" }, finish_reason: null },
      { index: 0, delta: { content: "半句" }, finish_reason: null },
    ]);
    // A hang still open at close is released with it.
    const open = post(handle.port, "x WORKBUDDY_FAKE_HANG");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await settledWithin(handle.close(), 1_000)).toBe(true);
    await expect(open).rejects.toBeInstanceOf(Error);
    expect(handle.requests()).toHaveLength(3);
  });

  it("STATUS wins over HANG and CUT, and WORKBUDDY_FAKE_ERROR wins over every marker", async () => {
    const handle = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    expect(
      (
        await reply(
          handle.port,
          "x WORKBUDDY_FAKE_CUT WORKBUDDY_FAKE_HANG WORKBUDDY_FAKE_STATUS=418",
        )
      ).status,
    ).toBe(418);
    expect(
      await reply(handle.port, "x WORKBUDDY_FAKE_STATUS=401 WORKBUDDY_FAKE_ERROR"),
    ).toMatchObject({
      status: 500,
      text: '{"error":{"message":"fake upstream error"}}',
    });
  });

  it("serves the markers from the standalone CLI too", async () => {
    const child = spawn(process.execPath, [FAKE], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.stdout.once("data", (chunk: Buffer) => {
          resolve((JSON.parse(chunk.toString("utf8")) as { port: number }).port);
        });
        child.once("exit", () => reject(new Error("fake upstream CLI exited before readiness")));
      });
      expect(
        await reply(port, "x WORKBUDDY_FAKE_STATUS=403 WORKBUDDY_FAKE_BODY=text"),
      ).toMatchObject({
        status: 403,
        text: "403 Forbidden",
      });
    } finally {
      child.kill("SIGTERM");
    }
  });
});

// Issue #1769: omp v18.12.3's date / cwd reminder (prompts/system/date-cwd-reminder.md), sent with
// role `user` when the upstream takes no developer role. Written from the spec, not the fixture.
const REMINDER =
  "<system-reminder>\nToday: 2026-10-26; current working directory: '/w'. Do not repeat this information in your reply.\n</system-reminder>";
const user = (content: unknown): unknown => ({ role: "user", content });

describe("omp's date reminder is not the last user message (#1769)", () => {
  it("a trailing reminder keeps the real user's STATUS marker", async () => {
    const handle = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    expect(
      await reply(handle.port, [user("WORKBUDDY_FAKE_STATUS=503"), user(REMINDER)]),
    ).toMatchObject({
      status: 503,
      contentType: "application/json",
      text: '{"error":{"message":"scripted upstream 503","type":"scripted_error"}}',
    });
  });

  it("a trailing reminder keeps the real user's WORKBUDDY_FAKE_ERROR", async () => {
    const handle = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    expect(await reply(handle.port, [user("WORKBUDDY_FAKE_ERROR"), user(REMINDER)])).toMatchObject({
      status: 500,
      text: '{"error":{"message":"fake upstream error"}}',
    });
  });

  it("a reminder as one text part is skipped too", async () => {
    const handle = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    const parts = [{ type: "text", text: `\n${REMINDER}\n` }];
    const answer = await reply(handle.port, [user("WORKBUDDY_FAKE_STATUS=503"), user(parts)]);
    expect(answer.status).toBe(503);
  });

  it("FAIL_TIMES counts the real user's text whether or not a reminder trails it", async () => {
    const handle = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    const first = user("WORKBUDDY_FAKE_STATUS=503 WORKBUDDY_FAKE_FAIL_TIMES=2");
    const answers = [];
    for (const messages of [[first], [first, user(REMINDER)], [first, user(REMINDER)], [first]]) {
      answers.push(await reply(handle.port, messages));
    }
    expect(answers.map((answer) => answer.status)).toEqual([503, 503, 200, 200]);
    expect(answers.slice(2).every(isToolRound)).toBe(true);
  });

  it("a user message with other text, or with two reminder blocks, still counts", async () => {
    const handle = await startTrackedFakeUpstream(handles, { apiKey: KEY });
    // omp prepends the reminder and a newline to the first user message.
    const prefixed = await reply(handle.port, [user(`${REMINDER}\nWORKBUDDY_FAKE_STATUS=503`)]);
    expect(prefixed.status).toBe(503);
    const twice = await reply(handle.port, [
      user("WORKBUDDY_FAKE_STATUS=503"),
      user(`${REMINDER}\n${REMINDER}`),
    ]);
    expect(isToolRound(twice)).toBe(true);
  });
});
