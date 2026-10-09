/**
 * Issue #1015 (s1g-composer-capabilities task 11.2): `POST /api/workspaces/:id/uploads` — spec
 * workspaces「文件上传」 scenarios 「上传并自动建目录」「临时空间同样可上传，并随最后一个会话删除」「同名自动编号不覆盖」
 * 「超过大小上限」「越界名字被拒绝并入审计」「名字规则与媒体类型」「他人与不存在的空间」「目录被占与审计失败」, the real-route half of
 * http-service-skeleton 「上传路由的 parser 归属」 (wrong media type 400, another owner's space 404
 * before the media type is looked at, anonymous 401, over the limit 413 and not 400), and the
 * `uploadMaxBytes` wiring. 「中断与残留清理」 and 「不进内存的流式写入」 are in workspace-upload-stream.test.ts.
 *
 * Production createApp on a loopback port, real SQLite, real directories; uploads over a real
 * socket (workspace-upload-helpers.ts). Oracles: the spec's literals, `GET /api/audit`, the file
 * system.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { constants } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { appAssemblyOf, resolveServerConfig } from "../src/server.js";
import {
  BAD_REQUEST_ENVELOPE,
  INTERNAL_ERROR_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
import { removeTempDirs, tempDir } from "./core-db-helpers.js";
import { expectDeleted, sendDelete } from "./session-delete-helpers.js";
import {
  auditCount,
  auditOf,
  CONFLICT_ENVELOPE,
  chunkOf,
  createWorkspace,
  expectWire,
  OCTET_STREAM,
  SANDBOX_DENIED_ENVELOPE,
  send,
  UPLOAD_TOO_LARGE_ENVELOPE,
  type UploadWorld,
  upload,
  uploadsOf,
  type WireResponse,
  type Workspace,
  withUploadWorld,
} from "./workspace-upload-helpers.js";

afterEach(removeTempDirs);

const LIMIT = 1024;
const SMALL = { uploadMaxBytes: LIMIT };
const DEFAULT_LIMIT = 524_288_000;
const REJECT_TITLE = "上传被拒绝：文件超过大小上限";
const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;

function octet(length: number): Record<string, string> {
  return { "Content-Type": OCTET_STREAM, "Content-Length": String(length) };
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function created(response: WireResponse, name: string, size: number): void {
  expectWire(response, 201, { path: `uploads/${name}`, name, size });
}

/** The owner's audit events written by `action`, oldest first, without `id` and `ts`. */
async function auditedBy(world: UploadWorld, action: () => Promise<void>) {
  const seen = (await auditOf(world)).length;
  await action();
  return (await auditOf(world)).slice(seen).map(({ id: _id, ts: _ts, ...event }) => event);
}

function rejectEvent(workspace: Workspace, name: string, limit: number) {
  return {
    kind: "upload.reject",
    actorId: "u1",
    workspaceId: workspace.id,
    title: REJECT_TITLE,
    detail: { name, limit },
  };
}

