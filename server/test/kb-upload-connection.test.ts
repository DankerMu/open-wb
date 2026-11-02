/**
 * s2a-kb-ragflow tasks 12.2（#1849）：本地上传的连接层（knowledge-bases「本地上传入库」第 3 步，Scenario「客户端中断」
 * 「请求体太慢」）。世界同 `kb-upload.test.ts`，请求走回环端口上的裸 socket。期限经 `KbDependencies.uploadBodyDeadline` 缩短，
 * 定时器是系统边界：按延迟值认出读请求体期限的那一个。期望值是 spec 与 design D11 的字面量。
 */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { bodyDeadlineMs } from "../src/kb/uploads.js";
import {
  BAD_REQUEST,
  DELETE_DOCUMENT,
  PARSE,
  UPLOAD,
  useIngestWorlds,
} from "./kb-ingest-helpers.js";
import {
  answerOf,
  connectionCount,
  expectNoIngestAudit,
  holdWriteLock,
  listen,
  nameQuery,
  startUpload,
  upload,
} from "./kb-upload-helpers.js";
import { waitFor } from "./mounts-manager-helpers.js";
import { CASE_MS } from "./mounts-rest-helpers.js";
import { expectWire } from "./workspace-upload-helpers.js";

const open = useIngestWorlds();

const MIB = 1024 * 1024;
/** 这些延迟值只有读请求体期限会用：别的定时器（连接 10 s、出站 30 s、空闲）都不是它们。 */
const DRIP_DEADLINE_MS = 2_048;
const FAST_FLOOR_MS = 1_017;
const CLEARED_FLOOR_MS = 7_919;

/** 记下进程里的定时器。用例结束就还原：收尾的 afterEach 还要用真的。 */
function watchTimers() {
  const armed = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  onTestFinished(() => {
    armed.mockRestore();
    cleared.mockRestore();
  });
  return {
    cleared,
    armedWith: (ms: number): NodeJS.Timeout[] =>
      armed.mock.calls.flatMap(([, delayMs], index) =>
        delayMs === ms ? [armed.mock.results[index]?.value as NodeJS.Timeout] : [],
      ),
  };
}

/** 一次一个字节地发，直到收到应答或连接没了。 */
function drip(socket: Socket, everyMs: number): void {
  const timer = setInterval(() => {
    if (socket.destroyed) {
      clearInterval(timer);
    } else {
      socket.write("x");
    }
  }, everyMs);
  socket.once("data", () => {
    clearInterval(timer);
  });
}

