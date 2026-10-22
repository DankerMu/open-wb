/**
 * s1d-model-registry group 8 (task 8.2): the test-local upstreams of `models-probe.test.ts` — a
 * listener that accepts connections and never answers (the `超时` and serialisation cases), a
 * plain HTTP server with a scripted answer (302, a long 500, a 500 body that never ends), and a
 * port nothing listens on. All on loopback; every one is closed after its test.
 */
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { afterEach } from "vitest";

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
});

export interface HoldServer {
  port: number;
  /** One entry per accepted connection: how many earlier connections had not yet ended. */
  openBefore: number[];
  /** Resolves when the `n`-th connection (1-based) has been accepted. */
  accepted(n: number): Promise<void>;
}

/** Accepts every connection, reads (and drops) what arrives, never writes a byte. */
export async function holdServer(): Promise<HoldServer> {
  const live = new Set<Socket>();
  const all = new Set<Socket>();
  const openBefore: number[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const server = createNetServer((socket) => {
    openBefore.push(live.size);
    live.add(socket);
    all.add(socket);
    const ended = () => live.delete(socket);
    socket.once("end", ended);
    socket.once("close", ended);
    socket.on("error", ended);
    socket.resume();
    for (const waiter of waiters.filter((entry) => entry.n <= openBefore.length)) {
      waiter.resolve();
    }
  });
  const port = await listen(server, () => {
    for (const socket of all) socket.destroy();
  });
  return {
    port,
    openBefore,
    accepted: (n) =>
      n <= openBefore.length
        ? Promise.resolve()
        : new Promise((resolve) => {
            waiters.push({ n, resolve });
          }),
  };
}

/** Counts accepted connections and answers none. */
export async function countingServer(): Promise<{ port: number; connections(): number }> {
  let count = 0;
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.resume();
  });
  const port = await listen(server, () => {
    for (const socket of sockets) socket.destroy();
  });
  return { port, connections: () => count };
}

/** An HTTP server that answers every request with `answer`. */
export async function scriptedServer(answer: (response: ServerResponse) => void): Promise<number> {
  const server = createHttpServer((_request, response) => {
    answer(response);
  });
  return listen(server, () => {
    server.closeAllConnections();
  });
}

/** A loopback port that was just bound and released: connecting to it is refused. */
export async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function listen(
  server: Server | ReturnType<typeof createHttpServer>,
  drop: () => void,
): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  opened.push(async () => {
    drop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return address.port;
}
