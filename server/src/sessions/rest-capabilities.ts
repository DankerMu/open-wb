/**
 * Session capabilities (s1d-experts-skills D7, s1d-connectors D7; skill-switches「会话能力端点」). `GET`
 * and `PUT /api/sessions/:id/capabilities` answer exactly `{expertId, disabledSkills,
 * disabledConnectors}`: `expertId` is the effective expert — a stored id the owner can no longer see
 * (deleted, another account's, a withdrawn built-in) reads as null and is not rewritten — and the two
 * lists the stored ones in dictionary order. Both pre-check the owner before the body (401 by the
 * root guard; unknown and foreign ids one 404) and answer no-store. `GET` serves an archived session
 * too (it can be selected read-only); only `PUT` refuses one with 409 `session_archived`.
 * `PUT` (a content-parser owner, 64 KiB) takes a non-empty subset of `{expertId: string | null,
 * disabledSkills: string[], disabledConnectors: string[]}`: `{}`, an extra key, an expert the owner
 * cannot see, a bad list are 400 and nothing is written. The union rule is `store-capabilities.ts`'s:
 * a non-null expert in the body takes its declared skills out of (the body's list, else the stored
 * one); a body of only `disabledSkills` is stored as given; clearing the expert restores nothing.
 * `disabledConnectors` (connector names, ≤32, need not be registered) replaces the stored list whole
 * and is untouched by the expert. The supervisor is not told: a running turn is untouched, the next
 * dispatch aligns (group 6).
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { normalizeConnectorNames } from "../connectors/validate.js";
import { HttpError } from "../core/errors/index.js";
import {
  authorizeOwnedBeforeParse,
  createPrincipal,
  type ExpertReader,
  isPlainObject,
  noStoreMetadataResponse,
  requireDisabledSkills,
  requireVisibleExpert,
} from "./rest-metadata.js";
import type { SessionStore } from "./store.js";
import {
  type Capabilities,
  type CapabilitiesPatch,
  patchSessionCapabilities,
  readSessionCapabilities,
} from "./store-capabilities.js";
import type { SessionMetadataStore } from "./store-metadata.js";

interface SessionCapabilityRouteDependencies {
  db: DatabaseSync;
  store: Pick<SessionStore, "getMessages">;
  metadata: Pick<SessionMetadataStore, "archivedAt">;
  experts: ExpertReader;
}

/** Same reasoning as `PUT /api/skills/defaults`: 128 names of up to 128 bytes, JSON-escaped. */
const CAPABILITIES_BODY_LIMIT = 64 * 1024;
const PUT_KEYS: ReadonlySet<string> = new Set(["expertId", "disabledSkills", "disabledConnectors"]);

export function registerSessionCapabilityRoutes(
  app: FastifyInstance,
  dependencies: SessionCapabilityRouteDependencies,
): void {
  const { db, experts } = dependencies;
  const owned = {
    onRequest: noStoreMetadataResponse,
    preParsing: authorizeOwnedBeforeParse(dependencies.store),
  };

  const effective = (ownerId: string, stored: Capabilities): Capabilities => ({
    expertId:
      stored.expertId !== null && experts.get(ownerId, stored.expertId) !== undefined
        ? stored.expertId
        : null,
    disabledSkills: stored.disabledSkills,
    disabledConnectors: stored.disabledConnectors,
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/capabilities", owned, async (request) => {
    const stored = readSessionCapabilities(db, request.params.id);
    if (stored === undefined) {
      // The row vanished after the owner check (a concurrent delete).
      throw new HttpError("not_found");
    }
    return effective(createPrincipal(request).id, stored);
  });

  app.put<{ Params: { id: string } }>(
    "/api/sessions/:id/capabilities",
    { ...owned, bodyLimit: CAPABILITIES_BODY_LIMIT },
    async (request) => {
      const ownerId = createPrincipal(request).id;
      const patch = parsePutBody(request.body, experts, ownerId);
      // Archive read and the write share one synchronous segment: no await in between.
      if (dependencies.metadata.archivedAt(request.params.id, ownerId) !== null) {
        throw new HttpError("session_archived");
      }
      return effective(ownerId, patchSessionCapabilities(db, request.params.id, patch));
    },
  );
}

/**
 * A non-empty plain object whose keys ⊆ `{expertId, disabledSkills, disabledConnectors}`, every value
 * judged here.
 */
function parsePutBody(body: unknown, experts: ExpertReader, ownerId: string): CapabilitiesPatch {
  if (!isPlainObject(body)) {
    throw new HttpError("bad_request");
  }
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => !PUT_KEYS.has(key))) {
    throw new HttpError("bad_request");
  }
  const patch: CapabilitiesPatch = {};
  if (Object.hasOwn(body, "disabledSkills")) {
    patch.disabledSkills = requireDisabledSkills(body.disabledSkills);
  }
  if (Object.hasOwn(body, "disabledConnectors")) {
    patch.disabledConnectors = normalizeConnectorNames(body.disabledConnectors);
  }
  if (Object.hasOwn(body, "expertId")) {
    const id = body.expertId;
    if (id !== null && typeof id !== "string") {
      throw new HttpError("bad_request");
    }
    patch.expert = id === null ? null : requireVisibleExpert(experts, ownerId, id);
  }
  return patch;
}
