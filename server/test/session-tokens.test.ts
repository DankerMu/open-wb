/**
 * Issue #90 TokenRegistry public API: issue, exact lookup, rotation,
 * revocation, instance isolation, and fail-closed entropy/collision.
 */
import nodeCrypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenLookup } from "../src/model-proxy/index.js";
import type { SessionTokens } from "../src/sessions/omp/runtime.js";
import { TokenRegistry } from "../src/sessions/tokens.js";

const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;
const ISSUANCE_COUNT = 1000;
const BYTE_LENGTH = 32;

const SESSION_A = "session-a";
const SESSION_B = "session-b";
const UNKNOWN_SESSION = "session-unknown";

afterEach(() => {
  restoreCrypto();
});

/**
 * 32-byte sequences whose lowercase hex encodings contain both digits and
 * letters, so case-altered lookup cannot accidentally match an all-numeric
 * token.
 */
const LIVE_A_BYTES = Buffer.from([
  0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f, 0x60, 0x71, 0x82, 0x93, 0xa4, 0xb5, 0xc6, 0xd7, 0xe8, 0xf9,
  0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe, 0x0f,
]);
const LIVE_B_BYTES = Buffer.from([
  0xfa, 0xeb, 0xdc, 0xcd, 0xbe, 0xaf, 0x90, 0x81, 0x72, 0x63, 0x54, 0x45, 0x36, 0x27, 0x18, 0x09,
  0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18, 0x29, 0x3a, 0x4b, 0x5c, 0x6d, 0x7e, 0x8f, 0x90,
]);
const ROTATED_A_BYTES = Buffer.from([
  0x11, 0xa2, 0x33, 0xb4, 0x55, 0xc6, 0x77, 0xd8, 0x99, 0xea, 0xbb, 0xfc, 0x0d, 0x1e, 0x2f, 0x30,
  0x41, 0x52, 0x63, 0x74, 0x85, 0x96, 0xa7, 0xb8, 0xc9, 0xda, 0xeb, 0xfc, 0x0d, 0x1e, 0x2f, 0x3a,
]);
const RECOVERY_BYTES = Buffer.from([
  0x4d, 0x5e, 0x6f, 0x70, 0x81, 0x92, 0xa3, 0xb4, 0xc5, 0xd6, 0xe7, 0xf8, 0x09, 0x1a, 0x2b, 0x3c,
  0x4d, 0x5e, 0x6f, 0x71, 0x82, 0x93, 0xa4, 0xb5, 0xc6, 0xd7, 0xe8, 0xf9, 0x0a, 0x1b, 0x2c, 0x3d,
]);
const FRESH_BYTES = Buffer.from([
  0x9a, 0x8b, 0x7c, 0x6d, 0x5e, 0x4f, 0x30, 0x21, 0x12, 0x03, 0xf4, 0xe5, 0xd6, 0xc7, 0xb8, 0xa9,
  0x9a, 0x8b, 0x7c, 0x6d, 0x5e, 0x4f, 0x31, 0x22, 0x13, 0x04, 0xf5, 0xe6, 0xd7, 0xc8, 0xb9, 0xaa,
]);

const LIVE_A = LIVE_A_BYTES.toString("hex");
const LIVE_B = LIVE_B_BYTES.toString("hex");
const ROTATED_A = ROTATED_A_BYTES.toString("hex");
const RECOVERY = RECOVERY_BYTES.toString("hex");
const FRESH = FRESH_BYTES.toString("hex");

function restoreCrypto(): void {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
}

function expectNoCredential(error: unknown, ...tokens: string[]): void {
  const text =
    error instanceof Error
      ? `${error.name}\n${error.message}\n${error.stack ?? ""}`
      : String(error);
  for (const token of tokens) {
    expect(text).not.toContain(token);
  }
}

function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected issue() to throw");
}

function installRandomBytes(impl: (size: number) => Buffer): { calls: number[] } {
  const calls: number[] = [];
  vi.spyOn(nodeCrypto, "randomBytes").mockImplementation((size: number) => {
    calls.push(size);
    return impl(size);
  });
  syncBuiltinESMExports();
  return { calls };
}

function scriptedBytes(queue: Buffer[]): (size: number) => Buffer {
  return (size: number) => {
    expect(size).toBe(BYTE_LENGTH);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("unexpected extra randomBytes call");
    }
    expect(next.length).toBe(BYTE_LENGTH);
    return Buffer.from(next);
  };
}

function typedRegistry(): { tokens: SessionTokens; lookup: TokenLookup } {
  const registry = new TokenRegistry();
  return { tokens: registry, lookup: registry };
}

