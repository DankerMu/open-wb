/**
 * Request bodies omp sends upstream, for the official-binary cases. The fake upstream's own record
 * keeps no message content (omp-test-harness「受控上游请求记录」), so `bodyRecorder` puts a loopback
 * forwarder in front of it that keeps every request body; `toolMessages` reads the `role:"tool"`
 * messages of one OpenAI chat request body. Moved here from omp-official-rpc-ui.test.ts (#1975) so the
 * proxied app world (`recordBodies`) and the rpc-ui cases share one recorder.
 */
import { createServer, request as forward } from "node:http";
import type { AddressInfo } from "node:net";
import { onTeardown } from "./omp-official.js";

/** A forwarder on loopback to `upstreamPort` that keeps every request body; closed at teardown. */
export async function bodyRecorder(
  upstreamPort: number,
): Promise<{ port: number; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const server = createServer((incoming, outgoing) => {
    const parts: Buffer[] = [];
    incoming.on("data", (part: Buffer) => parts.push(part));
    incoming.on("end", () => {
      const body = Buffer.concat(parts);
      bodies.push(JSON.parse(body.toString("utf8")) as unknown);
      const relay = forward(
        {
          host: "127.0.0.1",
          port: upstreamPort,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(outgoing);
        },
      );
      relay.on("error", () => outgoing.destroy());
      relay.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTeardown(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { port, bodies };
}

/** One `role:"tool"` message of a request body. */
interface ToolMessage {
  toolCallId: unknown;
  /** The name of the assistant `tool_calls` entry whose `id` is this message's `tool_call_id`. */
  name: string | undefined;
  /** `content` as text: the string itself, or the text parts joined. */
  text: string | undefined;
  message: Record<string, unknown>;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content.map((part: { text?: unknown }) => String(part.text ?? "")).join("")
    : undefined;
}

/** Every `role:"tool"` message of an OpenAI chat request body, in order. */
export function toolMessages(body: unknown): ToolMessage[] {
  const messages = (body as { messages?: Array<Record<string, unknown>> }).messages ?? [];
  const calls = messages.flatMap(
    (message) =>
      (message.tool_calls as Array<{ id: string; function: { name: string } }> | undefined) ?? [],
  );
  return messages
    .filter((message) => message.role === "tool")
    .map((message) => ({
      toolCallId: message.tool_call_id,
      name: calls.find((call) => call.id === message.tool_call_id)?.function.name,
      text: contentText(message.content),
      message,
    }));
}
