import { createConnection } from "node:net";
import type { FastifyInstance } from "fastify";

/**
 * 真实 HTTP/1.1 socket 工具箱（#6 traversal/wire 面与 #19 HEAD 语义共用同一 owner）。
 * 之所以必须走真实 socket：Fastify `inject()` 会保留待发 payload，HEAD 的 body 抑制与
 * `content-length` 只在 wire 上可观察。
 */

export interface RawHttpRequest {
  method?: string;
  target: string;
  cookie?: string;
}

/** 监听一个临时端口执行 `action`，结束后关闭 app（caller 仍拥有自己的 DB）。 */
export async function withListeningApp<T>(
  app: FastifyInstance,
  action: (origin: string) => Promise<T>,
): Promise<T> {
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test app did not bind a TCP address");
    }

    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await app.close();
  }
}

/** 对已监听 origin 发一条原始请求，返回完整响应字节。 */
export async function rawHttpRequest(
  origin: string,
  { method = "GET", target, cookie }: RawHttpRequest,
): Promise<string> {
  const url = new URL(origin);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  const chunks: Buffer[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `${method} ${target} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        `Connection: close\r\n` +
        `${cookie === undefined ? "" : `Cookie: ${cookie}\r\n`}\r\n`,
    );
    for await (const chunk of socket) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    socket.destroy();
  }
}
