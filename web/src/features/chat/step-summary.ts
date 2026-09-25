/** One-line step summary for step cards (S1e 4.2 / parent design D8). */

const MAX_CODE_POINTS = 120;

function firstLine(value: string): string {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

function truncate(value: string): string {
  return Array.from(value).slice(0, MAX_CODE_POINTS).join("");
}

function pickFromObject(record: Record<string, unknown>): string {
  for (const key of ["text", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const first = Object.entries(record)[0];
  if (!first) return "";
  const [key, value] = first;
  return `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
}

/**
 * JSON object detail: non-empty `text`, else non-empty `content`, else `<key>: <value>` of the
 * first key; any other detail is read as text. The result is the first non-empty line, trimmed,
 * cut to 120 code points.
 */
export function summarizeStepDetail(detail: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    parsed = undefined;
  }
  const source =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? pickFromObject(parsed as Record<string, unknown>)
      : detail;
  return truncate(firstLine(source));
}
