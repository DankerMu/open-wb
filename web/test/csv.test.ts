import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/features/files/csv.js";

describe("parseCsv", () => {
  it("uses the first row as headers and counts two data rows", () => {
    const table = parseCsv("name,size\nalpha,1\nbeta,2\n");

    expect(table.headers).toEqual(["name", "size"]);
    expect(table.rows).toEqual([
      ["alpha", "1"],
      ["beta", "2"],
    ]);
    expect(table.rows.length).toBe(2);
  });

  it("returns zero data rows for empty input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
    expect(parseCsv("   \n  ")).toEqual({ headers: [], rows: [] });
  });
});
