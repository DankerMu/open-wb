/**
 * s2a-kb-ragflow tasks 5.2（#1840）：RAGFlow 客户端的传输层（ragflow-backend「RAGFlow 出站请求」的期限，「嵌入模型
 * 更换与全量重建」的下载判别；design D4、D8）。流式上传、流式下载打假 RAGFlow；缺省期限在假 `http.request` 上走
 * 注入的假定时器（系统边界）：真实连接造不出「TCP 一直连不上」，也不值得真等 30 秒。
 */
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { PassThrough, Readable, Writable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRagflowClient } from "../src/kb/ragflow-client.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";

const KEY = "wb-issue1840-ragflow-key";
const ABSENT = "0123456789abcdef0123456789abcdef";
const NOT_FOUND_DOCUMENT = '{"code":404,"message":"Resource not found"}';
const UNAVAILABLE = { kind: "kb_unavailable" };
const DOWNLOAD = "GET /api/v1/datasets/*/documents/*";
const UPLOAD = "POST /api/v1/datasets/*/documents";
const DATASET = {
  name: "owb-1-g0",
  parserId: "general",
  embeddingModel: "bge-m3@owb-embed@OpenAI-API-Compatible",
};

type Client = ReturnType<typeof createRagflowClient>;

let fake: FakeRagflowServer;
let logged: unknown[];

function clientOf(baseUrl: string, deadlines: Record<string, number> = {}): Client {
  return createRagflowClient({
    baseUrl,
    key: { read: () => KEY },
    log: (record) => {
      logged.push(record);
    },
    deadlines,
  });
}

function framing(name: string) {
  return {
    head: `--b\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`,
    tail: "\r\n--b--\r\n",
    contentType: "multipart/form-data; boundary=b",
  };
}

function multipart(name: string, content: Buffer) {
  const { head, tail, contentType } = framing(name);
  const parts = [Buffer.from(head), content, Buffer.from(tail)];
  return {
    body: Readable.from(parts),
    contentType,
    contentLength: Buffer.concat(parts).length,
  };
}

async function fileOf(result: Awaited<ReturnType<Client["downloadDocument"]>>): Promise<string> {
  if (result.kind !== "ok") {
    throw new Error(`expected a file, got ${result.kind}`);
  }
  return text(result.value.body);
}

beforeEach(() => {
  logged = [];
});

