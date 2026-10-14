/**
 * A loopback listener that accepts TCP and never writes a byte: addressed as
 * `https://127.0.0.1:<port>` the TLS handshake stalls, which is the connection-deadline case of
 * model-proxy (design D17). A black-hole address is not used: depending on the network it answers
 * EHOSTUNREACH quickly. `accepted()` counts the connections taken, `released()` those the client has
 * closed since; `close` destroys every socket.
 */
import { createServer, type Socket } from "node:net";

export interface StalledHandshake {
  port: number;
  accepted(): number;
  released(): number;
  close(): Promise<void>;
}

export async function startStalledHandshake(): Promise<StalledHandshake> {
  const sockets: Socket[] = [];
  let released = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.once("close", () => {
      released += 1;
    });
    socket.resume();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("stalled handshake listener did not bind a TCP address");
  }
  return {
    port: address.port,
    accepted: () => sockets.length,
    released: () => released,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
