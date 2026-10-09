/**
 * Issue #1015 (s1g-composer-capabilities task 11.3): the stream side of
 * `POST /api/workspaces/:id/uploads` — spec workspaces「文件上传」 scenarios 「中断与残留清理」 and
 * 「不进内存的流式写入」, plus design D10's two timeouts.
 *
 * Same world and wire client as workspace-upload-rest.test.ts. File descriptors are not counted:
 * what stands in for "nothing left open" is the temporary file being gone, the server's
 * connection count back at zero and a later upload on the same app succeeding.
 *
 * The memory case reads this process's own numbers, so it relies on vitest's default forks pool
 * (one process per test file) and on nothing else running in this file at the same time.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { INTERNAL_ERROR_ENVELOPE } from "./auth-lifecycle-helpers.js";
import { removeTempDirs } from "./core-db-helpers.js";
import {
  auditCount,
  chunkOf,
  connect,
  connections,
  createWorkspace,
  expectWire,
  OCTET_STREAM,
  readResponse,
  send,
  startOf,
  type UploadWorld,
  until,
  upload,
  uploadsOf,
  type Workspace,
  withUploadWorld,
} from "./workspace-upload-helpers.js";

afterEach(removeTempDirs);

const MIB = 1024 * 1024;
const TEMP_NAME = /^\.upload-[0-9a-f]{32}\.part$/u;
const BIG = 32 * MIB;
const BIG_LIMIT = 64 * MIB;
/** The spec's threshold. Measured here: about 0.5 MiB streamed, the whole 32 MiB when buffered. */
const MEMORY_THRESHOLD = 8 * MIB;
const WRITE_CHUNK = 64 * 1024;
/** One sample per MiB sent: 32 samples, the last ones with nearly everything on the server. */
const SAMPLE_EVERY = 16;
const MEMORY_TIMEOUT_MS = 30_000;
/** Above the 5 s a poll may take, so that a poll that gives up says what it waited for. */
const POLLING_TIMEOUT_MS = 15_000;

function temporaryFiles(workspace: Workspace): string[] {
  return (uploadsOf(workspace) ?? []).filter((name) => TEMP_NAME.test(name));
}

/** The upload has reached the disk: its temporary file is in `uploads`. */
function writing(workspace: Workspace): Promise<void> {
  return until("the temporary file to appear", () => temporaryFiles(workspace).length === 1);
}

/** Nothing of the upload is left, and the same app still takes one. */
async function expectNothingLeft(world: UploadWorld, w: Workspace, before: number): Promise<void> {
  await until("the uploads directory to be empty", () => uploadsOf(w)?.length === 0);
  await until("the connection to be released", async () => (await connections(world)) === 0);
  // Neither `file.upload` nor `upload.reject`: no audit event at all.
  expect(auditCount(world)).toBe(before);
  const later = await upload(world, w.id, "later.txt", "ok");
  expectWire(later, 201, { path: "uploads/later.txt", name: "later.txt", size: 2 });
  expect(uploadsOf(w)).toEqual(["later.txt"]);
}

