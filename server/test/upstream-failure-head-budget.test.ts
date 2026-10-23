/**
 * Issue #1716 task 1.2: the cost bound of the cut-tail drop in `upstreamExcerpt(…, true)`
 * (upstream-failure「截断尾部丢弃的计算上界」, design D2–D5).
 *
 * The reference below is the pre-fix private chain of `core/upstream-failure.ts` (master
 * `167f8521`), copied verbatim: `redact`, `replaceSecrets`, `orderedSecrets`, `dropSecretHead`,
 * `normalize`, `dropControls`, `capPoints` and the constants they read. Within the budget the fixed
 * `upstreamExcerpt` must be byte-identical to `referenceExcerpt`; over it, the excerpt is `""`.
 * Synchronous calls cannot be cut off by the `it` timeout, so elapsed times are asserted too (the
 * `core-base-url.test.ts` precedent). All sentinels are low-entropy `wb-issue1716-*` strings.
 */
import { describe, expect, it } from "vitest";
import {
  statusReply,
  TRUNCATED_MARK,
  upstreamExcerpt,
  upstreamSecretList,
} from "../src/core/upstream-failure.js";

// ---- Reference: the pre-fix chain, verbatim ----------------------------------------------------

const REF_REMOVED = "[已移除]";
const REF_MAX_SANITIZED_POINTS = 2000;
const REF_MAX_EXCERPT_POINTS = 1000;
const REF_DUMP_LINE = /^raw-http-request(?:-save-failed)?=/u;
const REF_BEARER = /Bearer\s+\S+/giu;
const REF_SK_KEY = /sk-[A-Za-z0-9_-]{16,}/gu;
const REF_SK_TAIL = /sk-[A-Za-z0-9_-]*$/u;

function referenceExcerpt(text: string, secrets: readonly string[], cut = false): string {
  const replaced = refRedact(text, secrets);
  const kept = cut ? refDropSecretHead(replaced, secrets) : replaced;
  const flat = refCapPoints(kept.trimEnd(), REF_MAX_SANITIZED_POINTS).replace(/[\n\t]+/gu, " ");
  return refCapPoints(flat, REF_MAX_EXCERPT_POINTS);
}

function refRedact(text: string, secrets: readonly string[]): string {
  const lines = refNormalize(text)
    .split("\n")
    .filter((line) => !REF_DUMP_LINE.test(line));
  const result = refReplaceSecrets(lines.join("\n"), refOrderedSecrets(secrets));
  return result.replace(REF_BEARER, `Bearer ${REF_REMOVED}`).replace(REF_SK_KEY, REF_REMOVED);
}

function refReplaceSecrets(text: string, ordered: readonly string[]): string {
  let result = text;
  for (const secret of ordered) {
    result = result.split(secret).join(REF_REMOVED);
  }
  return result;
}

function refOrderedSecrets(secrets: readonly string[]): string[] {
  return secrets
    .map(refNormalize)
    .filter((secret) => secret !== "")
    .sort((a, b) => b.length - a.length);
}

function refDropSecretHead(text: string, secrets: readonly string[]): string {
  const ordered = refOrderedSecrets(secrets);
  let end = text.length;
  for (const secret of ordered) {
    for (let length = secret.length - 1; length > 0; length -= 1) {
      const head = refReplaceSecrets(secret.slice(0, length), ordered);
      if (text.endsWith(head)) {
        end = Math.min(end, text.length - head.length);
        break;
      }
    }
  }
  const sk = REF_SK_TAIL.exec(text);
  return text.slice(0, sk === null ? end : Math.min(end, sk.index));
}

function refNormalize(text: string): string {
  return refDropControls(text.replace(/\r\n?|[\u2028\u2029]/gu, "\n"));
}

function refDropControls(text: string): string {
  let kept = "";
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x08 || (unit >= 0x0b && unit <= 0x1f) || unit === 0x7f) {
      continue;
    }
    kept += text[index];
  }
  return kept;
}

function refCapPoints(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) {
    return text;
  }
  return points.slice(0, max - Array.from(TRUNCATED_MARK).length).join("") + TRUNCATED_MARK;
}

// ---- Fixtures ----------------------------------------------------------------------------------

