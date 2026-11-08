/**
 * The `POST /rerank` of `fake-upstream.mjs` (s2b-kb-retrieval D7): what a knowledge-base rerank
 * probe reads. Scripted per call like `/embeddings` (`answer()`, `hold()`, `requests()`); the 401
 * echoes the offered bearer. Without a script the reply is the direct-upstream shape of the rc2
 * record §19.4; a missing model is scripted by the case as 503 `error.code:"model_not_found"`.
 */
import { createProbeScript } from "./fake-upstream-embeddings.mjs";

const RESULTS = {
  results: [{ document: { text: "ping" }, index: 0, relevance_score: 0.635 }],
  usage: {},
};

export function createRerankScript(expectedKey) {
  return createProbeScript(expectedKey, { body: RESULTS });
}
