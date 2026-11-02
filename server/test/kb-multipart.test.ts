/**
 * s2a-kb-ragflow tasks 10.2（#1847）：出站 multipart（knowledge-bases「工作空间来源入库」第 6 步、实测记录 §7.1–§7.3、
 * design D10）：长度预先算好、流式拼接、字节计数中止。期望值是手写的字面量，不用实现里的拼法复算。
 */
import { PassThrough, Readable } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { multipartUpload } from "../src/kb/multipart.js";

const collect = async (body: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** 读到出错为止：返回已经读出的字节与错误。 */
async function collectUntilError(body: Readable): Promise<{ bytes: Buffer; error: unknown }> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of body) chunks.push(chunk as Buffer);
  } catch (error) {
    return { bytes: Buffer.concat(chunks), error };
  }
  return { bytes: Buffer.concat(chunks), error: undefined };
}

const sourceOf = (...chunks: Array<string | Buffer>): Readable =>
  Readable.from(
    chunks.map((chunk) => Buffer.from(chunk)),
    { objectMode: false },
  );

function boundaryOf(contentType: string): string {
  const match = /^multipart\/form-data; boundary=([0-9A-Za-z-]+)$/u.exec(contentType);
  if (match?.[1] === undefined) {
    throw new Error(`unexpected content type ${contentType}`);
  }
  return match[1];
}

describe("长度与拼接", () => {
  it("Content-Length 预先算好，等于实际字节：头、文件字节、结束边界", async () => {
    const upload = multipartUpload({ name: "a.txt", size: 5, source: sourceOf("he", "llo") });
    const boundary = boundaryOf(upload.contentType);
    const bytes = await collect(upload.body);
    expect(bytes.toString("utf8")).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''a.txt\r\n\r\nhello\r\n--${boundary}--\r\n`,
    );
    expect(upload.contentLength).toBe(bytes.length);
    expect(upload.sourceFailure()).toBeUndefined();
  });

  it("二进制字节原样通过，长度按字节算，不按字符", async () => {
    const content = Buffer.from([0xff, 0x00, 0xe4, 0xb8, 0xad, 0x0d, 0x0a]);
    const upload = multipartUpload({ name: "中.bin", size: 7, source: sourceOf(content) });
    const bytes = await collect(upload.body);
    expect(upload.contentLength).toBe(bytes.length);
    expect(bytes.includes(content)).toBe(true);
  });

  it("每次的边界都不同", () => {
    const first = multipartUpload({ name: "a", size: 1, source: sourceOf("x") });
    const second = multipartUpload({ name: "a", size: 1, source: sourceOf("y") });
    expect(boundaryOf(first.contentType)).not.toBe(boundaryOf(second.contentType));
    first.body.destroy();
    second.body.destroy();
  });

  it("流式：没有消费者时不把源文件读完，读取量有界", async () => {
    let pulled = 0;
    const total = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024);
    const source = new Readable({
      read() {
        pulled += chunk.length;
        this.push(pulled > total ? null : chunk);
      },
    });
    const upload = multipartUpload({ name: "big.bin", size: total, source });
    for (let turn = 0; turn < 50; turn += 1) await nextTick();
    expect(pulled).toBeLessThan(1024 * 1024);
    upload.body.destroy();
    await expect.poll(() => source.destroyed).toBe(true);
  });
});

describe("文件名", () => {
  it("非 ASCII 文件名走 filename*，不把百分号串放进 filename（§7.3）", async () => {
    const upload = multipartUpload({ name: "中文.txt", size: 1, source: sourceOf("x") });
    const text = (await collect(upload.body)).toString("utf8");
    expect(text).toContain(`filename*=UTF-8''%E4%B8%AD%E6%96%87.txt`);
    expect(text).not.toContain(`filename="`);
  });

  it("引号、换行与 RFC 8187 之外的字符都编码：不能注入 multipart 的头", async () => {
    const name = `a"b\r\nX: y'(1)*.txt`;
    const upload = multipartUpload({ name, size: 1, source: sourceOf("x") });
    const head = (await collect(upload.body)).toString("utf8").split("\r\n\r\n")[0];
    expect(head?.split("\r\n")[1]).toBe(
      `Content-Disposition: form-data; name="file"; filename*=UTF-8''a%22b%0D%0AX%3A%20y%27%281%29%2A.txt`,
    );
  });

  it("孤立代理项不抛错：按替换字符编码", async () => {
    const upload = multipartUpload({ name: "\ud800.txt", size: 1, source: sourceOf("x") });
    expect((await collect(upload.body)).toString("utf8")).toContain(`''%EF%BF%BD.txt`);
  });
});

