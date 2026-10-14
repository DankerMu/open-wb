/**
 * Issue #909 failure markers of the fake upstream (model-proxy「假上游夹具契约」, 失败标记): read
 * from the last user message once the request is authenticated and WORKBUDDY_FAKE_ERROR is absent.
 * STATUS, HANG and CUT are tried in this order and only the first present one applies; BODY,
 * FAIL_TIMES and DELAY only modify STATUS. Zero-dependency sibling of fake-upstream.mjs.
 *
 * Branches the contract does not state, decided here: a STATUS outside 400–599, a DELAY outside
 * 0–600000 and a FAIL_TIMES that is not a whole number count as absent; an unknown BODY name
 * answers the default `json` body.
 */
import { STATUS_CODES } from "node:http";

const STATUS = /WORKBUDDY_FAKE_STATUS=([45]\d\d)(?!\d)/u;
const BODY = /WORKBUDDY_FAKE_BODY=([a-z]+)/u;
const FAIL_TIMES = /WORKBUDDY_FAKE_FAIL_TIMES=(\d+)(?!\d)/u;
const DELAY = /WORKBUDDY_FAKE_DELAY=(\d+)(?!\d)/u;
const HANG = "WORKBUDDY_FAKE_HANG";
const CUT = "WORKBUDDY_FAKE_CUT";
const MAX_DELAY_MS = 600_000;
const CUT_PARTS = ["你好，", "半句"];
const BIG_LINE = "上游繁忙0123456789abcde\n";
const BIG_POINTS = 20_000;

/**
 * One instance's failure script: `serve` answers a request carrying a failure marker and returns
 * true, or returns false (the request takes the ordinary branches); `close` drops pending delays.
 */
export function createFailureScript(expectedKey) {
  /** Requests answered with the scripted status so far, per distinct last user text. */
  const counts = new Map();
  const timers = new Set();
  return {
    serve(response, text, contentChunk) {
      const status = scriptedStatus(text, counts);
      if (status !== undefined) {
        const reply = statusBody(status, bodyName(text), expectedKey);
        delayed(response, delayOf(text), timers, () => writeReply(response, status, reply));
        return true;
      }
      if (text.includes(HANG)) {
        // Neither headers nor body: the request stays open until the client leaves or close.
        return true;
      }
      if (text.includes(CUT)) {
        cut(response, contentChunk);
        return true;
      }
      return false;
    },
    close() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}

function scriptedStatus(text, counts) {
  const match = STATUS.exec(text);
  if (match === null) {
    return undefined;
  }
  const times = FAIL_TIMES.exec(text);
  if (times !== null) {
    const seen = counts.get(text) ?? 0;
    if (seen >= Number(times[1])) {
      return undefined;
    }
    counts.set(text, seen + 1);
  }
  return Number(match[1]);
}

function bodyName(text) {
  return BODY.exec(text)?.[1] ?? "json";
}

function delayOf(text) {
  const match = DELAY.exec(text);
  const ms = match === null ? 0 : Number(match[1]);
  return ms <= MAX_DELAY_MS ? ms : 0;
}

function statusBody(status, name, expectedKey) {
  const json = (error) => ({ type: "application/json", text: JSON.stringify({ error }) });
  switch (name) {
    case "text":
      return { type: "text/plain", text: `${status} ${STATUS_CODES[status] ?? "Unknown"}` };
    case "empty":
      return { type: undefined, text: "" };
    case "quota":
      return json({
        message: "You exceeded your current quota",
        type: "insufficient_quota",
        code: "insufficient_quota",
      });
    case "model":
      return json({ message: "The model `x` does not exist", type: "model_not_found" });
    case "secret":
      return json({
        message: `rejected key ${expectedKey}; Authorization: Bearer leak-token-0123456789; sk-leakleakleakleakleak\nraw-http-request=/tmp/leak.json`,
        type: "scripted_error",
      });
    case "big":
      return {
        type: "text/plain",
        text: BIG_LINE.repeat(BIG_POINTS / Array.from(BIG_LINE).length),
      };
    default:
      return json({ message: `scripted upstream ${status}`, type: "scripted_error" });
  }
}

function writeReply(response, status, reply) {
  if (reply.type === undefined) {
    response.writeHead(status, { "content-length": "0" });
  } else {
    response.writeHead(status, { "content-type": reply.type });
  }
  response.end(reply.text);
}

/** Writes after `ms`; a client that leaves first or `close` cancels the write. */
function delayed(response, ms, timers, write) {
  if (ms === 0) {
    write();
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (!response.destroyed && !response.writableEnded) {
      write();
    }
  }, ms);
  timers.add(timer);
  response.once("close", () => {
    clearTimeout(timer);
    timers.delete(timer);
  });
}

/** 200 SSE, the two deltas, then the socket is destroyed: no finish reason, no `[DONE]`. */
function cut(response, contentChunk) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const [first, second] = CUT_PARTS.map(
    (part) => `data: ${JSON.stringify(contentChunk({ content: part }))}\n\n`,
  );
  response.write(first);
  response.write(second, () => {
    response.destroy();
  });
}
