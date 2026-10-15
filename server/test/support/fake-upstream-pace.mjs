/**
 * Issue 1437 WORKBUDDY_PACE (omp-test-harness「受控上游节奏与闸门停点标记」): the answering round
 * written one record at a time, 25ms apart — role, the three reasoning parts, 40 `字` content
 * chunks, finish, `[DONE]`. Zero-dependency sibling of fake-upstream.mjs, which decides when a
 * request is paced (answering round, no armed gate) and hands over its frame builder.
 *
 * Each write schedules the next one only after it ran, so an event-loop stall delays the rest
 * instead of bunching two records together. A client that leaves (or `close()`, which drops every
 * connection) clears the pending timer, so nothing more is written or scheduled.
 */
export const PACE_MARKER = "WORKBUDDY_PACE";
const INTERVAL_MS = 25;
const CHAR = "字";
const CHAR_COUNT = 40;

/** `frame(delta, finishReason)` builds one chunk of this completion; `thinkParts` the reasoning. */
export function writePacedSse(response, frame, thinkParts) {
  const frames = [
    frame({ role: "assistant" }, null),
    ...thinkParts.map((part) => frame({ reasoning_content: part }, null)),
  ];
  for (let index = 0; index < CHAR_COUNT; index += 1) {
    frames.push(frame({ content: CHAR }, null));
  }
  frames.push(frame({}, "stop"));
  const records = frames.map((item) => `data: ${JSON.stringify(item)}\n\n`);
  records.push("data: [DONE]\n\n");

  let timer;
  // A closed socket emits the response's `close` on nextTick, before any timer runs again
  // (读代码推出: node:http server); the mid-stream test checks no step is scheduled after that.
  response.once("close", () => {
    clearTimeout(timer);
  });
  response.writeHead(200, { "content-type": "text/event-stream" });
  let next = 0;
  const step = () => {
    response.write(records[next]);
    next += 1;
    if (next === records.length) {
      response.end();
      return;
    }
    timer = setTimeout(step, INTERVAL_MS);
  };
  step();
}
