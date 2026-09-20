/**
 * core/sandbox — 沙箱 facade：root 查找、路径解析与拒绝审计。
 */
import type { emit as canonicalEmit } from "../audit/index.js";
import { HttpError } from "../errors/index.js";
import { ensureSharedDir } from "./dirs.js";
import { resolve as resolvePath } from "./resolve.js";

interface SandboxPrincipal {
  id: string;
}

type BoundEmit<F> = F extends (db: never, event: infer Event) => infer Result
  ? (event: Event) => Result
  : never;

export function createSandbox({
  rootOf,
  audit,
}: {
  rootOf: (principal: SandboxPrincipal, workspaceId: string) => string | null;
  audit: { emit: BoundEmit<typeof canonicalEmit> };
}) {
  return {
    resolve(
      principal: SandboxPrincipal,
      workspaceId: string,
      relPath: string,
      op: "read" | "list" | "mkdir",
    ): string {
      const root = rootOf(principal, workspaceId);
      if (root === null) {
        throw new HttpError("not_found");
      }
      const result = resolvePath(root, relPath, op);
      if (result.ok) {
        return result.absPath;
      }
      audit.emit({
        kind: "sandbox.reject",
        actorId: principal.id,
        workspaceId,
        title: "越界访问被沙箱拦截",
        detail: { relPath, op, reason: result.reason },
      });
      throw new HttpError("sandbox_denied");
    },
    ensureSharedDir,
  };
}