/** Under-budget exactness: the fixed excerpt equals the reference, and the expected literal. */
function expectSameAsReference(text: string, secrets: readonly string[], expected: string): string {
  const excerpt = upstreamExcerpt(text, secrets, true);
  expect(excerpt).toBe(referenceExcerpt(text, secrets, true));
  expect(excerpt).toBe(expected);
  return excerpt;
}

/** No tail of an under-budget excerpt is a proper prefix of a secret as the replacement leaves it. */
function expectNoSecretHead(excerpt: string, secrets: readonly string[]): void {
  const leaked = headShapes(secrets).find((shape) => excerpt.endsWith(shape));
  expect(leaked, `${excerpt} ends with a secret's head`).toBeUndefined();
}

const SHAPES = new WeakMap<readonly string[], string[]>();

/** Every proper prefix of every secret as the reference replacement leaves it (memoised per list). */
function headShapes(secrets: readonly string[]): string[] {
  const known = SHAPES.get(secrets);
  if (known !== undefined) {
    return known;
  }
  const ordered = refOrderedSecrets(secrets);
  const shapes = ordered.flatMap((secret) =>
    Array.from({ length: secret.length - 1 }, (_, index) =>
      refReplaceSecrets(secret.slice(0, index + 1), ordered),
    ),
  );
  SHAPES.set(secrets, shapes);
  return shapes;
}

/** `https://<host>/<segments…>` with every segment at least 8 long, as an admin may register it. */
function pathUpstream(host: string, segments: readonly string[], apiKey?: string): string[] {
  return upstreamSecretList({
    apiKey,
    baseUrl: `https://${host}/${segments.join("/")}`,
    paths: [],
  });
}

/** `count` distinct 8-character segments: `s0000000`, `s0000001`, … */
function segments(count: number, tag = "s"): string[] {
  const width = 8 - tag.length;
  return Array.from({ length: count }, (_, index) => `${tag}${String(index).padStart(width, "0")}`);
}

/** The registry's `secrets()` shape: every upstream's list, in order, deduplicated. */
function union(lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}

/** A body of exactly `size` code units: `x` filler, then `tail`. `x` ends no secret here. */
function cutBody(size: number, tail: string): string {
  return `${"x".repeat(size - tail.length)}${tail}`;
}

const KIB16 = 16 * 1024;
const OVER_BUDGET_503 =
  '{"error":{"message":"模型服务返回 HTTP 503","type":"wb_upstream","param":"status.503"}}';

/** 50 upstreams × (key, base URL, pathname, three ≥ 8 segments) = 300 secrets (spec 常规规模). */
const NORMAL_SCALE = union(
  Array.from({ length: 50 }, (_, index) => {
    const n = String(index).padStart(2, "0");
    return pathUpstream(
      `wb-issue1716-${n}.test`,
      [`seg-${n}-alpha`, `seg-${n}-bravo`, `seg-${n}-charlie`, "v1"],
      `wb-issue1716-key-${n}`.padEnd(32, "k"),
    );
  }),
);

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