/** `audit_events` refuses every INSERT while `action` runs. */
async function withAuditRefused(world: UploadWorld, action: () => Promise<void>): Promise<void> {
  world.db.setAuthorizer((code, table) =>
    code === constants.SQLITE_INSERT && table === "audit_events"
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  try {
    await action();
  } finally {
    world.db.setAuthorizer(null);
  }
}

async function createSession(world: UploadWorld, workspaceId?: string) {
  const response = await world.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: {
      cookie: world.owner,
      ...(workspaceId === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(workspaceId === undefined ? {} : { payload: JSON.stringify({ workspaceId }) }),
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; workspaceId: string };
}

describe("workspaces「文件上传」 — 上传并自动建目录", () => {
  it("writes the bytes under a new uploads directory and audits the upload", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "reports");
      expect(uploadsOf(w)).toBeNull();

      const events = await auditedBy(world, async () => {
        created(await upload(world, w.id, "报告.pdf", "pdf"), "报告.pdf", 3);
      });

      expect(modeOf(join(w.root, "uploads"))).toBe(0o2770);
      expect(lstatSync(join(w.root, "uploads")).isDirectory()).toBe(true);
      expect(uploadsOf(w)).toEqual(["报告.pdf"]);
      const file = join(w.root, "uploads", "报告.pdf");
      expect(lstatSync(file).isFile()).toBe(true);
      expect(modeOf(file)).toBe(0o660);
      expect(readFileSync(file, "utf8")).toBe("pdf");
      // Exactly one event: the upload, and no `dir.create` for the directory it made.
      expect(events).toEqual([
        {
          kind: "file.upload",
          actorId: "u1",
          workspaceId: w.id,
          title: "上传文件 uploads/报告.pdf",
          detail: { path: "uploads/报告.pdf", size: 3 },
        },
      ]);
      const tree = await world.app.inject({
        method: "GET",
        url: `/api/workspaces/${w.id}/tree?path=uploads`,
        headers: { cookie: world.owner },
      });
      expect(tree.statusCode).toBe(200);
      expect((tree.json() as { entries: unknown[] }).entries).toEqual([
        expect.objectContaining({ name: "报告.pdf", type: "file", size: 3 }),
      ]);
    });
  });

  it("accepts an empty file, a media type parameter and query keys it does not know", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "reports");

      created(await upload(world, w.id, "empty.bin", ""), "empty.bin", 0);
      const parameterised = await send(world, {
        workspaceId: w.id,
        query: "name=p.bin&unknown=1",
        cookie: world.owner,
        headers: { "Content-Type": `${OCTET_STREAM}; x=1`, "Content-Length": "2" },
        body: Buffer.from("ab"),
      });

      created(parameterised, "p.bin", 2);
      expect(readFileSync(join(w.root, "uploads", "empty.bin"))).toHaveLength(0);
      expect(readFileSync(join(w.root, "uploads", "p.bin"), "utf8")).toBe("ab");
    });
  });
});

describe("workspaces「文件上传」 — 临时空间同样可上传，并随最后一个会话删除", () => {
  it("uploads into the owner's temporary workspace, refuses another account, and the file goes with the last session", async () => {
    await withUploadWorld(async (world) => {
      const session = await createSession(world);
      const temporary: Workspace = {
        id: session.workspaceId,
        root: join(world.sandboxRoot, "u1", `tmp-${session.workspaceId}`),
      };

      const events = await auditedBy(world, async () => {
        created(await upload(world, temporary.id, "a.txt", "one"), "a.txt", 3);
      });
      const foreign = await upload(world, temporary.id, "a.txt", "two", world.other);

      expect(events).toEqual([expect.objectContaining({ kind: "file.upload" })]);
      expect(events[0]?.workspaceId).toBe(temporary.id);
      expectWire(foreign, 404, NOT_FOUND_ENVELOPE);
      expect(uploadsOf(temporary)).toEqual(["a.txt"]);
      expect(readFileSync(join(temporary.root, "uploads", "a.txt"), "utf8")).toBe("one");
      expect(existsSync(join(world.sandboxRoot, "u2"))).toBe(false);

      expectDeleted(await sendDelete(world.app, session.id, world.owner));
      expect(existsSync(temporary.root)).toBe(false);
    });
  });

  it("keeps the file of an ordinary workspace when a session bound to it is deleted", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "kept");
      created(await upload(world, w.id, "a.txt", "one"), "a.txt", 3);
      const session = await createSession(world, w.id);
      expect(session.workspaceId).toBe(w.id);

      expectDeleted(await sendDelete(world.app, session.id, world.owner));

      expect(readFileSync(join(w.root, "uploads", "a.txt"), "utf8")).toBe("one");
    });
  });
});