function scriptedLivePair(queue: Buffer[]): {
  tokens: SessionTokens;
  lookup: TokenLookup;
  tokenA: string;
  tokenB: string;
  calls: number[];
} {
  const { calls } = installRandomBytes(scriptedBytes(queue));
  const { tokens, lookup } = typedRegistry();
  const tokenA = tokens.issue(SESSION_A);
  const tokenB = tokens.issue(SESSION_B);
  return { tokens, lookup, tokenA, tokenB, calls };
}

function expectSessionARotated(
  tokens: SessionTokens,
  lookup: TokenLookup,
  previousA: string,
  tokenB: string,
): string {
  const rotated = tokens.issue(SESSION_A);
  expect(rotated).toBe(ROTATED_A);
  expect(lookup.lookup(previousA)).toBeNull();
  expect(lookup.lookup(rotated)).toBe(SESSION_A);
  expect(lookup.lookup(tokenB)).toBe(SESSION_B);
  return rotated;
}

function installEntropyFailure(): { calls: number[] } {
  return installRandomBytes((size) => {
    expect(size).toBe(BYTE_LENGTH);
    throw new Error("entropy unavailable");
  });
}

describe("TokenRegistry real crypto issuance", () => {
  it("issues 1000 unique 64-lowercase-hex tokens that look up their original sessions", () => {
    const { tokens, lookup } = typedRegistry();
    const issued = new Map<string, string>();

    for (let index = 0; index < ISSUANCE_COUNT; index += 1) {
      const sessionId = `session-${index}`;
      const token = tokens.issue(sessionId);
      expect(token).toMatch(LOWER_HEX_64);
      expect(issued.has(token)).toBe(false);
      issued.set(token, sessionId);
      expect(lookup.lookup(token)).toBe(sessionId);
    }

    expect(issued.size).toBe(ISSUANCE_COUNT);
    for (const [token, sessionId] of issued) {
      expect(lookup.lookup(token)).toBe(sessionId);
    }
  });
});

describe("TokenRegistry exact lookup", () => {
  it("returns null for unknown, empty, malformed, and case-altered tokens without changing live bindings", () => {
    const { lookup, tokenA, tokenB } = scriptedLivePair([LIVE_A_BYTES, LIVE_B_BYTES]);
    expect(tokenA).toBe(LIVE_A);
    expect(tokenB).toBe(LIVE_B);
    expect(tokenA).toMatch(LOWER_HEX_64);
    expect(tokenA).toMatch(/[a-f]/u);
    expect(tokenA).not.toBe(tokenA.toUpperCase());

    const unknown = Buffer.alloc(BYTE_LENGTH, 0xcd).toString("hex");
    const empty = "";
    const tooShort = tokenA.slice(0, 63);
    const tooLong = `${tokenA}0`;
    const nonHex = `g${tokenA.slice(1)}`;
    const alteredCase = tokenA.toUpperCase();
    const mixedCase = `${tokenA.slice(0, 2).toUpperCase()}${tokenA.slice(2)}`;

    expect(lookup.lookup(unknown)).toBeNull();
    expect(lookup.lookup(empty)).toBeNull();
    expect(lookup.lookup(tooShort)).toBeNull();
    expect(lookup.lookup(tooLong)).toBeNull();
    expect(lookup.lookup(nonHex)).toBeNull();
    expect(lookup.lookup(alteredCase)).toBeNull();
    expect(lookup.lookup(mixedCase)).toBeNull();

    expect(lookup.lookup(tokenA)).toBe(SESSION_A);
    expect(lookup.lookup(tokenB)).toBe(SESSION_B);
  });
});

describe("TokenRegistry rotation, revocation, and isolation", () => {
  it("rotates one session atomically while leaving other sessions unchanged", () => {
    const { tokens, lookup, tokenA, tokenB } = scriptedLivePair([
      LIVE_A_BYTES,
      LIVE_B_BYTES,
      ROTATED_A_BYTES,
    ]);
    expect(tokenA).toBe(LIVE_A);
    const rotated = expectSessionARotated(tokens, lookup, tokenA, tokenB);
    expect(rotated).not.toBe(tokenA);
  });

  it("revokes the current token, treats repeat and unknown revoke as no-ops, and isolates instances", () => {
    const { tokens, lookup, tokenA, tokenB } = scriptedLivePair([
      LIVE_A_BYTES,
      LIVE_B_BYTES,
      FRESH_BYTES,
    ]);
    const { tokens: otherTokens, lookup: otherLookup } = typedRegistry();

    expect(otherLookup.lookup(tokenA)).toBeNull();
    expect(otherLookup.lookup(tokenB)).toBeNull();

    tokens.revoke(SESSION_A);
    expect(lookup.lookup(tokenA)).toBeNull();
    expect(lookup.lookup(tokenB)).toBe(SESSION_B);

    tokens.revoke(SESSION_A);
    tokens.revoke(UNKNOWN_SESSION);
    expect(lookup.lookup(tokenA)).toBeNull();
    expect(lookup.lookup(tokenB)).toBe(SESSION_B);

    const foreign = otherTokens.issue(SESSION_A);
    expect(foreign).toBe(FRESH);
    expect(otherLookup.lookup(tokenA)).toBeNull();
    expect(otherLookup.lookup(foreign)).toBe(SESSION_A);
    expect(lookup.lookup(foreign)).toBeNull();
    expect(lookup.lookup(tokenB)).toBe(SESSION_B);
  });
});