/** Deterministic PRNG (mulberry32) for the randomized equivalence. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Scenarios ---------------------------------------------------------------------------------

describe("cut-tail drop: equivalence with the full per-prefix comparison (#1716)", () => {
  it("every cut fixture of upstream-failure-sanitize.test.ts", () => {
    const key = "wb-issue909-cut-boundary-key";
    for (let length = 1; length < key.length; length += 1) {
      const excerpt = expectSameAsReference(`busy\n${key.slice(0, length)}`, [key], "busy");
      expectNoSecretHead(excerpt, [key]);
    }
    const after = "0123456789abcdefghij";
    expectNoSecretHead(expectSameAsReference(`${key}${after}`, [key], `[已移除]${after}`), [key]);
    expectSameAsReference(`busy ${key.slice(0, 20)}\u0001\u0001`, [key], "busy");
    expectSameAsReference("busy sk-abcdefghijklmno", [], "busy");

    const baseUrl = "https://models.example/tenant-0123456789/abcdefg/hijklmn";
    const secrets = upstreamSecretList({ apiKey: "wb-key-909", baseUrl, paths: [] });
    for (const text of [
      "busy https://models.example/tenant-0123456789/abcdefg/hij",
      "busy /tenant-0123456789/abcdefg/hij",
      "busy https://models.example/tenant-01",
    ]) {
      expectNoSecretHead(expectSameAsReference(text, secrets, "busy"), secrets);
    }
  });

  it("a shorter secret straddling the cut of a longer secret's head", () => {
    // `straddle` starts inside the cut head and ends past the cut, so it is not replaced there;
    // `issue1716` lies wholly inside the head and is replaced first. The head goes as a whole.
    const long = "wb-issue1716-long-straddle-secret";
    const secrets = [long, "straddle", "issue1716"];
    const text = `busy ${long.slice(0, long.indexOf("straddle") + 4)}`;
    expect(text).toBe("busy wb-issue1716-long-stra");
    expectNoSecretHead(expectSameAsReference(text, secrets, "busy"), secrets);
  });

  it("small randomized secret sets with `[`, `]` and `[已移除]` pieces stay exact", () => {
    const random = prng(1716);
    const pieces = ["a", "b", "/", "[", "]", "已", "移除", "[已移除]", "[已", "移除]"];
    const word = (max: number): string => {
      let out = "";
      const count = 1 + Math.floor(random() * max);
      for (let index = 0; index < count; index += 1) {
        out += pieces[Math.floor(random() * pieces.length)];
      }
      return out;
    };
    for (let round = 0; round < 3000; round += 1) {
      const secrets = Array.from({ length: 1 + Math.floor(random() * 5) }, () => word(6));
      const pick = random();
      const secret = secrets[Math.floor(random() * secrets.length)] ?? "";
      const ending =
        pick < 0.5
          ? secret.slice(0, Math.floor(random() * secret.length))
          : pick < 0.75
            ? "]"
            : "[已移除]";
      // `ok ` is in no secret, so the reference never answers `""`: equality proves no fail-closed.
      const text = `ok ${word(4)}${ending}`;
      expect(upstreamExcerpt(text, secrets, true), JSON.stringify({ text, secrets })).toBe(
        referenceExcerpt(text, secrets, true),
      );
    }
  });

  it("a head whose shape ends in `]` but not in `[已移除]` is still compared (design D2)", () => {
    // `XYZ` is replaced inside the head, then `[已` inside that mark: `zz[已移除]移除]`.
    const secrets = ["zzXYZw", "XYZ", "[已"];
    expect(refReplaceSecrets("zzXYZ", refOrderedSecrets(secrets))).toBe("zz[已移除]移除]");
    expectNoSecretHead(expectSameAsReference("ok zzXYZ", secrets, "ok"), secrets);
  });

  it("the replacement mark ends in `]`, which the pruning relies on (design Risks)", () => {
    expect(upstreamExcerpt("k", ["k"])).toBe("[已移除]");
  });
});

describe("cut-tail drop: normal scale is unchanged (spec 常规规模行为不变)", () => {
  it("50 upstreams / 300 secrets, body ending in a secret's head with a straddling segment", () => {
    expect(NORMAL_SCALE).toHaveLength(300);
    const baseUrl = "https://wb-issue1716-37.test/seg-37-alpha/seg-37-bravo/seg-37-charlie/v1";
    expect(NORMAL_SCALE).toContain(baseUrl);
    // Cut inside `seg-37-bravo`: `seg-37-alpha` was replaced inside the head, bravo straddles.
    const text = cutBody(KIB16, ` busy ${baseUrl.slice(0, baseUrl.indexOf("bravo") + 2)}`);
    const excerpt = expectSameAsReference(
      text,
      NORMAL_SCALE,
      `${"x".repeat(994)}${TRUNCATED_MARK}`,
    );
    expectNoSecretHead(excerpt, NORMAL_SCALE);
    // The same tail on a short body shows what was dropped.
    const short = `busy ${baseUrl.slice(0, baseUrl.indexOf("bravo") + 2)}`;
    expectNoSecretHead(expectSameAsReference(short, NORMAL_SCALE, "busy"), NORMAL_SCALE);
    const key = `wb-issue1716-key-12`.padEnd(32, "k");
    expectSameAsReference(`busy ${key.slice(0, 25)}`, NORMAL_SCALE, "busy");
  });

  it("50 upstreams / 300 secrets, bodies ending in `[已移除]` are not failed closed", () => {
    // A whole base URL echoed last: replaced, and no head shape ends ` [已移除]`, so it stays.
    const whole = "https://wb-issue1716-05.test/seg-05-alpha/seg-05-bravo/seg-05-charlie/v1";
    const kept = expectSameAsReference(`busy ${whole}`, NORMAL_SCALE, "busy [已移除]");
    expectNoSecretHead(kept, NORMAL_SCALE);
    // A pathname cut after two whole segments reads `/[已移除]/[已移除]`: that head goes.
    const dropped = expectSameAsReference("busy /seg-05-alpha/seg-05-bravo", NORMAL_SCALE, "busy");
    expectNoSecretHead(dropped, NORMAL_SCALE);
    // At 16 KiB, ending in the mark.
    expectSameAsReference(
      cutBody(KIB16, ` ${whole}`),
      NORMAL_SCALE,
      `${"x".repeat(994)}${TRUNCATED_MARK}`,
    );
  });
});

describe("cut-tail drop: pathological secret sets do not block (spec 病态密钥集不阻塞)", () => {
  // Red before the fix: every prefix of each of the 602 secrets re-ran the replacement over all of
  // them, 3.8 s here (#1716 measured 4.4 s). After it the tail `0` leaves thousands of candidates,
  // about 17 times the budget: the excerpt fails closed.
  it("a 600-segment base URL with a body ending in a segment head", { timeout: 60_000 }, () => {
    const segs = segments(600);
    const secrets = pathUpstream("wb-issue1716.test", segs);
    expect(secrets).toHaveLength(602);
    const text = cutBody(KIB16, ` ${segs[599]?.slice(0, 5) ?? ""}`);
    const { value, ms } = timed(() => upstreamExcerpt(text, secrets, true));
    expect(ms).toBeLessThan(1000);
    expect(value).toBe("");
  });

  it('a 16 KB base URL of about 1780 segments, body ending `[已移除]`, answers `""`', () => {
    const secrets = pathUpstream("wb-issue1716.test", segments(1780));
    expect(secrets[0]?.length).toBeGreaterThan(16_000);
    const text = cutBody(KIB16, " s0001779");
    const { value, ms } = timed(() => upstreamExcerpt(text, secrets, true));
    expect(ms).toBeLessThan(1000);
    expect(value).toBe("");
    // The proxy then answers the status alone (model-proxy ≥500 一节).
    expect(statusReply(503, value).body).toBe(OVER_BUDGET_503);
  });

  it('ten upstreams with over 1000 secrets, body ending `[已移除]`, answer `""`', () => {
    const secrets = union(
      Array.from({ length: 10 }, (_, index) =>
        pathUpstream(
          `wb-issue1716-${String(index)}.test`,
          segments(100, `u${String(index)}`),
          `wb-issue1716-key-${String(index)}`.padEnd(32, "k"),
        ),
      ),
    );
    expect(secrets.length).toBeGreaterThanOrEqual(1000);
    const text = cutBody(KIB16, " [已移除]");
    const { value, ms } = timed(() => upstreamExcerpt(text, secrets, true));
    expect(ms).toBeLessThan(1000);
    expect(value).toBe("");
  });

  it("the same 16 KB set with a body ending in `}` keeps its excerpt (剪枝后的大密钥集照常放行)", () => {
    const segs = segments(1780);
    const secrets = pathUpstream("wb-issue1716.test", segs);
    const baseUrl = secrets[0] ?? "";
    // `}` and `y` are in no secret: no candidate prefix survives the pruning, nothing is dropped.
    expect(secrets.some((secret) => secret.includes("}") || secret.includes("y"))).toBe(false);
    const text = `${baseUrl} ${"y".repeat(KIB16 - baseUrl.length - 2)}}`;
    expect(text).toHaveLength(KIB16);
    const { value, ms } = timed(() => upstreamExcerpt(text, secrets, true));
    expect(ms).toBeLessThan(1000);
    expect(value).toBe(`[已移除] ${"y".repeat(KIB16 - baseUrl.length - 2)}}`);
  });
});
