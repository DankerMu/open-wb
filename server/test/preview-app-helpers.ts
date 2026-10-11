/**
 * Issue #1069: the world the preview listener's tests run in. A real main app (`createApp`, real
 * SQLite, real directories) issues tokens over `POST /api/workspaces/:id/preview-token`; the
 * preview listener is the real `createPreviewApp` on the same database handle with its own
 * workspace store and sandbox facade, bound to a loopback port for the cases only a socket shows.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createSandbox } from "../src/core/sandbox/index.js";
import { createPreviewApp } from "../src/preview/app.js";
import { OfficeConvertError, type OfficeConverter } from "../src/preview/office.js";
import { createPreviewTokens, type PreviewTokens } from "../src/preview/tokens.js";
import { createWorkspaceStore } from "../src/workspaces/store.js";
import { rawHttpRequest, withListeningApp } from "./raw-http-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import { insertWorkspace, withWorkspacesApp } from "./workspaces-http-helpers.js";

export const ZHANGSAN = "u1";
export const LISI = "u3";
/** zhangsan's workspace the token `T` of every scenario is issued for. */
export const WORKSPACE_A = "a".repeat(32);
export const WORKSPACE_B = "b".repeat(32);
export const LISI_WORKSPACE = "c".repeat(32);
/** The main site in the spec's scenarios. */
export const MAIN_ORIGIN = "http://127.0.0.1:3000";
const MAIN_HOST = "127.0.0.1:3000";
export const NOT_FOUND_TEXT = "预览不存在或已过期";
export const DENIED_TEXT = "路径不在工作空间内";
/** preview-origin 「预览响应头与内容类型」: all a failure carries besides what the transport adds. */
export const FAILURE_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};
/** Bytes that are not valid UTF-8: equality on them is equality of bytes, not of decoded text. */
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
export const README_TEXT = "# 读我\n";
/** What lies outside workspace A and must never leave through a token for A. */
export const OUTSIDE_SECRET = "outside-secret-bytes";

/** The default of `PREVIEW_DOCUMENT_MAX_BYTES`: what the token response and `/o/` both go by. */
export const DOCUMENT_MAX_BYTES = 104_857_600;

/**
 * The converter of a listener whose test is not about `/o/` (#1074 made it a required dependency):
 * the feature is off, and a `convert` that is reached anyway fails the way the real one does.
 */
export function unavailableConverter(): OfficeConverter {
  return {
    available: false,
    convert: () => Promise.reject(new OfficeConvertError("unavailable")),
    close: () => Promise.resolve(),
  };
}

type Binding = Parameters<PreviewTokens["issue"]>[0];

/** One response, whichever transport brought it. */
export interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PreviewWorld {
  /** The main site: logs in and issues tokens, nothing else. */
  main: FastifyInstance;
  preview: FastifyInstance;
  /** Where the preview listener is bound. */
  origin: string;
  db: DatabaseSync;
  sandboxRoot: string;
  /** The root directory of workspace A. */
  root: string;
  /** The real registry behind both apps. */
  registry: PreviewTokens;
  /** Every `issue` call either app made, in order. */
  issueCalls: Array<{ binding: Binding; now: number }>;
  zhangsan: string;
  lisi: string;
  /** Issues over the main site's route; `embedOrigin` is the request's `Origin` header. */
  issueToken(
    cookie: string,
    workspaceId: string,
    embedOrigin?: string | null,
  ): Promise<{ token: string; expiresAt: number }>;
}

interface PreviewWorldOptions {
  listenerCloseBudgetMs?: number;
  onListenerForceClose?: () => void;
  /** Runs on the preview app before it listens (test-only hooks). */
  beforeListen?: (preview: FastifyInstance, root: string) => void;
  /** `/o/`'s converter; the unavailable stand-in when omitted. */
  converter?: OfficeConverter;
  /** `/o/`'s document limit; the configured default when omitted. */
  documentMaxBytes?: number;
  /** Whether `/o/` may start a conversion yet; always, when omitted. */
  officeReady?: () => boolean;
}

/**
 * zhangsan's workspaces A (`files`) and B (`other`) and lisi's `own`, with the files the spec's
 * scenarios name, and the preview listener bound to a loopback port.
 */
export async function withPreviewWorld(
  action: (world: PreviewWorld) => Promise<void>,
  options: PreviewWorldOptions = {},
): Promise<void> {
  const registry = createPreviewTokens();
  const issueCalls: PreviewWorld["issueCalls"] = [];
  // One recording wrapper for both apps: a listener that renewed would show up in `issueCalls`.
  const tokens: PreviewTokens = {
    issue(binding, now) {
      issueCalls.push({ binding: { ...binding }, now });
      return registry.issue(binding, now);
    },
    lookup: (token, now) => registry.lookup(token, now),
  };
  await withWorkspacesApp(
    async ({ app: main, db, sandboxRoot }) => {
      const root = seedFiles(db, sandboxRoot);
      const zhangsan = await cookieFor(main, "zhangsan");
      const lisi = await cookieFor(main, "lisi");
      const store = createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit });
      const sandbox = createSandbox({
        rootOf: store.rootOf,
        audit: { emit: (event) => emit(db, event) },
      });
      const preview = createPreviewApp({
        store,
        sandbox,
        tokens,
        converter: options.converter ?? unavailableConverter(),
        limits: { documentMaxBytes: options.documentMaxBytes ?? DOCUMENT_MAX_BYTES },
        ...(options.officeReady === undefined ? {} : { officeReady: options.officeReady }),
        ...(options.listenerCloseBudgetMs === undefined
          ? {}
          : { listenerCloseBudgetMs: options.listenerCloseBudgetMs }),
        ...(options.onListenerForceClose === undefined
          ? {}
          : { onListenerForceClose: options.onListenerForceClose }),
      });
      options.beforeListen?.(preview, root);
      await withListeningApp(preview, (origin) =>
        action({
          main,
          preview,
          origin,
          db,
          sandboxRoot,
          root,
          registry,
          issueCalls,
          zhangsan,
          lisi,
          issueToken: (cookie, workspaceId, embedOrigin = MAIN_ORIGIN) =>
            issueOverMainSite(main, cookie, workspaceId, embedOrigin),
        }),
      );
    },
    undefined,
    {
      assembly: {
        preview: {
          tokens,
          port: () => 1,
          documentMaxBytes: DOCUMENT_MAX_BYTES,
          officeAvailable: false,
        },
      },
    },
  );
}

