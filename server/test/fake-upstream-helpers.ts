import {
  type FakeUpstreamServer,
  type FakeUpstreamStartOptions,
  start,
} from "./support/fake-upstream.mjs";

export async function startTrackedFakeUpstream(
  handles: FakeUpstreamServer[],
  options?: FakeUpstreamStartOptions,
): Promise<FakeUpstreamServer> {
  const handle = await start(options);
  handles.push(handle);
  return handle;
}

export interface StreamSnapshot {
  records: string[];
  chunks: Array<Record<string, unknown>>;
  parts: string[];
}

export function streamSnapshot(text: string): StreamSnapshot {
  const records = parseDataRecords(text);
  const chunks = records
    .filter((record) => record !== "[DONE]")
    .map((record) => asRecord(JSON.parse(record), "chunk"));
  return { records, chunks, parts: collectContent(chunks) };
}

export function parseDataRecords(text: string): string[] {
  const records: string[] = [];
  for (const event of text.split(/\r?\n\r?\n/u)) {
    if (event.trim().length === 0) {
      continue;
    }
    const dataLines: string[] = [];
    for (const line of event.split(/\r?\n/u)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) {
      records.push(dataLines.join("\n"));
    }
  }
  return records;
}

export function collectContent(chunks: Array<Record<string, unknown>>): string[] {
  const parts: string[] = [];
  for (const chunk of chunks) {
    const content = asRecord(firstChoice(chunk).delta, "delta").content;
    if (typeof content === "string" && content.length > 0) {
      parts.push(content);
    }
  }
  return parts;
}

export function finishReason(chunks: Array<Record<string, unknown>>): unknown {
  const last = chunks[chunks.length - 1];
  if (last === undefined) {
    return undefined;
  }
  return firstChoice(last).finish_reason;
}

export function firstChoice(chunk: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) {
    throw new Error("chunk.choices must be a nonempty array");
  }
  return asRecord(chunk.choices[0], "choice");
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonRecord(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value;
}
