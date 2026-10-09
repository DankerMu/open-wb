import type { FastifyInstance } from "fastify";
import { registerWorkspaceRest, type WorkspaceRestDependencies } from "./rest.js";
import { registerWorkspaceEntries } from "./rest-entries.js";

export function registerWorkspaces(
  app: FastifyInstance,
  dependencies: WorkspaceRestDependencies,
): void {
  registerWorkspaceRest(app, dependencies);
  registerWorkspaceEntries(app, dependencies);
}
