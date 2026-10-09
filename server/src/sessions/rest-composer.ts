/**
 * `GET /api/composer/options` (#1008, s1g design D3/D4/D7/D9/D10): what the composer of the caller
 * may choose from — the approval modes up to the configured ceiling, the model whitelist with each
 * model's selectable efforts and default effort, the two upload limits — and the caller's defaults,
 * its last choice (`account_composer_prefs`) resolved to effective values. The configuration is
 * handed down by the assembly; the last-choice row is the route's only SQLite read, and no session
 * or process is touched. Not a content-parser owner. The query probe runs in the handler, after the
 * root preParsing guard, so an unauthenticated request carrying one is still 401.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../core/errors/index.js";
import {
  APPROVAL_MODES,
  defaultEffort,
  effectiveComposer,
  selectableEfforts,
} from "../model-catalog.js";
import { currentPrincipal, noStoreSessionHeaders } from "./rest.js";
import { type ComposerConfig, rawComposer, readComposerPrefs } from "./store-composer.js";

interface ComposerRouteDependencies {
  db: DatabaseSync;
  composer: ComposerConfig;
  /** The effective `UPLOAD_MAX_BYTES` and `UPLOAD_MAX_FILES`. */
  upload: { maxBytes: number; maxFiles: number };
}

export function registerComposerRoutes(
  app: FastifyInstance,
  dependencies: ComposerRouteDependencies,
): void {
  const { db, composer, upload } = dependencies;
  app.get("/api/composer/options", { onRequest: noStoreSessionHeaders }, async (request, reply) => {
    const principal = currentPrincipal(request);
    // The route takes no query parameter: any query string, an empty one included, is refused.
    // `raw.url` keeps it through `rewriteUrl`.
    if ((request.raw.url ?? "").includes("?")) {
      throw new HttpError("bad_request");
    }
    const defaults = effectiveComposer(rawComposer(readComposerPrefs(db, principal.id)), composer);
    // Every object is written key by key, in the spec's order: a catalog model is never spread —
    // its `efforts` is the declared set (no `off`, absent on a model without reasoning).
    return reply.code(200).send({
      approvalModes: APPROVAL_MODES.slice(0, APPROVAL_MODES.indexOf(composer.approvalMaxMode) + 1),
      models: composer.modelCatalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        vision: model.vision,
        efforts: selectableEfforts(model),
        defaultEffort: defaultEffort(model),
      })),
      defaults: {
        approvalMode: defaults.approvalMode,
        modelId: defaults.modelId,
        reasoningEffort: defaults.reasoningEffort,
      },
      upload: { maxBytes: upload.maxBytes, maxFiles: upload.maxFiles },
    });
  });
}