describe("workspaces「文件上传」 — 同名自动编号不覆盖", () => {
  it("numbers a taken name before its last extension and leaves earlier files alone", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "names");
      const expected = [
        ["a.pdf", "a.pdf"],
        ["a.pdf", "a (1).pdf"],
        ["a.pdf", "a (2).pdf"],
        ["README", "README"],
        ["README", "README (1)"],
        [".env", ".env"],
        [".env", ".env (1)"],
        ["archive.tar.gz", "archive.tar.gz"],
        ["archive.tar.gz", "archive.tar (1).gz"],
      ] as const;

      for (const [index, [given, final]] of expected.entries()) {
        const content = `content ${String(index)}`;
        created(await upload(world, w.id, given, content), final, content.length);
      }

      expect(uploadsOf(w)).toEqual(expected.map(([, final]) => final).sort());
      for (const [index, [, final]] of expected.entries()) {
        expect(readFileSync(join(w.root, "uploads", final), "utf8")).toBe(
          `content ${String(index)}`,
        );
      }
    });
  });

  it("gives two simultaneous uploads of one name a name each, both complete", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "names");
      const first = "first ".repeat(2_000);
      const second = "second ".repeat(2_000);

      const responses = await Promise.all([
        upload(world, w.id, "b.txt", first),
        upload(world, w.id, "b.txt", second),
      ]);

      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      const names = responses.map(
        (response) => (JSON.parse(response.body) as { name: string }).name,
      );
      expect([...names].sort()).toEqual(["b (1).txt", "b.txt"]);
      expect(uploadsOf(w)).toEqual(["b (1).txt", "b.txt"]);
      expect(readFileSync(join(w.root, "uploads", names[0] ?? ""), "utf8")).toBe(first);
      expect(readFileSync(join(w.root, "uploads", names[1] ?? ""), "utf8")).toBe(second);
    });
  });
});

describe("workspaces「文件上传」 — 超过大小上限 (UPLOAD_MAX_BYTES=1024)", () => {
  it("answers a declared 1025 bytes with 413 without reading the body or making the directory", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "limits");
      let response: WireResponse | undefined;

      // Only the head is sent: an answer at all means the body was not waited for.
      const events = await auditedBy(world, async () => {
        response = await send(world, {
          workspaceId: w.id,
          query: "name=big.bin",
          cookie: world.owner,
          headers: octet(LIMIT + 1),
          keepAlive: true,
        });
      });

      expectWire(response as WireResponse, 413, UPLOAD_TOO_LARGE_ENVELOPE);
      expect(response?.closedByServer).toBe(true);
      expect(uploadsOf(w)).toBeNull();
      expect(events).toEqual([rejectEvent(w, "big.bin", LIMIT)]);
    }, SMALL);
  });

  it("stops a chunked 2000 bytes with 413, removes the temporary file and closes the connection", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "limits");
      let response: WireResponse | undefined;

      // No terminating chunk and no `Connection: close` of the client's: the server has to stop
      // reading and close on its own, within the client's 3 s bound.
      const events = await auditedBy(world, async () => {
        response = await send(world, {
          workspaceId: w.id,
          query: "name=stream.bin",
          cookie: world.owner,
          headers: { "Content-Type": OCTET_STREAM, "Transfer-Encoding": "chunked" },
          body: chunkOf(Buffer.alloc(2_000, 0x61)),
          keepAlive: true,
        });
      });

      expectWire(response as WireResponse, 413, UPLOAD_TOO_LARGE_ENVELOPE);
      expect(response?.closedByServer).toBe(true);
      expect(response?.headers.connection).toBe("close");
      expect(uploadsOf(w)).toEqual([]);
      expect(events).toEqual([rejectEvent(w, "stream.bin", LIMIT)]);
    }, SMALL);
  });

  it("accepts exactly 1024 bytes, declared or chunked", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "limits");
      const exact = Buffer.alloc(LIMIT, 0x62);

      created(await upload(world, w.id, "exact.bin", exact), "exact.bin", LIMIT);
      const chunked = await send(world, {
        workspaceId: w.id,
        query: "name=chunked.bin",
        cookie: world.owner,
        headers: { "Content-Type": OCTET_STREAM, "Transfer-Encoding": "chunked" },
        body: Buffer.concat([chunkOf(exact), Buffer.from("0\r\n\r\n")]),
      });

      created(chunked, "chunked.bin", LIMIT);
      expect(readFileSync(join(w.root, "uploads", "exact.bin")).equals(exact)).toBe(true);
      expect(readFileSync(join(w.root, "uploads", "chunked.bin")).equals(exact)).toBe(true);
    }, SMALL);
  });

  it("checks the name's presence before the declared size, and the declared size before the sandbox", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "limits");
      let nameless: WireResponse | undefined;
      let escaping: WireResponse | undefined;

      const events = await auditedBy(world, async () => {
        nameless = await send(world, {
          workspaceId: w.id,
          cookie: world.owner,
          headers: octet(LIMIT + 1),
        });
        escaping = await send(world, {
          workspaceId: w.id,
          query: "name=..%2F..%2Fetc%2Fpasswd",
          cookie: world.owner,
          headers: octet(LIMIT + 1),
        });
      });

      expectWire(nameless as WireResponse, 400, BAD_REQUEST_ENVELOPE);
      expectWire(escaping as WireResponse, 413, UPLOAD_TOO_LARGE_ENVELOPE);
      // The over-limit rejection only: no `sandbox.reject` for the name it never got to.
      expect(events).toEqual([rejectEvent(w, "../../etc/passwd", LIMIT)]);
    }, SMALL);
  });

  it("answers 500 when the rejection cannot be audited, declared or streamed", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "limits");
      const before = auditCount(world);

      await withAuditRefused(world, async () => {
        const declared = await send(world, {
          workspaceId: w.id,
          query: "name=big.bin",
          cookie: world.owner,
          headers: octet(LIMIT + 1),
        });
        const streamed = await send(world, {
          workspaceId: w.id,
          query: "name=stream.bin",
          cookie: world.owner,
          headers: { "Content-Type": OCTET_STREAM, "Transfer-Encoding": "chunked" },
          body: chunkOf(Buffer.alloc(2_000, 0x61)),
        });

        expectWire(declared, 500, INTERNAL_ERROR_ENVELOPE);
        expectWire(streamed, 500, INTERNAL_ERROR_ENVELOPE);
      });

      expect(uploadsOf(w)).toEqual([]);
      expect(auditCount(world)).toBe(before);
    }, SMALL);
  });
});