describe("客户端中断", () => {
  it("声明 1 MiB，发 512 KiB 后断开：出站被中止，没有行，RAGFlow 上没有留下，锁放开了", {
    timeout: CASE_MS,
  }, async () => {
    const world = await open({ kb: { uploadMaxBytes: 2 * MIB } });
    const socket = await startUpload(world, await listen(world), {
      query: nameQuery("a.md"),
      headers: { "Content-Length": String(MIB) },
      body: randomBytes(512 * 1024),
    });
    socket.on("error", () => undefined);
    await waitFor(() => (world.uploads()[0]?.received ?? 0) > 0);
    socket.destroy();
    await waitFor(() => world.uploads()[0]?.aborted === true);
    await waitFor(() => world.locks.writeLockCount() === 0);

    expect(world.rows()).toEqual([]);
    expectNoIngestAudit(world);
    expect(world.fake.documents(world.datasetId)).toEqual([]);
    expect(world.countOf(PARSE)).toBe(0);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(0);

    expect((await upload(world, "later.md")).statusCode).toBe(201);
  });

  it("排队等锁时断开，请求体没有填满读缓冲：连接关闭已察觉，轮到它时不发出站请求", {
    timeout: CASE_MS,
  }, async () => {
    const world = await open({ kb: { uploadMaxBytes: 2 * MIB } });
    const port = await listen(world);
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    const first = upload(world, "a.md");
    await gate.reached;
    const socket = await startUpload(world, port, {
      query: nameQuery("b.md"),
      headers: { "Content-Length": String(MIB) },
      body: Buffer.alloc(1024, 0x61),
    });
    socket.on("error", () => undefined);
    await waitFor(() => world.locks.writeWaiters(world.baseId) === 1);
    socket.destroy();
    await vi.waitUntil(async () => (await connectionCount(world)) === 0, {
      timeout: 10_000,
      interval: 10,
    });
    gate.release();

    expect((await first).statusCode).toBe(201);
    await waitFor(() => world.locks.writeLockCount() === 0);
    expect(world.countOf(UPLOAD)).toBe(1);
    expect(world.rows().map(({ name }) => name)).toEqual(["a.md"]);
    expect(world.audits("kb.ingest_reject")).toEqual([]);
  });

  it("排队等锁时断开，请求体大过读缓冲：socket 已停读，轮到时才读到断开，出站中止，不留文档", {
    timeout: CASE_MS,
  }, async () => {
    const world = await open({ kb: { uploadMaxBytes: 2 * MIB } });
    const port = await listen(world);
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    const first = upload(world, "a.md");
    await gate.reached;
    const socket = await startUpload(world, port, {
      query: nameQuery("b.md"),
      headers: { "Content-Length": String(2 * MIB) },
      body: randomBytes(MIB),
    });
    socket.on("error", () => undefined);
    await waitFor(() => world.locks.writeWaiters(world.baseId) === 1);
    socket.destroy();
    await once(socket, "close");
    gate.release();

    expect((await first).statusCode).toBe(201);
    await waitFor(() => world.uploads()[1]?.aborted === true);
    await waitFor(() => world.locks.writeLockCount() === 0);
    expect(world.uploads()).toHaveLength(2);
    expect(world.rows().map(({ name }) => name)).toEqual(["a.md"]);
    expect(world.fake.documents(world.datasetId)).toHaveLength(1);
    expect(world.audits("kb.ingest")).toHaveLength(1);
    expect(world.audits("kb.ingest_reject")).toEqual([]);
  });

  it("发送的字节少于 Content-Length 就结束：400，RAGFlow 上没有留下，没有行", async () => {
    const world = await open();
    const response = await upload(world, "a.md", "short", { contentLength: 100 });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(BAD_REQUEST);
    expect(world.rows()).toEqual([]);
    expectNoIngestAudit(world);
    expect(world.fake.documents(world.datasetId)).toEqual([]);
    expect(world.countOf(PARSE)).toBe(0);
  });
});

