import type { FastifyInstance } from "fastify";
import { registerWorkspaceRest, type WorkspaceRestDependencies } from "./rest.js";
import { registerWorkspaceEntries } from "./rest-entries.js";
import {
  registerWorkspacePreviewToken,
  type WorkspacePreviewDependencies,
} from "./rest-preview-token.js";

/** `preview` 缺省时不注册 `preview-token` 路由（该路径落到 catch-all 的 404）。 */
export function registerWorkspaces(
  app: FastifyInstance,
  dependencies: WorkspaceRestDependencies,
  preview?: WorkspacePreviewDependencies,
): void {
  registerWorkspaceRest(app, dependencies);
  registerWorkspaceEntries(app, dependencies);
  if (preview !== undefined) {
    registerWorkspacePreviewToken(app, dependencies, preview);
  }
}
