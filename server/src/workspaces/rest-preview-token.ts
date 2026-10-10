/**
 * `POST /api/workspaces/:id/preview-token`（preview-origin「预览令牌签发端点」）：主站上受 cookie
 * 鉴权的无请求体端点，为调用者自己的一个工作空间签发预览来源的令牌。次序固定为
 * 401（根守卫）→ 归属 404（先于 body 解析）→ 带 body 即 400 → 算预览来源 → 签发。
 * 不读写用户路径、不写审计、不写日志；令牌只出现在响应体里。
 */
import type { FastifyInstance } from "fastify";
import { HttpError } from "../core/errors/index.js";
import {
  currentPrincipal,
  ensureOwnedRoot,
  noStoreWorkspaceResponse,
  type WorkspaceRestDependencies,
} from "./rest.js";

export interface WorkspacePreviewDependencies {
  /** 预览令牌登记表；结构类型，workspaces 不依赖 preview 模块。 */
  tokens: {
    issue(
      binding: { ownerId: string; workspaceId: string; embedOrigin: string | null },
      now: number,
    ): { token: string; expiresAt: number };
  };
  /** 预览监听器实际绑定的端口；监听器绑定之后才有值，所以每次请求现取。 */
  port: () => number;
  /** 对外的预览来源（PREVIEW_ORIGIN）；有它时原样使用，不看请求的主机名。 */
  origin?: string;
  documentMaxBytes: number;
  officeAvailable: boolean;
}

/** Fastify 拒绝 bodyLimit 0（须 >0），故取最小合法值；handler 的显式 no-body 校验负责 0 字节合同。 */
const BODYLESS_BODY_LIMIT = 1;

/**
 * 预览来源：配置了就原样用；否则是本次请求的协议、`Host` 头里的主机名（不含端口，IPv6 字面量
 * 保留方括号）与预览端口。没有 `Host` 或拼不出一个 URL 时拒绝，不签发指向不了任何地方的令牌。
 */
function previewOriginOf(
  preview: WorkspacePreviewDependencies,
  request: { protocol: string; hostname: string },
): string {
  if (preview.origin !== undefined) {
    return preview.origin;
  }
  const origin = `${request.protocol}://${request.hostname}:${preview.port()}`;
  if (!URL.canParse(origin)) {
    throw new HttpError("bad_request");
  }
  return origin;
}

export function registerWorkspacePreviewToken(
  app: FastifyInstance,
  dependencies: WorkspaceRestDependencies,
  preview: WorkspacePreviewDependencies,
): void {
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/preview-token",
    {
      bodyLimit: BODYLESS_BODY_LIMIT,
      onRequest: noStoreWorkspaceResponse,
      // 他人的、不存在的 id 与根目录不在的空间是同一个 404，先于 body 解析。
      preParsing: (request, _reply, payload, done) => {
        ensureOwnedRoot(dependencies, currentPrincipal(request), request.params.id);
        done(null, payload);
      },
    },
    async (request) => {
      if (request.body !== undefined) {
        throw new HttpError("bad_request");
      }
      const origin = previewOriginOf(preview, request);
      // `Origin` 原样登记，不校验也不规范化：它只在预览监听器写响应头时才被检查。
      const { token, expiresAt } = preview.tokens.issue(
        {
          ownerId: currentPrincipal(request).id,
          workspaceId: request.params.id,
          embedOrigin: request.headers.origin ?? null,
        },
        Date.now(),
      );
      return {
        token,
        base: `${origin}/w/${token}/`,
        officeBase: `${origin}/o/${token}/`,
        expiresAt,
        documentMaxBytes: preview.documentMaxBytes,
        officeAvailable: preview.officeAvailable,
      };
    },
  );
}