describe("workspaces「文件上传」 — 越界名字被拒绝并入审计", () => {
  it.each([
    ["a parent traversal", "..%2F..%2Fetc%2Fpasswd", "../../etc/passwd"],
    ["the parent itself", "..", ".."],
    ["a NUL byte", "a%00b.txt", "a\0b.txt"],
    ["a backslash", "a%5Cb.txt", "a\\b.txt"],
    ["the directory itself", ".", "."],
    ["a trailing slash", "a%2F", "a/"],
  ])("answers 403 with one sandbox.reject for %s", async (_label, encoded, name) => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "escape");
      let response: WireResponse | undefined;

      const events = await auditedBy(world, async () => {
        response = await send(world, {
          workspaceId: w.id,
          query: `name=${encoded}`,
          cookie: world.owner,
          headers: octet(3),
          body: Buffer.from("bad"),
        });
      });

      expectWire(response as WireResponse, 403, SANDBOX_DENIED_ENVELOPE);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "sandbox.reject",
        actorId: "u1",
        workspaceId: w.id,
        detail: { op: "write", relPath: `uploads/${name}` },
      });
      expect(uploadsOf(w)).toBeNull();
      // Where `uploads/../../etc/passwd` would land: beside the account roots.
      expect(readdirSync(world.sandboxRoot)).toEqual(["u1"]);
      expect(readdirSync(join(world.sandboxRoot, "u1"))).toEqual(["escape"]);
      expect(readdirSync(w.root)).toEqual([]);
    });
  });

  it("refuses an uploads directory that is a symbolic link out of the sandbox", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "escape");
      const outside = realpathSync(tempDir());
      symlinkSync(outside, join(w.root, "uploads"));
      let response: WireResponse | undefined;

      const events = await auditedBy(world, async () => {
        response = await upload(world, w.id, "a.txt", "bad");
      });

      expectWire(response as WireResponse, 403, SANDBOX_DENIED_ENVELOPE);
      expect(events).toEqual([
        expect.objectContaining({
          kind: "sandbox.reject",
          detail: expect.objectContaining({ op: "write", relPath: "uploads/a.txt" }),
        }),
      ]);
      expect(readdirSync(outside)).toEqual([]);
      expect(lstatSync(join(w.root, "uploads")).isSymbolicLink()).toBe(true);
    });
  });

  it("refuses a target that is a symbolic link and leaves what it points to alone", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "escape");
      const outside = realpathSync(tempDir());
      writeFileSync(join(outside, "target.txt"), "untouched");
      mkdirSync(join(w.root, "uploads"));
      symlinkSync(join(outside, "target.txt"), join(w.root, "uploads", "a.txt"));
      let response: WireResponse | undefined;

      const events = await auditedBy(world, async () => {
        response = await upload(world, w.id, "a.txt", "bad");
      });

      expectWire(response as WireResponse, 403, SANDBOX_DENIED_ENVELOPE);
      expect(events).toEqual([
        expect.objectContaining({
          kind: "sandbox.reject",
          detail: expect.objectContaining({ op: "write", relPath: "uploads/a.txt" }),
        }),
      ]);
      expect(readdirSync(outside)).toEqual(["target.txt"]);
      expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("untouched");
      // The link itself, no numbered sibling and no temporary file.
      expect(uploadsOf(w)).toEqual(["a.txt"]);
      expect(lstatSync(join(w.root, "uploads", "a.txt")).isSymbolicLink()).toBe(true);
    });
  });
});

