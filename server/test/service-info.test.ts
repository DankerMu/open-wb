import { describe, expect, it } from "vitest";
import { isSemver, SERVICE_INFO } from "../src/service-info.js";

describe("service-info", () => {
  it("版本号是合法 semver", () => {
    expect(isSemver(SERVICE_INFO.version)).toBe(true);
  });
  it("拒绝非法版本号", () => {
    expect(isSemver("1.2")).toBe(false);
    expect(isSemver("v1.2.3")).toBe(false);
    expect(isSemver("1.2.3-rc.1")).toBe(true);
  });
});
