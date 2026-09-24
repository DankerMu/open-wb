export interface FakeUpstreamStartOptions {
  port?: number;
  apiKey?: string;
  gateTtlMs?: number;
}

export interface FakeUpstreamServer {
  port: number;
  close(): Promise<void>;
}

export function start(options?: FakeUpstreamStartOptions): Promise<FakeUpstreamServer>;