describe("workspaces「文件上传」 — 名字规则与媒体类型", () => {
  const BAD_NAMES: ReadonlyArray<readonly [string, string | undefined]> = [
    ["no query at all", undefined],
    ["a query without name", "other=a.txt"],
    ["name given twice", "name=a.txt&name=b.txt"],
    ["an empty name", "name="],
    ["a 256-byte name", `name=${"a".repeat(256)}`],
    ["86 Chinese characters (258 bytes)", `name=${encodeURIComponent("报".repeat(86))}`],
    ["a line feed", "name=a%0Ab.txt"],
    ["U+001F", "name=a%1Fb.txt"],
    ["U+007F", "name=a%7Fb.txt"],
    ["a nested path", "name=sub%2Fa.txt"],
    ["the temporary-file prefix", "name=.upload-x.part"],
    ["a leading ./", "name=.%2Fa.txt"],
    ["a leading slash", "name=%2Fa.txt"],
  ];

  // An over-long name must be 400 in both: with `uploads` present the sandbox's lstat of it
  // fails with ENAMETOOLONG, which without the early length check is a 403 and an audit event.
  it.each(BAD_NAMES)("answers 400 for %s, uploads absent or present", async (_label, query) => {
    await withUploadWorld(async (world) => {
      const absent = await createWorkspace(world, "absent");
      const present = await createWorkspace(world, "present");
      mkdirSync(join(present.root, "uploads"));
      const before = auditCount(world);

      for (const w of [absent, present]) {
        const response = await send(world, {
          workspaceId: w.id,
          ...(query === undefined ? {} : { query }),
          cookie: world.owner,
          headers: octet(3),
          body: Buffer.from("bad"),
        });
        expectWire(response, 400, BAD_REQUEST_ENVELOPE);
      }

      expect(uploadsOf(absent)).toBeNull();
      expect(readdirSync(absent.root)).toEqual([]);
      expect(uploadsOf(present)).toEqual([]);
      expect(auditCount(world)).toBe(before);
    });
  });

  it("accepts a name of exactly 255 bytes, ASCII or Chinese", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "longest");
      const ascii = "a".repeat(255);
      const chinese = "报".repeat(85);

      created(await upload(world, w.id, ascii, "one"), ascii, 3);
      created(await upload(world, w.id, chinese, "two"), chinese, 3);
    });
  });

  it.each([
    ["application/json", { "Content-Type": "application/json", "Content-Length": "2" }, "{}"],
    [
      "multipart/form-data",
      { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": "3" },
      "abc",
    ],
    ["text/plain", { "Content-Type": "text/plain", "Content-Length": "3" }, "abc"],
    ["a body without a media type", { "Content-Length": "3" }, "abc"],
    ["no media type and no body", {}, ""],
    // Declared and never sent: an answer means no parser sat waiting for a JSON body.
    [
      "application/json before its body arrives",
      { "Content-Type": "application/json", "Content-Length": "2" },
      "",
    ],
  ])("answers 400 for %s and closes the connection", async (_label, headers, body) => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "media");
      const before = auditCount(world);

      const response = await send(world, {
        workspaceId: w.id,
        query: "name=a.txt",
        cookie: world.owner,
        headers,
        body: Buffer.from(body),
        keepAlive: true,
      });

      expectWire(response, 400, BAD_REQUEST_ENVELOPE);
      expect(response.closedByServer).toBe(true);
      expect(uploadsOf(w)).toBeNull();
      expect(auditCount(world)).toBe(before);
    });
  });
});