describe("TokenRegistry failed issuance preserves authority", () => {
  it("propagates entropy failure on initial issue without publishing a token, then recovers", () => {
    const { calls } = installEntropyFailure();
    const { tokens, lookup } = typedRegistry();

    const thrown = captureThrown(() => tokens.issue(SESSION_A));
    expect(thrown).toBeTruthy();
    expectNoCredential(thrown, LIVE_A, LIVE_B, ROTATED_A, RECOVERY, FRESH);
    expect(lookup.lookup(LIVE_A)).toBeNull();
    expect(lookup.lookup(LIVE_B)).toBeNull();
    expect(calls).toEqual([BYTE_LENGTH]);

    restoreCrypto();
    installRandomBytes(scriptedBytes([RECOVERY_BYTES]));
    const recovered = tokens.issue(SESSION_A);
    expect(recovered).toBe(RECOVERY);
    expect(lookup.lookup(recovered)).toBe(SESSION_A);
  });

  it("propagates entropy failure during rotation without retiring the live token, then recovers", () => {
    const { tokens, lookup, tokenA, tokenB } = scriptedLivePair([LIVE_A_BYTES, LIVE_B_BYTES]);

    restoreCrypto();
    const { calls } = installEntropyFailure();

    const thrown = captureThrown(() => tokens.issue(SESSION_A));
    expect(thrown).toBeTruthy();
    expectNoCredential(thrown, tokenA, tokenB, ROTATED_A, RECOVERY);
    expect(lookup.lookup(tokenA)).toBe(SESSION_A);
    expect(lookup.lookup(tokenB)).toBe(SESSION_B);
    expect(lookup.lookup(ROTATED_A)).toBeNull();
    expect(calls).toEqual([BYTE_LENGTH]);

    restoreCrypto();
    installRandomBytes(scriptedBytes([ROTATED_A_BYTES]));
    expectSessionARotated(tokens, lookup, tokenA, tokenB);
  });

  it.each([
    {
      title: "rejects a live cross-session collision without transferring authority or retrying",
      collidingSession: SESSION_B,
      nextBytes: RECOVERY_BYTES,
      nextToken: RECOVERY,
      unpublished: [] as readonly string[],
      retiredIsA: false,
    },
    {
      title: "rejects a collision with the session's own live token without implicit retry",
      collidingSession: SESSION_A,
      nextBytes: ROTATED_A_BYTES,
      nextToken: ROTATED_A,
      unpublished: [ROTATED_A] as readonly string[],
      retiredIsA: true,
    },
  ] as const)("$title", ({ collidingSession, nextBytes, nextToken, unpublished, retiredIsA }) => {
    const { tokens, lookup, tokenA, tokenB, calls } = scriptedLivePair([
      LIVE_A_BYTES,
      LIVE_B_BYTES,
      LIVE_A_BYTES,
      nextBytes,
    ]);

    const thrown = captureThrown(() => tokens.issue(collidingSession));
    expect(thrown).toBeTruthy();
    expectNoCredential(thrown, tokenA, tokenB, nextToken);
    expect(lookup.lookup(tokenA)).toBe(SESSION_A);
    expect(lookup.lookup(tokenB)).toBe(SESSION_B);
    for (const token of unpublished) {
      expect(lookup.lookup(token)).toBeNull();
    }
    expect(calls).toEqual([BYTE_LENGTH, BYTE_LENGTH, BYTE_LENGTH]);

    const retired = retiredIsA ? tokenA : tokenB;
    const untouched = retiredIsA ? tokenB : tokenA;
    const untouchedSession = retiredIsA ? SESSION_B : SESSION_A;
    const issued = tokens.issue(collidingSession);
    expect(issued).toBe(nextToken);
    expect(lookup.lookup(retired)).toBeNull();
    expect(lookup.lookup(issued)).toBe(collidingSession);
    expect(lookup.lookup(untouched)).toBe(untouchedSession);
    expect(calls).toEqual([BYTE_LENGTH, BYTE_LENGTH, BYTE_LENGTH, BYTE_LENGTH]);
  });
});
