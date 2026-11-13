/**
 * 假 RAGFlow 的线上字节计数（`fake-ragflow.mjs` 的兄弟文件，#1849）：HTTP 解析器只按 `Content-Length` 把字节交给 `request`，
 * 声明偏小时多出来的字节 `request` 上看不到，所以在 socket 上数。`received` 是请求头之后到达这条连接的字节数，含声明长度之外的。
 * 只记录，不影响应答：实例同样只读声明的字节。
 *
 * 应答发完算一个请求结束，之后到达的字节不再记到它头上：keep-alive 的连接上下一个请求从头数。
 *
 * `closed`（#1962）：应答写完之前连接就关了，即 `response` 的 `close` 早于 `finish`。正常应答之后 Node 照样发 `close`，
 * 所以只看 `writableFinished`，不看 `close` 本身。
 */
const HEADER_END = Buffer.from("\r\n\r\n");

function observe(wire, chunk) {
  if (wire.counting) {
    wire.entry.received += chunk.length;
    return;
  }
  wire.head = Buffer.concat([wire.head, chunk]);
  const end = wire.head.indexOf(HEADER_END);
  // 解析器的 `data` 监听器先运行，所以读到请求头结尾时 `track` 已经调用过了。解析器拒绝的请求没有记录。
  if (end !== -1 && wire.entry !== undefined) {
    wire.entry.received = wire.head.length - end - HEADER_END.length;
    wire.counting = true;
  }
}

/**
 * 返回 `track(request, response, entry)`：请求头解析完时调用，之后 `entry.received` 随线上字节增长；应答写完之前连接就关了，
 * `entry.closed` 置为 `true`。
 */
export function wireCounter(server) {
  const wires = new WeakMap();
  server.on("connection", (socket) => {
    const wire = { head: Buffer.alloc(0), entry: undefined, counting: false };
    wires.set(socket, wire);
    socket.on("data", (chunk) => observe(wire, chunk));
  });
  return (request, response, entry) => {
    const wire = wires.get(request.socket);
    wire.entry = entry;
    response.once("finish", () => {
      Object.assign(wire, { head: Buffer.alloc(0), entry: undefined, counting: false });
    });
    response.once("close", () => {
      if (!response.writableFinished) {
        entry.closed = true;
      }
    });
  };
}
