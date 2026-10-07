export interface FakeUpstreamStartOptions {
  port?: number;
  apiKey?: string;
  gateTtlMs?: number;
}

/** One accepted chat-completions request: its top-level `model` and the length of `messages`. */
export interface FakeUpstreamRequest {
  model: string | null;
  messages: number;
}

export interface FakeUpstreamServer {
  port: number;
  /** A copy of the request record (`GET /__control/requests`): arrival order, latest 1000. */
  requests(): FakeUpstreamRequest[];
  close(): Promise<void>;
}

export function start(options?: FakeUpstreamStartOptions): Promise<FakeUpstreamServer>;