describe("字节计数中止", () => {
  it("读到的多于声明：立即中止，多出的字节与结束边界都不发", async () => {
    const upload = multipartUpload({
      name: "a.txt",
      size: 3,
      source: sourceOf("abc", "OVERFLOW", "more"),
    });
    const boundary = boundaryOf(upload.contentType);
    const { bytes, error } = await collectUntilError(upload.body);
    expect(error).toBeInstanceOf(Error);
    expect(bytes.toString("utf8")).not.toContain("OVERFLOW");
    expect(bytes.toString("utf8")).not.toContain(`--${boundary}--`);
    expect(upload.sourceFailure()).toBeInstanceOf(Error);
  });

  it("一块里同时越过声明：这一块整个不发", async () => {
    // 负载取十六进制边界与头里都不会出现的字节，免得随机边界碰巧含有它。按 `data` 事件收：出错时 `for await`
    // 丢掉尚未读出的缓冲，看不到「先发出、再出错」的字节；下游管道看得到。
    const upload = multipartUpload({ name: "a.txt", size: 3, source: sourceOf("xyzuvw") });
    const sent: Buffer[] = [];
    upload.body.on("data", (chunk: Buffer) => sent.push(chunk));
    upload.body.on("error", () => undefined);
    await new Promise((resolve) => upload.body.once("close", resolve));
    expect(Buffer.concat(sent).toString("utf8")).not.toContain("xyz");
    expect(upload.sourceFailure()).toBeInstanceOf(Error);
  });

  it("读到的少于声明：中止，没有结束边界", async () => {
    const upload = multipartUpload({ name: "a.txt", size: 10, source: sourceOf("abc") });
    const boundary = boundaryOf(upload.contentType);
    const { bytes, error } = await collectUntilError(upload.body);
    expect(error).toBeInstanceOf(Error);
    expect(bytes.toString("utf8")).not.toContain(`--${boundary}--`);
    expect(upload.sourceFailure()).toBeInstanceOf(Error);
  });

  it("源读取出错：调用点拿到这个错误，请求体同样中止", async () => {
    const source = new PassThrough();
    const upload = multipartUpload({ name: "a.txt", size: 10, source });
    const failure = new Error("read failed");
    const collected = collectUntilError(upload.body);
    source.destroy(failure);
    expect((await collected).error).toBe(failure);
    expect(upload.sourceFailure()).toBe(failure);
  });

  it("请求体被外部销毁（早应答）：源随之销毁，不算源的失败", async () => {
    const source = new PassThrough();
    const upload = multipartUpload({ name: "a.txt", size: 10, source });
    upload.body.destroy();
    await expect.poll(() => source.destroyed).toBe(true);
    expect(upload.sourceFailure()).toBeUndefined();
  });

  it("请求体带错误销毁（连接断开）：同样不算源的失败", async () => {
    const source = new PassThrough();
    const upload = multipartUpload({ name: "a.txt", size: 10, source });
    upload.body.on("error", () => undefined);
    upload.body.destroy(new Error("connection closed"));
    await expect.poll(() => source.destroyed).toBe(true);
    expect(upload.sourceFailure()).toBeUndefined();
  });

  it("读完之后源不再保留：源流结束即销毁", async () => {
    const source = sourceOf("abc");
    const upload = multipartUpload({ name: "a.txt", size: 3, source });
    await collect(upload.body);
    await expect.poll(() => source.destroyed).toBe(true);
  });
});
