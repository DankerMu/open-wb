export interface FakeUpstreamStartOptions {
  port?: number;
  apiKey?: string;
  gateTtlMs?: number;
  /**
   * Which messages decide whether a request is a tool round: `"history"` (default) — the whole
   * history holds no `tool` message; `"turn"` — no `tool` message follows the last `user` message.
   */
  toolRoundScope?: "history" | "turn";
  /** GET /models answers this status (400–599) with a scripted error body instead of the listing. */
  modelsStatus?: number;
}

/** One GET /models request (accepted or 401): its Authorization header, `null` when absent. */
export interface FakeUpstreamModelsRequest {
  authorization: string | null;
}

/**
 * One accepted chat-completions request: its top-level `model`, the length of `messages`, and the
 * number `max_tokens` (else the number `max_completion_tokens`, else `null`).
 */
export interface FakeUpstreamRequest {
  model: string | null;
  messages: number;
  maxTokens: number | null;
}

export interface FakeUpstreamServer {
  port: number;
  /** A copy of the request record (`GET /__control/requests`): arrival order, latest 1000. */
  requests(): FakeUpstreamRequest[];
  /** A copy of the GET /models record: arrival order, latest 1000. */
  modelsRequests(): FakeUpstreamModelsRequest[];
  close(): Promise<void>;
}

export function start(options?: FakeUpstreamStartOptions): Promise<FakeUpstreamServer>;