describe("读请求体的期限", () => {
  it.each([
    ["1 字节取下限", 1, 60_000],
    ["spec 的 1 MiB 仍取下限", MIB, 60_000],
    ["恰好折算到下限", 3_932_160, 60_000],
    ["多一个字节就按比例，进到整毫秒", 3_932_161, 60_001],
    ["8 MiB", 8 * MIB, 128_000],
    ["缺省 KB_UPLOAD_MAX_BYTES：约 27 分钟", 104_857_600, 1_600_000],
  ])("%s：%d 字节 %d ms", (_name, size, expected) => {
    expect(bodyDeadlineMs(size)).toBe(expected);
  });

  it("滴发不停、每次都短于出站空闲期限：期限到时 400，中止出站，排队的写操作拿到锁，什么都不留", {
    timeout: CASE_MS,
  }, async () => {
    const timers = watchTimers();
    const world = await open({
      kb: {
        uploadMaxBytes: 2 * MIB,
        // 1 MiB ÷ 512 000 B/s = 2 048 ms：长过空闲期限，只有声明长度算得出这个数。
        uploadBodyDeadline: { floorMs: 1, bytesPerSecond: 512_000 },
        deadlines: { idleMs: 1_500 },
      },
    });
    const socket = await startUpload(world, await listen(world), {
      query: nameQuery("a.md"),
      headers: { "Content-Length": String(MIB) },
      body: Buffer.alloc(1, 0x61),
    });
    const answer = answerOf(socket);
    drip(socket, 50);
    await waitFor(() => (world.uploads()[0]?.received ?? 0) > 0);
    const queued = world.locks.write(world.baseId, () => Promise.resolve("queued writer ran"));
    expect(world.locks.writeWaiters(world.baseId)).toBe(1);

    const reply = await answer;
    expectWire(reply, 400, BAD_REQUEST);
    expect(reply.closedByServer).toBe(true);
    await expect(queued).resolves.toEqual({ outcome: "ok", value: "queued writer ran" });
    await waitFor(() => world.uploads()[0]?.aborted === true);
    await waitFor(() => world.locks.writeLockCount() === 0);

    expect(timers.armedWith(DRIP_DEADLINE_MS)).toHaveLength(1);
    expect(world.rows()).toEqual([]);
    expectNoIngestAudit(world);
    expect(world.fake.documents(world.datasetId)).toEqual([]);
    expect(world.countOf(PARSE)).toBe(0);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(0);
  });

  it("快于期限的上传：201，定时器已清掉、不挡进程退出，过了期限也没有后续动作", {
    timeout: CASE_MS,
  }, async () => {
    const timers = watchTimers();
    const world = await open({
      kb: { uploadBodyDeadline: { floorMs: FAST_FLOOR_MS, bytesPerSecond: 64 * 1024 } },
    });

    expect((await upload(world, "a.md", "hello")).statusCode).toBe(201);
    const [timer] = timers.armedWith(FAST_FLOOR_MS);
    expect(timer?.hasRef()).toBe(false);
    expect(timers.cleared).toHaveBeenCalledWith(timer);

    const requests = world.lines();
    await delay(FAST_FLOOR_MS + 100);
    expect(world.lines()).toEqual(requests);
    expect(world.fake.documents(world.datasetId)).toHaveLength(1);
    expect(world.rows().map(({ name }) => name)).toEqual(["a.md"]);
    expect(world.audits("kb.ingest")).toHaveLength(1);
    expect(world.audits("kb.ingest_reject")).toEqual([]);
    expect(world.logged).toEqual([]);
    expect((await upload(world, "b.md", "hello")).statusCode).toBe(201);
  });

  it.each([
    ["客户端断开", false],
    ["RAGFlow 早应答", true],
  ])("%s：定时器同样清掉", { timeout: CASE_MS }, async (_name, ragflowGone) => {
    const timers = watchTimers();
    const world = await open({
      kb: {
        uploadMaxBytes: MIB,
        uploadBodyDeadline: { floorMs: CLEARED_FLOOR_MS, bytesPerSecond: MIB },
      },
    });
    if (ragflowGone) {
      await world.fake.close();
    }
    const socket = await startUpload(world, await listen(world), {
      query: nameQuery("a.md"),
      headers: { "Content-Length": String(MIB) },
      body: Buffer.alloc(1024, 0x61),
    });
    socket.on("error", () => undefined);
    await waitFor(() => timers.armedWith(CLEARED_FLOOR_MS).length === 1);
    if (!ragflowGone) {
      socket.destroy();
    }
    await waitFor(() => world.locks.writeLockCount() === 0);

    expect(timers.cleared).toHaveBeenCalledWith(timers.armedWith(CLEARED_FLOOR_MS)[0]);
    expect(world.rows()).toEqual([]);
    socket.destroy();
  });

  it("排队时间不算：排队超过期限，取到锁后读完照样 201", { timeout: CASE_MS }, async () => {
    const floorMs = 500;
    const world = await open({
      kb: { uploadBodyDeadline: { floorMs, bytesPerSecond: 64 * 1024 } },
    });
    const release = holdWriteLock(world);
    const pending = upload(world, "a.md", "hello");
    await waitFor(() => world.locks.writeWaiters(world.baseId) === 1);
    await delay(floorMs + 200);
    await release();

    expect((await pending).statusCode).toBe(201);
    expect(world.rows().map(({ name }) => name)).toEqual(["a.md"]);
  });
});
