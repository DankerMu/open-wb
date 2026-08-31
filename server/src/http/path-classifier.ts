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
  const isApiNamespace = isApiPathname(pathname);
  return {
    pathname,
    decodePasses,
    isApiNamespace,
    isUnsafe: (!isApiNamespace && decodePasses > 1) || isUnsafePathname(pathname),
  };
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
