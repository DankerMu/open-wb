/**
 * Simple CSV splitter ported from resource/workbuddy-live-demo.html:3932-3938.
 * Whole-input trim, newline rows, comma cells; first row is headers.
 * Quoted fields and embedded delimiters are out of demo scope.
 * With a tab delimiter only the line breaks at both ends are dropped: a leading or trailing
 * tab is an empty cell, and trimming it would shift the header row against the data.
 */

export function parseCsv(
  text: string,
  delimiter: "," | "\t" = ",",
): { headers: string[]; rows: string[][] } {
  const trimmed = delimiter === "\t" ? text.replace(/^[\r\n]+|[\r\n]+$/g, "") : text.trim();
  const rows = trimmed === "" ? [] : trimmed.split("\n").map((row) => row.split(delimiter));
  const headers = rows.shift() ?? [];
  return { headers, rows };
}