describe("workspaces「文件上传」 — 他人与不存在的空间", () => {
  it("answers one and the same 404 before the body, the media type, the size or the name is looked at", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "mine");
      created(await upload(world, w.id, "mine.txt", "mine"), "mine.txt", 4);
      const before = auditCount(world);
      const unknown = "c".repeat(32);
      // Heads only: each declares a body and none is sent, so an answer means none was read.
      const requests = [
        { workspaceId: w.id, query: "name=a.txt", headers: octet(3) },
        { workspaceId: w.id, query: "name=..%2F..%2Fetc%2Fpasswd", headers: octet(3) },
        { workspaceId: w.id, query: "name=a.txt", headers: octet(LIMIT + 1) },
        {
          workspaceId: w.id,
          query: "name=a.txt",
          headers: { "Content-Type": "application/json", "Content-Length": "2" },
        },
        { workspaceId: w.id, headers: octet(3) },
        { workspaceId: unknown, query: "name=a.txt", headers: octet(3) },
        { workspaceId: "not-an-id", query: "name=a.txt", headers: octet(3) },
      ];

      const answers = [
        ...(await Promise.all(
          requests.map((request) => send(world, { ...request, cookie: world.other })),
        )),
        await send(world, {
          workspaceId: unknown,
          query: "name=a.txt",
          cookie: world.owner,
          headers: octet(3),
        }),
      ];
      const anonymous = await send(world, {
        workspaceId: w.id,
        query: "name=a.txt",
        headers: octet(3),
      });

      const other404 = await world.app.inject({
        method: "GET",
        url: `/api/workspaces/${unknown}/tree`,
        headers: { cookie: world.other },
      });
      for (const answer of answers) {
        expectWire(answer, 404, NOT_FOUND_ENVELOPE);
        // Verbatim the 404 of the other workspace endpoints.
        expect(answer.body).toBe(other404.payload);
        const { date: _date, ...headers } = answer.headers;
        const { date: _first, ...firstHeaders } = answers[0]?.headers ?? {};
        expect(headers).toEqual(firstHeaders);
      }
      expectWire(anonymous, 401, UNAUTHORIZED_ENVELOPE);
      expect(uploadsOf(w)).toEqual(["mine.txt"]);
      expect(readFileSync(join(w.root, "uploads", "mine.txt"), "utf8")).toBe("mine");
      expect(existsSync(join(world.sandboxRoot, "u2"))).toBe(false);
      expect(auditCount(world)).toBe(before);
    }, SMALL);
  });

  it("answers 404 for an own workspace whose root is gone, whatever the media type", async () => {
    await withUploadWorld(async (world) => {
      const gone = await createWorkspace(world, "gone");
      rmSync(gone.root, { recursive: true });
      const before = auditCount(world);

      for (const type of [OCTET_STREAM, "application/json"]) {
        const response = await send(world, {
          workspaceId: gone.id,
          query: "name=a.txt",
          cookie: world.owner,
          headers: { "Content-Type": type, "Content-Length": "2" },
          body: Buffer.from("{}"),
        });
        expectWire(response, 404, NOT_FOUND_ENVELOPE);
      }

      expect(existsSync(gone.root)).toBe(false);
      expect(auditCount(world)).toBe(before);
    });
  });
});