describe("流式上传（§7）", () => {
  let client: Client;

  beforeEach(async () => {
    fake = await start({ apiKey: KEY });
    client = clientOf(fake.baseUrl);
  });

  afterEach(async () => {
    await fake.close();
  });

  it("带 Content-Length，字节原样到达，字段名 file，回文档 id", async () => {
    const id = fake.addDataset();
    const content = Buffer.alloc(200_000, 7);
    const upload = multipart("a.txt", content);
    const result = await client.uploadDocument(id, upload);
    const [document] = fake.documents(id);
    expect(result).toEqual({ kind: "ok", value: { id: document?.id } });
    expect(document).toMatchObject({ name: "a.txt", size: 200_000 });
    expect(fake.requests()[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/datasets/${id}/documents`,
      contentLength: upload.contentLength,
      multipart: [{ field: "file", filename: "a.txt", bytes: 200_000 }],
      bearer: "ok",
    });
  });

  it("同名上传由 RAGFlow 改名：客户端只回 id", async () => {
    const id = fake.addDataset();
    await client.uploadDocument(id, multipart("a.txt", Buffer.from("x")));
    const second = await client.uploadDocument(id, multipart("a.txt", Buffer.from("y")));
    expect(fake.documents(id).map((document) => document.name)).toEqual(["a.txt", "a(1).txt"]);
    expect(Object.keys(second)).toEqual(["kind", "value"]);
    expect(second).toEqual({ kind: "ok", value: { id: fake.documents(id)[1]?.id } });
  });

  it("请求体读取出错：中止出站，kb_unavailable，不留文档", async () => {
    const id = fake.addDataset();
    const { head, contentType } = framing("a.txt");
    const body = new PassThrough();
    body.write(head);
    const pending = client.uploadDocument(id, { body, contentType, contentLength: 10_000 });
    await expect.poll(() => fake.requests().length).toBe(1);
    body.destroy(new Error("source read failed"));
    await expect(pending).resolves.toEqual(UNAVAILABLE);
    await expect.poll(() => fake.requests()[0]?.aborted).toBe(true);
    expect(fake.documents(id)).toEqual([]);
  });

  it("请求体比声明短：空闲期限到期，不留文档", async () => {
    const id = fake.addDataset();
    const upload = multipart("a.txt", Buffer.from("short"));
    const slow = clientOf(fake.baseUrl, { idleMs: 40 });
    const result = await slow.uploadDocument(id, {
      ...upload,
      contentLength: upload.contentLength + 10,
    });
    expect(result).toEqual(UNAVAILABLE);
    await expect.poll(() => fake.requests()[0]?.aborted).toBe(true);
    expect(fake.documents(id)).toEqual([]);
  });

  it("请求体停住超过空闲期限：中止出站并销毁请求体", async () => {
    const id = fake.addDataset();
    const { head, contentType } = framing("a.txt");
    const body = new PassThrough();
    body.write(head);
    const slow = clientOf(fake.baseUrl, { idleMs: 40 });
    await expect(
      slow.uploadDocument(id, { body, contentType, contentLength: 10_000 }),
    ).resolves.toEqual(UNAVAILABLE);
    await expect.poll(() => body.destroyed).toBe(true);
    await expect.poll(() => fake.requests()[0]?.aborted).toBe(true);
  });

  it("读完请求体不应答：空闲期限到期", async () => {
    const id = fake.addDataset();
    fake.fault(UPLOAD, { kind: "hang" });
    const slow = clientOf(fake.baseUrl, { idleMs: 40 });
    await expect(slow.uploadDocument(id, multipart("a.txt", Buffer.from("x")))).resolves.toEqual(
      UNAVAILABLE,
    );
  });

  it("持续发送的上传不受总期限约束：JSON 的 30 s 总期限不适用", async () => {
    const id = fake.addDataset();
    const { head, tail, contentType } = framing("a.txt");
    const body = new PassThrough();
    const slow = clientOf(fake.baseUrl, { totalMs: 20, idleMs: 200 });
    const payload = Buffer.alloc(3, 7);
    const pending = slow.uploadDocument(id, {
      body,
      contentType,
      contentLength: Buffer.byteLength(head) + payload.length + Buffer.byteLength(tail),
    });
    body.write(head);
    for (const byte of payload) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      body.write(Buffer.from([byte]));
    }
    body.end(tail);
    await expect(pending).resolves.toMatchObject({ kind: "ok" });
  });

  it("应答体超 1 MiB 同样失败", async () => {
    const id = fake.addDataset();
    fake.fault(UPLOAD, {
      kind: "oversize",
      bytes: 1_048_577,
      envelope: { code: 0, data: [{ id: "x" }] },
    });
    await expect(client.uploadDocument(id, multipart("a.txt", Buffer.from("x")))).resolves.toEqual(
      UNAVAILABLE,
    );
  });
});

describe("下载判别（§9.1，design D8）", () => {
  let client: Client;

  beforeEach(async () => {
    fake = await start({ apiKey: KEY });
    client = clientOf(fake.baseUrl);
  });

  afterEach(async () => {
    await fake.close();
  });

  it("带 Content-Disposition 是文件流，字节不变", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "0123456789abcdef" });
    await expect(fileOf(await client.downloadDocument(id, doc))).resolves.toBe("0123456789abcdef");
    expect(fake.requests()[0]).toMatchObject({
      method: "GET",
      path: `/api/v1/datasets/${id}/documents/${doc}`,
      bearer: "ok",
    });
  });

  it("带头时内容恰为 not-found 正文也是文件", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "nf.json", content: NOT_FOUND_DOCUMENT });
    await expect(fileOf(await client.downloadDocument(id, doc))).resolves.toBe(NOT_FOUND_DOCUMENT);
  });

  it("带头时不看 Content-Type 与 Content-Length，文件名含引号也不解析", async () => {
    fake.fault(DOWNLOAD, {
      kind: "cut",
      headers: {
        "content-disposition": 'attachment; filename="a"b.txt"',
        "content-type": "application/json; charset=utf-8",
      },
      body: "",
    });
    const result = await client.downloadDocument(ABSENT, ABSENT);
    expect(result.kind).toBe("ok");
  });

  it("不带头：文档不存在的 code:404 是 not_found", async () => {
    const id = fake.addDataset();
    await expect(client.downloadDocument(id, ABSENT)).resolves.toEqual({ kind: "not_found" });
  });

  it("不带头：数据集不存在的 code:404 是 not_found", async () => {
    await expect(client.downloadDocument(ABSENT, ABSENT)).resolves.toEqual({ kind: "not_found" });
  });

  it("不带头：0 字节文件的 code:500 是 kb_unavailable", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "empty.txt", content: "" });
    await expect(client.downloadDocument(id, doc)).resolves.toEqual(UNAVAILABLE);
  });

  it("不带头的 code:0：缺文件，kb_unavailable", async () => {
    fake.answer(DOWNLOAD, { code: 0, data: null, message: "success" });
    await expect(client.downloadDocument(ABSENT, ABSENT)).resolves.toEqual(UNAVAILABLE);
  });

  it("不带头的 code:102：走通用行，kb_rejected", async () => {
    fake.answer(DOWNLOAD, { code: 102, message: "x" });
    await expect(client.downloadDocument(ABSENT, ABSENT)).resolves.toEqual({ kind: "kb_rejected" });
  });

  it("不带头的非 JSON（代理剥掉了头）：kb_unavailable", async () => {
    fake.fault(DOWNLOAD, { kind: "not_json", body: "plain file bytes" });
    await expect(client.downloadDocument(ABSENT, ABSENT)).resolves.toEqual(UNAVAILABLE);
  });

  it("不带头的正文受 1 MiB 上限", async () => {
    fake.fault(DOWNLOAD, { kind: "oversize", bytes: 1_048_577, envelope: { code: 404 } });
    await expect(client.downloadDocument(ABSENT, ABSENT)).resolves.toEqual(UNAVAILABLE);
  });

  it("非 200 走通用行：HTTP 401 写一行", async () => {
    fake.answer(DOWNLOAD, { status: 401, code: 401, message: "Invalid access token" });
    await expect(client.downloadDocument(ABSENT, ABSENT)).resolves.toEqual(UNAVAILABLE);
    expect(logged).toEqual([{ event: "kb_upstream_auth_failed" }]);
  });

  it("非 200 带头也不是文件", async () => {
    fake.fault(DOWNLOAD, {
      kind: "status",
      status: 500,
      headers: { "content-disposition": 'attachment; filename="a.txt"' },
      body: "x",
    });
    await expect(client.downloadDocument(ABSENT, ABSENT)).resolves.toEqual(UNAVAILABLE);
  });

  it("文件中途断开：流报错，不是干净结束", async () => {
    fake.fault(DOWNLOAD, {
      kind: "cut",
      headers: { "content-disposition": 'attachment; filename="a.txt"', "content-length": "100" },
      body: "partial",
    });
    await expect(fileOf(await client.downloadDocument(ABSENT, ABSENT))).rejects.toThrow();
  });

  it("文件中途停住超过空闲期限：流报错", async () => {
    fake.fault(DOWNLOAD, {
      kind: "stall",
      headers: { "content-disposition": 'attachment; filename="a.txt"', "content-length": "100" },
      body: "partial",
    });
    const slow = clientOf(fake.baseUrl, { idleMs: 40 });
    await expect(fileOf(await slow.downloadDocument(ABSENT, ABSENT))).rejects.toThrow();
  });

  it("文件下载不受总期限约束", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "abc" });
    const gate = fake.fault(DOWNLOAD, { kind: "hold" });
    const slow = clientOf(fake.baseUrl, { totalMs: 10, idleMs: 500 });
    const pending = slow.downloadDocument(id, doc);
    await gate.reached;
    await new Promise((resolve) => setTimeout(resolve, 40));
    gate.release();
    await expect(fileOf(await pending)).resolves.toBe("abc");
  });

  it("应答头迟迟不来：空闲期限到期", async () => {
    fake.fault(DOWNLOAD, { kind: "hang" });
    const slow = clientOf(fake.baseUrl, { idleMs: 40 });
    await expect(slow.downloadDocument(ABSENT, ABSENT)).resolves.toEqual(UNAVAILABLE);
  });
});

describe("JSON 调用的总期限", () => {
  let client: Client;

  beforeEach(async () => {
    fake = await start({ apiKey: KEY });
    client = clientOf(fake.baseUrl, { totalMs: 40, connectMs: 20 });
  });

  afterEach(async () => {
    await fake.close();
  });

  it("含读响应体的时间：应答头到了、正文停住也到期", async () => {
    fake.fault("POST /api/v1/datasets", { kind: "stall", body: '{"code":0' });
    await expect(client.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
  });

  it("连接建好后不再按连接期限计时", async () => {
    const gate = fake.fault("POST /api/v1/datasets", { kind: "hold" });
    const pending = client.createDataset(DATASET);
    await gate.reached;
    await new Promise((resolve) => setTimeout(resolve, 25));
    gate.release();
    await expect(pending).resolves.toMatchObject({ kind: "ok" });
  });

  it("版本接口有自己的总期限", async () => {
    fake.fault("GET /api/v1/system/version", { kind: "hang" });
    const slow = clientOf(fake.baseUrl, { versionTotalMs: 30 });
    await expect(slow.version()).resolves.toEqual(UNAVAILABLE);
  });
});

/** `http.request` 的替身：一个永远不应答的请求。`socket` 事件由用例在需要时发出。 */
class StubRequest extends Writable {
  readonly connection = new EventEmitter();
  idleMs: number | undefined;
  /** 空闲到期：真实请求由 socket 的 `timeout` 触发。 */
  expireIdle: () => void = () => undefined;

  constructor() {
    super({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    queueMicrotask(() => this.emit("socket", this.connection));
  }

  setTimeout(ms: number, onIdle: () => void): this {
    this.idleMs = ms;
    this.expireIdle = onIdle;
    return this;
  }
}

describe("缺省期限（design D4、D5）", () => {
  const made: StubRequest[] = [];
  const stub = (() => {
    const request = new StubRequest();
    made.push(request);
    return request;
  }) as unknown as typeof http.request;

  beforeEach(() => {
    made.length = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(http, "request").mockImplementation(stub);
    vi.spyOn(https, "request").mockImplementation(stub);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function watch(pending: Promise<unknown>): { settled: () => boolean } {
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    return { settled: () => settled };
  }

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("连接期限 10 s：到期为 kb_unavailable，并销毁请求", async () => {
    const pending = clientOf("http://ragflow.test").createDataset(DATASET);
    const { settled } = watch(pending);
    await advance(9_999);
    expect(settled()).toBe(false);
    await advance(1);
    await expect(pending).resolves.toEqual(UNAVAILABLE);
    expect(made[0]?.destroyed).toBe(true);
  });

  it("每个请求一条新连接：agent 为 false", () => {
    void clientOf("http://ragflow.test").createDataset(DATASET);
    expect(http.request).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ agent: false, method: "POST" }),
      expect.any(Function),
    );
  });

  it("JSON 总期限 30 s：连接建好之后才看它", async () => {
    const pending = clientOf("http://ragflow.test").createDataset(DATASET);
    const { settled } = watch(pending);
    await advance(0);
    made[0]?.connection.emit("connect");
    await advance(29_999);
    expect(settled()).toBe(false);
    await advance(1);
    await expect(pending).resolves.toEqual(UNAVAILABLE);
  });

  it("https：只有 TCP 没有 TLS，连接期限照走", async () => {
    const pending = clientOf("https://ragflow.test").createDataset(DATASET);
    await advance(0);
    made[0]?.connection.emit("connect");
    await advance(10_000);
    await expect(pending).resolves.toEqual(UNAVAILABLE);
    expect(https.request).toHaveBeenCalledOnce();
    expect(http.request).not.toHaveBeenCalled();
  });

  it("https：TLS 建好，连接期限结束", async () => {
    const pending = clientOf("https://ragflow.test").createDataset(DATASET);
    const { settled } = watch(pending);
    await advance(0);
    made[0]?.connection.emit("secureConnect");
    await advance(29_999);
    expect(settled()).toBe(false);
    await advance(1);
    await expect(pending).resolves.toEqual(UNAVAILABLE);
  });

  it("版本接口总期限 5 s", async () => {
    const pending = clientOf("http://ragflow.test").version();
    const { settled } = watch(pending);
    await advance(0);
    made[0]?.connection.emit("connect");
    await advance(4_999);
    expect(settled()).toBe(false);
    await advance(1);
    await expect(pending).resolves.toEqual(UNAVAILABLE);
  });

  it("上传与下载：连接 10 s，空闲 60 s，没有总期限", async () => {
    const client = clientOf("http://ragflow.test");
    const download = client.downloadDocument(ABSENT, ABSENT);
    const { settled } = watch(download);
    await advance(0);
    made[0]?.connection.emit("connect");
    expect(made[0]?.idleMs).toBe(60_000);
    await advance(600_000);
    expect(settled()).toBe(false);
    made[0]?.expireIdle();
    await expect(download).resolves.toEqual(UNAVAILABLE);
    expect(made[0]?.destroyed).toBe(true);

    const upload = client.uploadDocument(ABSENT, multipart("a.txt", Buffer.from("x")));
    const stalled = watch(upload);
    await advance(0);
    expect(made[1]?.idleMs).toBe(60_000);
    await advance(9_999);
    expect(stalled.settled()).toBe(false);
    await advance(1);
    await expect(upload).resolves.toEqual(UNAVAILABLE);
  });
});
