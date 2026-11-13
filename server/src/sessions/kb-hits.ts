/**
 * Change s2c-kb-session D7 (#1967) chat-stream「检索结果事件发布」: the supervisor's gate for the reducer's
 * raw kb.hits, before it is routed. A valid one becomes a new event whose `bases` is the typed,
 * key-ordered copy; an invalid one is dropped with one `kb_hits_invalid` record through the sessions
 * `log` port (no chunk text: exactly two keys). The step id mapping and the "never stored" rule are
 * `persistEvent`'s (turn-control.ts).
 */
import type { ChatEvent } from "./events.js";
import { asPlain, own } from "./file-changes.js";
import { consumeThenable, type SpawnLog } from "./omp/spawn-gate.js";
import { validItems } from "./session-todo.js";

type KbStatus = "ok" | "not_found" | "not_ready" | "failed";

interface KbHit {
  documentId: string;
  name: string;
  similarity: number;
  content: string;
}

export interface KbHitBase {
  kbId: string;
  name: string | null;
  status: KbStatus;
  hits: KbHit[];
}

export interface KbHitsInvalidRecord {
  event: "kb_hits_invalid";
  messageId: number;
}

type RawKbHits = Extract<ChatEvent<string>, { type: "kb.hits" }>;

/** A mapper event that passed the gate: kb.hits carries the validated `bases`. */
export type AdmittedEvent =
  | Exclude<ChatEvent<string>, RawKbHits>
  | { type: "kb.hits"; data: Omit<RawKbHits["data"], "bases"> & { bases: KbHitBase[] } };

const STATUSES: ReadonlySet<string> = new Set<KbStatus>(["ok", "not_found", "not_ready", "failed"]);
const BASE_KEYS = ["kbId", "name", "status", "hits"];
const HIT_KEYS = ["documentId", "name", "similarity", "content"];
const MAX_BASES = 5;
const MAX_HITS = 6;

/**
 * Every other event is returned as is. A kb.hits is checked; invalid → `undefined` after its record
 * (a throwing log or a returned thenable never alters the turn).
 */
export function admitKbHits(log: SpawnLog, event: ChatEvent<string>): AdmittedEvent | undefined {
  if (event.type !== "kb.hits") {
    return event;
  }
  const { messageId, stepId } = event.data;
  const checked = checkKbHits(event.data.intent, event.data.bases);
  if (checked !== undefined) {
    return { type: "kb.hits", data: { messageId, stepId, ...checked } };
  }
  try {
    consumeThenable(log({ event: "kb_hits_invalid", messageId }));
  } catch {
    // The log port is observation only: its failure never changes the turn.
  }
  return undefined;
}

/**
 * `intent` null or a nonempty string; `bases` 1–5 bases and each base at most 6 hits, every level an
 * exact own key set and no sparse array. Returns new objects in the fixed key order, or `undefined`.
 */
export function checkKbHits(
  intent: unknown,
  bases: unknown,
): { intent: string | null; bases: KbHitBase[] } | undefined {
  const checkedIntent = intent === null ? null : nonempty(intent) ? intent : undefined;
  const valid = validItems(bases, checkBase);
  return checkedIntent !== undefined &&
    valid !== undefined &&
    valid.length >= 1 &&
    valid.length <= MAX_BASES
    ? { intent: checkedIntent, bases: valid }
    : undefined;
}

/** `name` is null for `not_found`, a nonempty string otherwise; only `ok` may carry hits. */
function checkBase(value: unknown): KbHitBase | undefined {
  const record = exactly(value, BASE_KEYS);
  if (record === undefined || !nonempty(record.kbId) || !isStatus(record.status)) {
    return undefined;
  }
  const { kbId, status } = record;
  const name = status === "not_found" ? nullName(record.name) : nonemptyName(record.name);
  const hits = validItems(record.hits, checkHit);
  const maxHits = status === "ok" ? MAX_HITS : 0;
  return name !== undefined && hits !== undefined && hits.length <= maxHits
    ? { kbId, name, status, hits }
    : undefined;
}

function nullName(value: unknown): null | undefined {
  return value === null ? null : undefined;
}

function nonemptyName(value: unknown): string | undefined {
  return nonempty(value) ? value : undefined;
}

function isStatus(value: unknown): value is KbStatus {
  return typeof value === "string" && STATUSES.has(value);
}

function checkHit(value: unknown): KbHit | undefined {
  const record = exactly(value, HIT_KEYS);
  if (record === undefined) {
    return undefined;
  }
  const { documentId, name, similarity, content } = record;
  return typeof documentId === "string" &&
    typeof name === "string" &&
    typeof similarity === "number" &&
    Number.isFinite(similarity) &&
    typeof content === "string"
    ? { documentId, name, similarity, content }
    : undefined;
}

/** A plain object whose own keys are exactly `keys`, read as own properties; else `undefined`. */
function exactly(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  const record = asPlain(value);
  if (record === undefined || Reflect.ownKeys(record).length !== keys.length) {
    return undefined;
  }
  return keys.every((key) => Object.hasOwn(record, key))
    ? Object.fromEntries(keys.map((key) => [key, own(record, key)]))
    : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