describe("workspaces「文件上传」 — 目录被占与审计失败", () => {
  it("answers 409 when uploads is a regular file", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "occupied");
      writeFileSync(join(w.root, "uploads"), "not a directory");
      const before = auditCount(world);

      const response = await upload(world, w.id, "a.txt", "new");

      expectWire(response, 409, CONFLICT_ENVELOPE);
      expect(readFileSync(join(w.root, "uploads"), "utf8")).toBe("not a directory");
      expect(readdirSync(w.root)).toEqual(["uploads"]);
      expect(auditCount(world)).toBe(before);
    });
  });

  it("answers 409 when the name and its 999 numbered forms are all taken", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "full");
      mkdirSync(join(w.root, "uploads"));
      writeFileSync(join(w.root, "uploads", "a.txt"), "0");
      for (let n = 1; n <= 999; n += 1) {
        writeFileSync(join(w.root, "uploads", `a (${String(n)}).txt`), String(n));
      }
      const before = auditCount(world);

      const response = await upload(world, w.id, "a.txt", "new");

      expectWire(response, 409, CONFLICT_ENVELOPE);
      const names = uploadsOf(w) ?? [];
      expect(names).toHaveLength(1_000);
      expect(names.filter((name) => name.startsWith(".upload-"))).toEqual([]);
      expect(auditCount(world)).toBe(before);
    });
  });

  it("answers a generic 500, not 201, when the upload cannot be audited; the file stays", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "unaudited");
      const before = auditCount(world);

      await withAuditRefused(world, async () => {
        const response = await upload(world, w.id, "a.txt", "new");

        expectWire(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(response.body).not.toContain("audit_events");
      });

      // No file-system rollback is promised (as for a new directory): the file is there.
      expect(uploadsOf(w)).toEqual(["a.txt"]);
      expect(auditCount(world)).toBe(before);
    });
  });
});

describe("upload limit wiring", () => {
  it.each([Number.NaN, 0, -1, 1.5, 2 ** 53, Number.POSITIVE_INFINITY])(
    "createApp refuses an upload limit of %s before it serves anything",
    (uploadMaxBytes) => {
      const db = openDb(":memory:");
      try {
        // Synchronously: not deferred to `ready`.
        expect(() => createApp({ db, assembly: { uploadMaxBytes } })).toThrow(
          /upload max bytes must be a positive safe integer/u,
        );
      } finally {
        db.close();
      }
    },
  );

  it("createApp without an upload limit uses 524288000", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "default");
      let response: WireResponse | undefined;

      const events = await auditedBy(world, async () => {
        response = await send(world, {
          workspaceId: w.id,
          query: "name=big.bin",
          cookie: world.owner,
          headers: octet(DEFAULT_LIMIT + 1),
        });
      });

      expectWire(response as WireResponse, 413, UPLOAD_TOO_LARGE_ENVELOPE);
      expect(events).toEqual([rejectEvent(w, "big.bin", DEFAULT_LIMIT)]);
    });
  });

  it("the entry's assembly carries the configured UPLOAD_MAX_BYTES", () => {
    const configured = resolveServerConfig({ UPLOAD_MAX_BYTES: "1048576" }, SOURCE_ENTRY);

    expect(appAssemblyOf(configured).uploadMaxBytes).toBe(1_048_576);
    expect(appAssemblyOf(resolveServerConfig({}, SOURCE_ENTRY)).uploadMaxBytes).toBe(DEFAULT_LIMIT);
  });
});
