/**
 * The `POST /embeddings` of `fake-upstream.mjs` (s2a-kb-ragflow D7): what a knowledge-base embedding
 * probe reads. Scripted per call, because the probe sends only `{model, input}` and has no marker
 * text to carry a script: `answer()` queues replies, `hold()` parks the next request until
 * `release()`. Without a script the reply is a one-item list with a three-number vector.
 *
 * Like `GET /models`, the 401 echoes the offered bearer: a sentinel for the sanitising cases.
 * `createProbeScript` is the scaffold shared with `POST /rerank` (`fake-upstream-rerank.mjs`).
 */
const VECTORS = { object: "list", data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] };

function write(response, reply) {
  const { status = 200, body, headers = {} } = reply;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(text);
}

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createEmbeddingScript(expectedKey) {
  return createProbeScript(expectedKey, { body: VECTORS });
}

/** A scripted probe endpoint: `fallback` answers when no reply is queued. */
export function createProbeScript(expectedKey, fallback) {
  const replies = [];
  const holds = [];
  const live = new Set();
  /** In arrival order: `{authorization, body}`, the parsed body or `null`. */
  const requests = [];
  return {
    async serve(response, authorization, text) {
      requests.push({ authorization: authorization ?? null, body: parsed(text) });
      const hold = holds.shift();
      if (hold !== undefined) {
        live.add(hold);
        hold.arrived();
        await hold.released;
      }
      if (authorization !== `Bearer ${expectedKey}`) {
        const offered = authorization?.replace(/^Bearer /u, "") ?? "none";
        write(response, { status: 401, body: { error: { message: `bad key ${offered}` } } });
        return;
      }
      write(response, replies.shift() ?? fallback);
    },
    handle: {
      answer(reply) {
        replies.push(reply);
      },
      hold() {
        const { promise: reached, resolve: arrived } = Promise.withResolvers();
        const { promise: released, resolve: release } = Promise.withResolvers();
        holds.push({ arrived, released, release });
        return { reached, release };
      },
      requests: () => requests.map((entry) => ({ ...entry })),
    },
    close() {
      for (const hold of live) {
        hold.release();
      }
    },
  };
}
