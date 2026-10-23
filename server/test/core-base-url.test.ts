/**
 * s1d-registry-followups groups 1 and 3 (#1712, #1710): core/base-url.ts, model-registry「上游地址的
 * 视图形式与拼接」(`withoutUserinfo` / `userinfoParts` / `upstreamEndpoint`; design D2–D4). Expected
 * views, part lists and endpoints are literals written from the spec text and the WHATWG URL rules,
 * not computed by the code under test.
 */
import { describe, expect, it } from "vitest";
import { upstreamEndpoint, userinfoParts, withoutUserinfo } from "../src/core/base-url.js";
import { upstreamSecretList } from "../src/core/upstream-failure.js";

/** Low-entropy sentinel (gitleaks): the password of every userinfo form below. */
const PW = "wb-issue1712-pw";

/** The four non-canonical seed forms WHATWG parses with userinfo but a `scheme://`-only regex misses. */
const NON_CANONICAL: readonly (readonly [string, string])[] = [
  [`http:/u:${PW}@gw.example/v1`, "http://gw.example/v1"],
  [`http:u:${PW}@gw.example/v1`, "http://gw.example/v1"],
  [`https:\\u:${PW}@gw.example/v1`, "https://gw.example/v1"],
  [` https://u:${PW}@gw.example/v1`, "https://gw.example/v1"],
];

/**
 * Non-canonical seed forms WHATWG does not give a userinfo: the first two throw (`:abc` port, space in
 * the host), `foo:/…` parses as a non-special URL whose `@` stays in the path. Only the widened
 * fallback regex (leading whitespace, any `/` or `\` after the colon) takes their userinfo.
 */
const REGEX_ONLY: readonly (readonly [string, string, boolean])[] = [
  [` https://u:${PW}@h:abc/v1`, "https://h:abc/v1", true],
  [`https:\\u:${PW}@ho st/v1`, "https:\\ho st/v1", true],
  [`foo:/u:${PW}@h`, "foo:/h", false],
];

/**
 * A `\` inside the userinfo (#1713 round 2): master's `[^/?#]*` userinfo class allows it and so must
 * the fallback. An unencoded `\` in the password makes WHATWG throw; `DOMAIN\u:…@` parses with the
 * `\` as a path separator (host `domain`, no userinfo). Expected parts are the regex's raw userinfo
 * and its password segment.
 */
const BACKSLASH_USERINFO: readonly (readonly [string, string, boolean, readonly string[]])[] = [
  [`https://u:${PW}\\x@h/v1`, "https://h/v1", true, [`u:${PW}\\x`, `${PW}\\x`]],
  [`http://DOMAIN\\u:${PW}@h/v1`, "http://h/v1", false, [`DOMAIN\\u:${PW}`, PW]],
];

function expectParse(input: string, throws: boolean) {
  if (throws) {
    expect(() => new URL(input)).toThrow();
  } else {
    expect(new URL(input)).toMatchObject({ username: "", password: "" });
  }
}

describe("withoutUserinfo", () => {
  it.each(NON_CANONICAL)("drops the userinfo of the non-canonical form %j", (input, view) => {
    expect(withoutUserinfo(input)).toBe(view);
  });

  it.each([
    ["https://u:p@h/v1", "https://h/v1"],
    ["https://tok-0123@gw.example/", "https://gw.example/"],
    ["https://u:p%40ss%3Aw@h/v1", "https://h/v1"],
    // Empty userinfo: parses with no username/password, the regex still takes the `@` away.
    ["https://@host/v1", "https://host/v1"],
  ])("drops the userinfo of %j", (input, view) => {
    expect(withoutUserinfo(input)).toBe(view);
  });

  it.each([
    "https://gw.example/v1",
    "http://127.0.0.1:9/tenant-0123456789/v1?org=a",
    // Parses (to `http://gw.example/v1`) but has no userinfo: returned as given, not normalised.
    "http:gw.example/v1",
    "HTTPS://GW.example/v1",
    // An `@` after the authority (in the path) is not userinfo.
    "https://h/a@b",
    "",
  ])("returns %j without userinfo unchanged", (input) => {
    expect(withoutUserinfo(input)).toBe(input);
  });

  it.each([
    ["https://u:p@ho st/v1", "https://ho st/v1"],
    ["https://u:p@[::1/v1", "https://[::1/v1"],
    ["not a url @ all", "not a url @ all"],
  ])("falls back to the regex for the unparseable %j", (input, view) => {
    expect(() => new URL(input)).toThrow();
    expect(withoutUserinfo(input)).toBe(view);
  });

  it.each(REGEX_ONLY)(
    "drops the userinfo of %j through the widened regex",
    (input, view, throws) => {
      expectParse(input, throws);
      expect(withoutUserinfo(input)).toBe(view);
      expect(withoutUserinfo(input)).not.toContain(PW);
    },
  );
});

