import { lstatSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import fastifyStatic from "@fastify/static";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { handleHttpError, rewriteUntrustedUrl, sendHttpError } from "./http/index.js";
import { classifyRequestPath } from "./http/path-classifier.js";
import { SERVICE_INFO } from "./service-info.js";

declare module "fastify" {
  interface FastifyInstance {
    db: DatabaseSync;
  }
}

export interface CreateAppOptions {
  db: DatabaseSync;
  staticRoot?: string;
}

/**
 * 装配可注入的 HTTP app。调用方拥有 db 的完整生命周期；本函数不监听也不关闭它。
 */
export function createApp({ db, staticRoot }: CreateAppOptions): FastifyInstance {
  const app = fastify({
    logger: false,
    rewriteUrl: (request) => rewriteUntrustedUrl(request.url ?? ""),
  });
  const staticFiles = inspectStaticRoot(staticRoot);

  app.decorate("db", db);
  app.setErrorHandler((error, _request, reply) => handleHttpError(error, reply));

  app.all("/api", (request, reply) => sendNotFound(reply, request));
  app.get("/api/healthz", () => ({ status: "ok" }));
  app.get("/api/info", () => SERVICE_INFO);
  app.all("/api/*", (request, reply) => sendNotFound(reply, request));

  if (staticFiles !== undefined) {
    app.register(fastifyStatic, {
      root: staticFiles.root,
      serve: false,
      dotfiles: "deny",
    });

    app.get("/*", (request, reply) => {
      const classification = classifyRequestPath(request);
      if (request.method !== "GET" || classification.isApiNamespace || classification.isUnsafe) {
        return sendNotFound(reply, request);
      }

      const pathname = staticPathname(classification.pathname);
      if (pathname === undefined || isStaticSymlink(pathname, staticFiles.root)) {
        return sendNotFound(reply, request);
      }
      if (pathname === "") {
        return sendSpaFallback(reply, staticFiles);
      }

      const exists = isRegularFile(join(staticFiles.root, pathname));
      return exists
        ? reply.sendFile(`/${pathname}`, staticFiles.root)
        : sendSpaFallback(reply, staticFiles);
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const classification = classifyRequestPath(request);
    if (classification.isApiNamespace || classification.isUnsafe || request.method !== "GET") {
      return sendNotFound(reply, request);
    }

    const pathname = staticPathname(classification.pathname);
    if (
      staticFiles?.indexFilename !== undefined &&
      pathname !== undefined &&
      !isStaticSymlink(pathname, staticFiles.root)
    ) {
      return sendSpaFallback(reply, staticFiles);
    }

    return sendNotFound(reply, request);
  });

  return app;
}

interface StaticFiles {
  root: string;
  indexFilename?: string;
}

function staticPathname(pathname: string | undefined): string | undefined {
  return pathname?.slice(1);
}

function sendSpaFallback(reply: FastifyReply, staticFiles: StaticFiles): FastifyReply {
  if (staticFiles.indexFilename === undefined) {
    return sendHttpError(reply, "not_found");
  }

  return reply
    .type("text/html; charset=utf-8")
    .sendFile(`/${staticFiles.indexFilename}`, staticFiles.root);
}

function inspectStaticRoot(staticRoot: string | undefined): StaticFiles | undefined {
  if (staticRoot === undefined) {
    return undefined;
  }

  const root = resolve(staticRoot);
  if (!isRegularDirectory(root)) {
    return undefined;
  }

  const indexPath = join(root, "index.html");
  return isRegularFile(indexPath) ? { root, indexFilename: "index.html" } : { root };
}

function isRegularDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isStaticSymlink(pathname: string | undefined, root: string): boolean {
  return pathname === undefined || hasStaticSymlink(pathname, root);
}

function hasStaticSymlink(pathname: string, root: string): boolean {
  let currentPath = root;

  try {
    for (const segment of pathname.split("/")) {
      if (segment === "") {
        continue;
      }

      currentPath = join(currentPath, segment);
      const entry = lstatSync(currentPath, { throwIfNoEntry: false });
      if (entry === undefined) {
        return false;
      }
      if (entry.isSymbolicLink()) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}

function sendNotFound(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  if (request.method === "HEAD") {
    return reply.code(404).send();
  }

  return sendHttpError(reply, "not_found");
}
