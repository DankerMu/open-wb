/** One request the fake received: its body is the parsed JSON when it parses, else the raw text. */
export interface FakeMcpHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FakeMcpHttpStartOptions {
  /** `"json"` (default): 200 JSON `initialize` result; `"sse"`: the same as one SSE event, stream left open. */
  reply?: "json" | "sse";
  status?: number;
  contentType?: string;
  /** A raw body (the response then ends), or one built from the request. */
  body?: string | ((request: FakeMcpHttpRequest) => string);
}

export interface FakeMcpHttpServer {
  port: number;
  /** A copy of every request so far, in arrival order. */
  requests(): FakeMcpHttpRequest[];
  close(): Promise<void>;
}

export function start(options?: FakeMcpHttpStartOptions): Promise<FakeMcpHttpServer>;
