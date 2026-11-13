import { hasExactlyKeys, parseJsonArray } from "../../lib/api-json.js";
import { type ChatStepView, updateStep } from "./stream-steps.js";

/**
 * 检索结果事件（#1968，chat-web「事件流消费与续流」「纯会话视图归约」）：`kb.hits` 只走实时流，
 * 把一次 `kb_search` 调用按库分组的命中挂到它的步骤上；快照里没有它（`kbHits` 为 `null`）。
 */
type KbStatus = "ok" | "not_found" | "not_ready" | "failed";
type KbHit = { documentId: string; name: string; similarity: number; content: string };
type KbBase = { kbId: string; name: string | null; status: KbStatus; hits: KbHit[] };

export type ChatKbHits = { intent: string | null; bases: KbBase[] };

export type ChatKbHitsEvent = {
  type: "kb.hits";
  data: { messageId: number; stepId: number } & ChatKbHits;
};

const KB_STATUSES: readonly string[] = ["ok", "not_found", "not_ready", "failed"];
const BASES_MAX = 5;
const OK_HITS_MAX = 6;

/**
 * Strict key set `{messageId, stepId, intent, bases}` under chat-stream「检索结果事件发布」: two
 * safe-integer ids, `intent` null or nonempty, 1..5 bases; anything else is `undefined`.
 */
export function decodeKbHits(value: unknown): ChatKbHitsEvent | undefined {
  if (
    !hasExactlyKeys(value, ["messageId", "stepId", "intent", "bases"]) ||
    !isSafeInteger(value.messageId) ||
    !isSafeInteger(value.stepId) ||
    !(value.intent === null || isNonEmptyString(value.intent))
  ) {
    return undefined;
  }
  const bases = parseJsonArray(value.bases, parseBase);
  if (bases === null || bases.length < 1 || bases.length > BASES_MAX) {
    return undefined;
  }
  const { messageId, stepId, intent } = value;
  return { type: "kb.hits", data: { messageId, stepId, intent, bases } };
}

/** Sets step `stepId`'s `kbHits` (the later event wins); an unknown step is a no-op. */
export function setStepKbHits<M extends { steps: ChatStepView[] }>(
  message: M,
  data: ChatKbHitsEvent["data"],
): M {
  const kbHits = { intent: data.intent, bases: data.bases };
  return updateStep(message, data.stepId, (step) => ({ ...step, kbHits }));
}

/** `name` is `null` exactly for `not_found`; only an `ok` base carries hits (at most six). */
function parseBase(value: unknown): KbBase | null {
  if (
    !hasExactlyKeys(value, ["kbId", "name", "status", "hits"]) ||
    !isNonEmptyString(value.kbId) ||
    typeof value.status !== "string" ||
    !KB_STATUSES.includes(value.status)
  ) {
    return null;
  }
  const status = value.status as KbStatus;
  const nameValid = status === "not_found" ? value.name === null : isNonEmptyString(value.name);
  const hits = parseJsonArray(value.hits, parseHit);
  if (!nameValid || hits === null || hits.length > (status === "ok" ? OK_HITS_MAX : 0)) {
    return null;
  }
  return { kbId: value.kbId, name: value.name as string | null, status, hits };
}

function parseHit(value: unknown): KbHit | null {
  if (
    !hasExactlyKeys(value, ["documentId", "name", "similarity", "content"]) ||
    typeof value.documentId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.similarity !== "number" ||
    !Number.isFinite(value.similarity) ||
    typeof value.content !== "string"
  ) {
    return null;
  }
  const { documentId, name, similarity, content } = value;
  return { documentId, name, similarity, content };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