describe("workspaces「文件上传」 — 中断与残留清理", () => {
  it(
    "removes the temporary file and writes no audit when the client disconnects half way",
    async () => {
      await withUploadWorld(async (world) => {
        const w = await createWorkspace(world, "aborted");
        const before = auditCount(world);
        const socket = await connect(world);

        socket.write(
          startOf(world, {
            workspaceId: w.id,
            query: "name=half.bin",
            cookie: world.owner,
            headers: { "Content-Type": OCTET_STREAM, "Content-Length": String(64 * 1024) },
            body: Buffer.alloc(32 * 1024, 0x61),
          }),
        );
        await writing(w);
        socket.destroy();

        await expectNothingLeft(world, w, before);
      });
    },
    POLLING_TIMEOUT_MS,
  );

  it(
    "removes the temporary file and writes no audit when the request stream fails mid-way",
    async () => {
      await withUploadWorld(async (world) => {
        const w = await createWorkspace(world, "broken");
        const before = auditCount(world);
        const socket = await connect(world);
        // What reaches the wire here is the HTTP parser's own 400, not the envelope: not asserted.
        const answer = readResponse(socket);

        socket.write(
          startOf(world, {
            workspaceId: w.id,
            query: "name=broken.bin",
            cookie: world.owner,
            headers: { "Content-Type": OCTET_STREAM, "Transfer-Encoding": "chunked" },
            body: chunkOf(Buffer.alloc(100, 0x61)),
          }),
        );
        await writing(w);
        // Not a chunk size: the request stream errors.
        socket.write("zz\r\n");
        await answer;

        await expectNothingLeft(world, w, before);
      });
    },
    POLLING_TIMEOUT_MS,
  );

  // Root ignores the directory's mode, so the open would succeed.
  it.skipIf(process.getuid?.() === 0)(
    "answers 500 and closes the connection when the temporary file cannot be created",
    async () => {
      await withUploadWorld(async (world) => {
        const w = await createWorkspace(world, "readonly");
        mkdirSync(join(w.root, "uploads"));
        chmodSync(join(w.root, "uploads"), 0o500);
        const before = auditCount(world);

        // The body is never finished and the client asks for keep-alive: nothing has started
        // reading the request when the open fails, so only the server's close ends this.
        const response = await send(world, {
          workspaceId: w.id,
          query: "name=a.txt",
          cookie: world.owner,
          headers: { "Content-Type": OCTET_STREAM, "Transfer-Encoding": "chunked" },
          body: chunkOf(Buffer.from("abc")),
          keepAlive: true,
        });

        expectWire(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(response.closedByServer).toBe(true);
        chmodSync(join(w.root, "uploads"), 0o700);
        await expectNothingLeft(world, w, before);
      });
    },
    POLLING_TIMEOUT_MS,
  );
});

describe("design D10 — no request or connection timeout", () => {
  it("leaves requestTimeout and connectionTimeout at 0, in the config and on the server", async () => {
    await withUploadWorld(async ({ app }) => {
      // Fastify's type for `initialConfig` leaves `requestTimeout` out; the value is there.
      const config = app.initialConfig as { requestTimeout?: number; connectionTimeout?: number };
      expect({
        requestTimeout: config.requestTimeout,
        connectionTimeout: config.connectionTimeout,
        serverRequestTimeout: app.server.requestTimeout,
        serverTimeout: app.server.timeout,
      }).toEqual({
        requestTimeout: 0,
        connectionTimeout: 0,
        serverRequestTimeout: 0,
        serverTimeout: 0,
      });
    });
  });
});

describe("workspaces「文件上传」 — 不进内存的流式写入", () => {
  it(
    "stores 32 MiB byte for byte while heapUsed + arrayBuffers grows by less than 8 MiB",
    async () => {
      // vitest runs without --expose-gc; this obtains the same function without changing config.
      setFlagsFromString("--expose-gc");
      const gc = runInNewContext("gc") as () => void;
      const used = (): number => {
        gc();
        const usage = process.memoryUsage();
        return usage.heapUsed + usage.arrayBuffers;
      };

      await withUploadWorld(
        async (world) => {
          const w = await createWorkspace(world, "big");
          // Allocated before the baseline: the payload itself is not what is being measured.
          const payload = randomBytes(BIG);
          const socket = await connect(world);
          const answer = readResponse(socket, MEMORY_TIMEOUT_MS);
          const baseline = used();
          let peak = 0;

          socket.write(
            startOf(world, {
              workspaceId: w.id,
              query: "name=big.bin",
              cookie: world.owner,
              headers: { "Content-Type": OCTET_STREAM, "Content-Length": String(BIG) },
            }),
          );
          for (let offset = 0, sent = 1; offset < BIG; offset += WRITE_CHUNK, sent += 1) {
            if (!socket.write(payload.subarray(offset, offset + WRITE_CHUNK))) {
              await new Promise((resolve) => socket.once("drain", resolve));
            }
            if (sent % SAMPLE_EVERY === 0) {
              peak = Math.max(peak, used() - baseline);
            }
          }
          const response = await answer;

          expectWire(response, 201, { path: "uploads/big.bin", name: "big.bin", size: BIG });
          expect(peak).toBeLessThan(MEMORY_THRESHOLD);
          // Compared only now: reading the file back would itself show up in the samples.
          expect(readFileSync(join(w.root, "uploads", "big.bin")).equals(payload)).toBe(true);
        },
        { uploadMaxBytes: BIG_LIMIT },
      );
    },
    MEMORY_TIMEOUT_MS,
  );
});