describe("userinfoParts", () => {
  it.each(NON_CANONICAL)("lists the whole userinfo and the password of %j", (input) => {
    expect(userinfoParts(input)).toEqual([`u:${PW}`, PW]);
  });

  it.each(REGEX_ONLY)(
    "lists the userinfo and password of %j through the widened regex",
    (input, _view, throws) => {
      expectParse(input, throws);
      expect(userinfoParts(input)).toEqual([`u:${PW}`, PW]);
    },
  );

  it.each([
    ["https://u:p@h/v1", ["u:p", "p"]],
    // No password segment: the whole userinfo (the user name) is the one part.
    ["https://tok-0123@gw.example/", ["tok-0123"]],
    // Empty password: the raw `admin:` is listed, the bare user name `admin` never.
    ["https://admin:@h/v1", ["admin:"]],
    // Percent-encoded password: raw and decoded forms both.
    ["https://u:p%40ss%3Aw@h/v1", ["u:p%40ss%3Aw", "p%40ss%3Aw", "u:p@ss:w", "p@ss:w"]],
    // A malformed escape is listed raw only (decoding fails and is skipped).
    ["https://u:p%ZZ@h/v1", ["u:p%ZZ", "p%ZZ"]],
    // Unparseable: what the regex takes.
    ["https://u:p@ho st/v1", ["u:p", "p"]],
    ["https://@host/v1", []],
    ["https://gw.example/v1", []],
    ["", []],
  ] as const)("lists %j as %j", (input, parts) => {
    expect(userinfoParts(input)).toEqual(parts);
  });

  it("upstreamSecretList for a non-canonical form lists the password but never the user name alone", () => {
    const list = upstreamSecretList({ baseUrl: `http:/u:${PW}@gw.example/v1`, paths: [] });
    expect(list).toContain(PW);
    expect(list).toContain(`u:${PW}`);
    expect(list).not.toContain("u");
  });
});

describe("a backslash inside the userinfo (#1713 round 2)", () => {
  it.each(BACKSLASH_USERINFO)(
    "%j: the view is %j and the parts carry the password",
    (input, view, throws, parts) => {
      expectParse(input, throws);
      expect(withoutUserinfo(input)).toBe(view);
      expect(withoutUserinfo(input)).not.toContain(PW);
      expect(userinfoParts(input)).toEqual(parts);
      expect(userinfoParts(input).some((part) => part.includes(PW))).toBe(true);
    },
  );
});

describe("a long run of slashes and backslashes without `@` (#1713 round 3)", () => {
  // The prefix `[/\\]*` and the userinfo must not both take a `\`: that tries every split, O(n²).
  // A synchronous call cannot be cut off by the `it` timeout, so the elapsed time is asserted too.
  it("returns the input unchanged and no parts in linear time", { timeout: 1000 }, () => {
    const input = `https:${"\\".repeat(100_000)}`;
    const started = performance.now();
    expect(withoutUserinfo(input)).toBe(input);
    expect(userinfoParts(input)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

/** spec「拼接保留查询串且既有形状不变」, `sub = "chat/completions"`, in the spec's order. */
const ENDPOINTS: readonly (readonly [string, string])[] = [
  ["http://h/v1", "http://h/v1/chat/completions"],
  ["http://h/v1/", "http://h/v1/chat/completions"],
  ["http://h", "http://h/chat/completions"],
  ["http://h/tenant/v1?org=a", "http://h/tenant/v1/chat/completions?org=a"],
  ["http://h/v1#frag", "http://h/v1/chat/completions"],
];

describe("upstreamEndpoint (#1710)", () => {
  it.each(ENDPOINTS)("%j + chat/completions is %j", (baseUrl, endpoint) => {
    expect(upstreamEndpoint(baseUrl, "chat/completions").href).toBe(endpoint);
  });

  it("a path ending in several slashes loses them all; the probe's sub joins the same prefix", () => {
    expect(upstreamEndpoint("http://h/v1//", "chat/completions").href).toBe(
      "http://h/v1/chat/completions",
    );
    expect(upstreamEndpoint("http://h/tenant/v1/?org=a", "models").href).toBe(
      "http://h/tenant/v1/models?org=a",
    );
  });

  it("keeps the userinfo on the URL", () => {
    expect(upstreamEndpoint("http://u:p@h/v1", "models").href).toBe("http://u:p@h/v1/models");
  });

  it("throws on what WHATWG cannot parse (both call sites catch it)", () => {
    expect(() => upstreamEndpoint("http://h:abc/v1", "models")).toThrow(TypeError);
  });

  // `/\/+$/u` retries every start of a long slash run that does not reach the end: O(n²).
  it("trims a long run of slashes not at the end in linear time", { timeout: 1000 }, () => {
    const run = "/".repeat(100_000);
    const started = performance.now();
    expect(upstreamEndpoint(`http://h/${run}x`, "models").href).toBe(`http://h/${run}x/models`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