function seedFiles(db: DatabaseSync, sandboxRoot: string): string {
  const root = join(sandboxRoot, ZHANGSAN, "files");
  mkdirSync(join(root, "site", "img"), { recursive: true });
  insertWorkspace(db, WORKSPACE_A, ZHANGSAN, "files", "files", 1);
  writeFileSync(join(root, "readme.md"), README_TEXT);
  writeFileSync(
    join(root, "site", "index.html"),
    '<!doctype html><link rel="stylesheet" href="./style.css"><img src="img/a.png">',
  );
  writeFileSync(join(root, "site", "style.css"), "body { color: red; }\n");
  writeFileSync(join(root, "site", "img", "a.png"), PNG_BYTES);
  // Outside A, inside the sandbox root: reachable only by leaving the workspace.
  writeFileSync(join(sandboxRoot, "secret.txt"), OUTSIDE_SECRET);
  mkdirSync(join(sandboxRoot, "outer"));
  writeFileSync(join(sandboxRoot, "outer", "x"), OUTSIDE_SECRET);
  symlinkSync(join(sandboxRoot, "secret.txt"), join(root, "link"));
  symlinkSync(join(sandboxRoot, "outer"), join(root, "linkdir"));

  const other = join(sandboxRoot, ZHANGSAN, "other");
  mkdirSync(other, { recursive: true });
  insertWorkspace(db, WORKSPACE_B, ZHANGSAN, "other", "other", 2);
  writeFileSync(join(other, "only-b.txt"), "B 的文件");
  const own = join(sandboxRoot, LISI, "own");
  mkdirSync(own, { recursive: true });
  insertWorkspace(db, LISI_WORKSPACE, LISI, "own", "own", 3);
  writeFileSync(join(own, "only-b.txt"), "lisi 的文件");
  return root;
}

async function issueOverMainSite(
  main: FastifyInstance,
  cookie: string,
  workspaceId: string,
  embedOrigin: string | null,
): Promise<{ token: string; expiresAt: number }> {
  const response = await main.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/preview-token`,
    headers: {
      cookie,
      host: MAIN_HOST,
      ...(embedOrigin === null ? {} : { origin: embedOrigin }),
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { token: string; expiresAt: number };
}

export function fromInject(response: LightMyRequestResponse): Answer {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    headers[name] = String(value);
  }
  return { status: response.statusCode, headers, body: response.payload };
}

/**
 * One request over a real socket, the target written to the wire as given: `inject` and `fetch`
 * both run it through a URL parser that folds `%2e%2e` away before the server sees it.
 */
export async function rawAnswer(
  origin: string,
  target: string,
  request: { method?: string; headers?: Record<string, string>; cookie?: string } = {},
): Promise<Answer> {
  const wire = await rawHttpRequest(origin, { target, ...request });
  const split = wire.indexOf("\r\n\r\n");
  const [statusLine = "", ...headerLines] = wire.slice(0, split).split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(statusLine.split(" ")[1]), headers, body: wire.slice(split + 4) };
}

/**
 * A 404 or 403 of the listener: the fixed text and nothing else in the body, the four failure
 * headers, and none of the headers a success carries — no cookie either.
 */
export function expectFixedFailure(answer: Answer, status: 403 | 404): void {
  const text = status === 404 ? NOT_FOUND_TEXT : DENIED_TEXT;
  expect(answer.status).toBe(status);
  expect(answer.body).toBe(text);
  expect(answer.headers).toMatchObject(FAILURE_HEADERS);
  expect(answer.headers["content-length"]).toBe(String(Buffer.byteLength(text)));
  expectNoSuccessHeaders(answer);
}

export function expectNoSuccessHeaders(answer: Answer): void {
  for (const name of [
    "access-control-allow-origin",
    "cross-origin-resource-policy",
    "content-security-policy",
    "content-range",
    "accept-ranges",
    "set-cookie",
  ]) {
    expect(answer.headers[name], name).toBeUndefined();
  }
}

/** Every `sandbox.reject` row in order: who, where, what was asked. */
export function rejectRows(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      "SELECT actor_id, workspace_id, json_extract(detail, '$.op') AS op, json_extract(detail, '$.relPath') AS rel_path FROM audit_events WHERE kind = 'sandbox.reject' ORDER BY id",
    )
    .all()
    .map((row) => ({ ...row }));
}
