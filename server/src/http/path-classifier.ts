import type { FastifyRequest } from "fastify";

export const MAX_PERCENT_DECODE_PASSES = 4;

export interface PathnameClassification {
  readonly pathname: string | undefined;
  readonly decodePasses: number;
  readonly isApiNamespace: boolean;
  readonly isUnsafe: boolean;
}

/**
 * 将 unsafe 或编码后的 API namespace 重写到统一 API 404；安全的一轮非 API
 * 编码路径也在此处规范化，使路由与后续静态文件消费同一个 pathname identity。
 */
export function rewriteUntrustedUrl(url: string): string {
  const { pathname, query } = splitUrl(url);
  const classification = classifyUrlPathname(pathname);
  const encodedApiNamespace = classification.isApiNamespace && classification.decodePasses > 0;

  if (classification.isUnsafe || encodedApiNamespace) {
    return `/api/__workbuddy_not_found__${query}`;
  }

  if (classification.decodePasses === 1 && classification.pathname !== undefined) {
    return `${classification.pathname}${query}`;
  }

  return url;
}

export function classifyRequestPath(request: FastifyRequest): PathnameClassification {
  return classifyUrlPathname(splitUrl(request.raw.url ?? "").pathname);
}

/**
 * 守卫唯一可用的原始身份入口：`rewriteUrl` 之后 `raw.url` 已被替换，只有
 * `originalUrl` 保留 rewrite 前的 pathname，故 API namespace 判定必须走这里。
 */
export function classifyOriginalUrl(originalUrl: string): PathnameClassification {
  return classifyUrlPathname(splitUrl(originalUrl).pathname);
}

/** Internal bounded-decoding seam for HTTP assembly tests. */
export function classifyUrlPathname(pathname: string): PathnameClassification {
  let decodedPathname = pathname;
  let decodePasses = 0;

  try {
    while (decodePasses < MAX_PERCENT_DECODE_PASSES) {
      const nextPathname = decodeURIComponent(decodedPathname);
      if (nextPathname === decodedPathname) {
        return classifyDecodedPathname(decodedPathname, decodePasses);
      }

      decodedPathname = nextPathname;
      decodePasses += 1;
    }

    if (decodeURIComponent(decodedPathname) !== decodedPathname) {
      return failClosedClassification(decodePasses);
    }
  } catch {
    return failClosedClassification(decodePasses);
  }

  return classifyDecodedPathname(decodedPathname, decodePasses);
}

function splitUrl(url: string): { pathname: string; query: string } {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1
    ? { pathname: url, query: "" }
    : { pathname: url.slice(0, queryIndex), query: url.slice(queryIndex) };
}

function classifyDecodedPathname(pathname: string, decodePasses: number): PathnameClassification {
  const isApiNamespace = isApiPathname(routedPathnameOf(pathname));
  return {
    pathname,
    decodePasses,
    isApiNamespace,
    isUnsafe: (!isApiNamespace && decodePasses > 1) || isUnsafePathname(pathname),
  };
}

/**
 * 有界解码可能在 pathname 中引入路由分隔符：`%3F` 解出的 `?` 对 rewrite 与 Fastify router
 * 就是 query 起点，因此 API namespace 身份只看第一个 decoded `?` 之前的 routed pathname，
 * 否则 classifier 会把 `/api%3Fx=1` 判成 non-API，而请求实际路由到 exact `/api`。
 * canonical `pathname` 输出、unsafe 与 decode-pass 判定仍消费完整解码值，使 rewrite、
 * 静态与 fallback 保持同一身份。`#` 在受支持的 Node HTTP 栈上不是分隔符，不在此扩大处理。
 */
function routedPathnameOf(decodedPathname: string): string {
  const queryIndex = decodedPathname.indexOf("?");
  return queryIndex === -1 ? decodedPathname : decodedPathname.slice(0, queryIndex);
}

function unsafeClassification(
  pathname: string | undefined,
  decodePasses: number,
): PathnameClassification {
  return {
    pathname,
    decodePasses,
    isApiNamespace: false,
    isUnsafe: true,
  };
}

function failClosedClassification(decodePasses: number): PathnameClassification {
  return unsafeClassification(undefined, decodePasses);
}

function isApiPathname(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/api\\");
}

function isUnsafePathname(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0")) {
    return true;
  }

  if (pathname === "/") {
    return false;
  }

  const segments = pathname.split("/");
  return segments.some(
    (segment, index) =>
      index > 0 && (segment.startsWith(".") || (segment === "" && index !== segments.length - 1)),
  );
}
