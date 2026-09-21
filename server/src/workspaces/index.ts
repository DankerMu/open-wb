import type { FastifyInstance } from "fastify";
import { registerWorkspaceRest, type WorkspaceRestDependencies } from "./rest.js";

export function registerWorkspaces(
  app: FastifyInstance,
  dependencies: WorkspaceRestDependencies,
): void {
  registerWorkspaceRest(app, dependencies);
}
