import type { FastifyInstance } from "fastify";
import { type MountRestDependencies, registerMountSources } from "./mounts/rest.js";
import { registerMounts } from "./mounts/rest-mounts.js";
import { registerWorkspaceRest, type WorkspaceRestDependencies } from "./rest.js";
import { registerWorkspaceArchive } from "./rest-archive.js";
import { registerWorkspaceEntries } from "./rest-entries.js";
import {
  registerWorkspacePreviewToken,
  type WorkspacePreviewDependencies,
} from "./rest-preview-token.js";

/** The workspace routes' dependencies plus the mount routes' (s1b-workspace-mounts D14). */
export type WorkspacesDependencies = WorkspaceRestDependencies & { mounts: MountRestDependencies };

/** `preview` 缺省时不注册 `preview-token` 路由（该路径落到 catch-all 的 404）。 */
export function registerWorkspaces(
  app: FastifyInstance,
  dependencies: WorkspacesDependencies,
  preview?: WorkspacePreviewDependencies,
): void {
  registerWorkspaceRest(app, dependencies);
  registerWorkspaceEntries(app, dependencies);
  registerWorkspaceArchive(app, dependencies);
  if (preview !== undefined) {
    registerWorkspacePreviewToken(app, dependencies, preview);
  }
  registerMountSources(app, dependencies.mounts);
  registerMounts(app, dependencies.mounts, dependencies.store);
}
