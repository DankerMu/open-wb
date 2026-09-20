/**
 * Simple CSV splitter ported from resource/workbuddy-live-demo.html:3932-3938.
 * Whole-input trim, newline rows, comma cells; first row is headers.
 * Quoted fields and embedded delimiters are out of demo scope.
 */

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const trimmed = text.trim();
  const rows = trimmed === "" ? [] : trimmed.split("\n").map((row) => row.split(","));
  const headers = rows.shift() ?? [];
  return { headers, rows };
}
