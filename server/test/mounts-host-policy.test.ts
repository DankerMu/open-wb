/**
 * s1b-workspace-mounts group 5 (host-policy part, #1685): the five-step host rule (design D3;
 * workspace-mounts「挂载取值与主机规则」steps 1–4 and the「环回一律拒绝」「解析失败不启动子进程」
 * 「许可名单」scenarios at the policy layer). Expected verdicts are the spec's literals. The resolver is
 * injected and recorded, so step precedence (literal loopback and the allow-list before any lookup) is
 * observable; one case runs the default resolver to pin that it is the system `lookup`.
 */
import { describe, expect, it } from "vitest";
import { type HostResolver, judgeHost } from "../src/workspaces/mounts/host-policy.js";

const REJECTED = { verdict: "rejected" } as const;
const UNRESOLVED = { verdict: "unresolved" } as const;

/** A resolver answering from a table; every lookup is recorded. Unknown names fail like ENOTFOUND. */
function resolverOf(table: Record<string, readonly string[]>): {
  resolve: HostResolver;
  asked: string[];
} {
  const asked: string[] = [];
  const resolve: HostResolver = async (host) => {
    asked.push(host);
    const addresses = table[host];
    if (addresses === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    }
    return addresses.map((address) => ({ address }));
  };
  return { resolve, asked };
}

describe("literal loopback (step 2)", () => {
  const literals = [
    "localhost",
    "LOCALHOST",
    "localhost.",
    "LOCALHOST.",
    "localhost...",
    "a.localhost",
    "a.localhost.",
    "A.B.LocalHost",
    "127.0.0.1",
    "127.9.9.9",
    "127.255.255.255",
    "0.0.0.0",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::",
    "0:0:0:0:0:0:0:0",
    "::ffff:127.0.0.1",
    "::FFFF:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:0.0.0.0",
  ];

  it.each(literals)("%s is rejected without a lookup", async (host) => {
    const { resolve, asked } = resolverOf({});
    expect(await judgeHost(host, undefined, resolve)).toEqual(REJECTED);
    expect(asked).toEqual([]);
  });

  it("a loopback name on the allow-list is still rejected, without a lookup", async () => {
    const { resolve, asked } = resolverOf({ localhost: ["10.0.0.9"] });
    expect(await judgeHost("localhost", ["localhost", "127.0.0.1"], resolve)).toEqual(REJECTED);
    expect(await judgeHost("127.0.0.1", ["localhost", "127.0.0.1"], resolve)).toEqual(REJECTED);
    expect(asked).toEqual([]);
  });

  it("names that only look like localhost are not literal loopback", async () => {
    const { resolve, asked } = resolverOf({
      "notlocalhost.intra": ["10.0.0.3"],
      "localhost.intra": ["10.0.0.4"],
      "128.0.0.1": ["128.0.0.1"],
    });
    expect(await judgeHost("notlocalhost.intra", undefined, resolve)).toEqual({
      verdict: "allowed",
      address: "10.0.0.3",
    });
    expect(await judgeHost("localhost.intra", undefined, resolve)).toEqual({
      verdict: "allowed",
      address: "10.0.0.4",
    });
    expect(await judgeHost("128.0.0.1", undefined, resolve)).toEqual({
      verdict: "allowed",
      address: "128.0.0.1",
    });
    expect(asked).toEqual(["notlocalhost.intra", "localhost.intra"]);
  });
});

describe("a non-loopback IP literal (steps 4–5)", () => {
  it("is its own resolution: allowed with the normalised literal, the resolver never called", async () => {
    const { resolve, asked } = resolverOf({
      "10.0.0.7": ["127.0.0.1"],
      "fd00::7": ["127.0.0.1"],
      "::ffff:10.0.0.7": ["127.0.0.1"],
    });
    expect(await judgeHost("10.0.0.7", undefined, resolve)).toEqual({
      verdict: "allowed",
      address: "10.0.0.7",
    });
    expect(await judgeHost("10.0.0.7.", ["10.0.0.7"], resolve)).toEqual({
      verdict: "allowed",
      address: "10.0.0.7",
    });
    expect(await judgeHost("FD00::7", undefined, resolve)).toEqual({
      verdict: "allowed",
      address: "fd00::7",
    });
    expect(await judgeHost("::FFFF:10.0.0.7", undefined, resolve)).toEqual({
      verdict: "allowed",
      address: "::ffff:10.0.0.7",
    });
    expect(asked).toEqual([]);
  });

  it("is still rejected when off the allow-list", async () => {
    const { resolve, asked } = resolverOf({});
    expect(await judgeHost("10.0.0.7", ["files.intra"], resolve)).toEqual(REJECTED);
    expect(asked).toEqual([]);
  });
});

describe("resolution (step 4)", () => {
  it("numeric spellings and names resolving to loopback are rejected after the lookup", async () => {
    const { resolve, asked } = resolverOf({
      "2130706433": ["127.0.0.1"],
      "0x7f.1": ["127.0.0.1"],
      "files.intra": ["127.0.0.1"],
      "any.intra": ["0.0.0.0"],
      "six.intra": ["::1"],
      "mapped.intra": ["::ffff:127.0.0.2"],
    });
    for (const host of ["2130706433", "0x7f.1", "files.intra", "any.intra", "six.intra"]) {
      expect(await judgeHost(host, undefined, resolve)).toEqual(REJECTED);
    }
    expect(await judgeHost("mapped.intra", undefined, resolve)).toEqual(REJECTED);
    expect(asked).toEqual([
      "2130706433",
      "0x7f.1",
      "files.intra",
      "any.intra",
      "six.intra",
      "mapped.intra",
    ]);
  });

  it("any loopback among several results rejects, wherever it sits", async () => {
    const { resolve } = resolverOf({
      "first.intra": ["127.0.0.1", "10.0.0.7"],
      "last.intra": ["10.0.0.7", "10.0.0.8", "::1"],
    });
    expect(await judgeHost("first.intra", undefined, resolve)).toEqual(REJECTED);
    expect(await judgeHost("last.intra", undefined, resolve)).toEqual(REJECTED);
  });

  it("the default resolver is the system lookup: 2130706433 resolves to loopback", async () => {
    expect(await judgeHost("2130706433", undefined)).toEqual(REJECTED);
  });

  it("a failed lookup is an unresolved attempt, not a rejection", async () => {
    const { resolve, asked } = resolverOf({});
    expect(await judgeHost("nowhere.intra", undefined, resolve)).toEqual(UNRESOLVED);
    expect(asked).toEqual(["nowhere.intra"]);
  });

  it("an empty result is an unresolved attempt", async () => {
    const { resolve } = resolverOf({ "empty.intra": [] });
    expect(await judgeHost("empty.intra", undefined, resolve)).toEqual(UNRESOLVED);
  });

  it("a result that is not an IP literal is an unresolved attempt", async () => {
    const { resolve } = resolverOf({ "odd.intra": ["10.0.0.7", "files.intra"] });
    expect(await judgeHost("odd.intra", undefined, resolve)).toEqual(UNRESOLVED);
  });

  it("a host that normalises to nothing is unresolved without a lookup", async () => {
    const { resolve, asked } = resolverOf({ "": ["10.0.0.7"] });
    expect(await judgeHost(".", undefined, resolve)).toEqual(UNRESOLVED);
    expect(await judgeHost("...", undefined, resolve)).toEqual(UNRESOLVED);
    expect(asked).toEqual([]);
  });
});

describe("the connect address (step 5)", () => {
  it("is the first resolved address, looked up under the normalised name", async () => {
    const { resolve, asked } = resolverOf({
      "files.intra": ["10.0.0.7", "10.0.0.8", "fd00::7"],
    });
    expect(await judgeHost("FILES.intra.", undefined, resolve)).toEqual({
      verdict: "allowed",
      address: "10.0.0.7",
    });
    expect(asked).toEqual(["files.intra"]);
  });

  it("an IPv6 first result is returned as the resolver gave it", async () => {
    const { resolve } = resolverOf({ "six.intra": ["fd00::7", "10.0.0.7"] });
    expect(await judgeHost("six.intra", undefined, resolve)).toEqual({
      verdict: "allowed",
      address: "fd00::7",
    });
  });

  it("a non-loopback IPv4-mapped result passes", async () => {
    const { resolve } = resolverOf({ "mapped.intra": ["::ffff:10.0.0.7"] });
    expect(await judgeHost("mapped.intra", undefined, resolve)).toEqual({
      verdict: "allowed",
      address: "::ffff:10.0.0.7",
    });
  });
});

describe("allow-list (step 3)", () => {
  const table = {
    "files.intra": ["10.0.0.7"],
    "other.intra": ["10.0.0.8"],
  };

  it("matches after normalising both sides", async () => {
    const { resolve } = resolverOf(table);
    for (const host of ["files.intra", "FILES.INTRA", "files.intra.", "Files.Intra.."]) {
      expect(await judgeHost(host, ["files.intra"], resolve)).toEqual({
        verdict: "allowed",
        address: "10.0.0.7",
      });
    }
    expect(await judgeHost("files.intra", ["FILES.INTRA."], resolve)).toEqual({
      verdict: "allowed",
      address: "10.0.0.7",
    });
  });

  it("a host not on the list is rejected before any lookup", async () => {
    const { resolve, asked } = resolverOf(table);
    expect(await judgeHost("other.intra", ["files.intra"], resolve)).toEqual(REJECTED);
    expect(await judgeHost("sub.files.intra", ["files.intra"], resolve)).toEqual(REJECTED);
    expect(asked).toEqual([]);
  });

  it("compares strings only: an address on the list does not admit a name resolving to it", async () => {
    const { resolve, asked } = resolverOf(table);
    expect(await judgeHost("files.intra", ["10.0.0.7"], resolve)).toEqual(REJECTED);
    expect(asked).toEqual([]);
  });

  it("any one of several items admits the host", async () => {
    const { resolve } = resolverOf(table);
    expect(await judgeHost("other.intra", ["files.intra", "other.intra"], resolve)).toEqual({
      verdict: "allowed",
      address: "10.0.0.8",
    });
  });

  it("an admitted host still goes through resolution", async () => {
    const { resolve } = resolverOf({ "files.intra": ["127.0.0.1"] });
    expect(await judgeHost("files.intra", ["files.intra"], resolve)).toEqual(REJECTED);
    expect(await judgeHost("gone.intra", ["gone.intra"], resolve)).toEqual(UNRESOLVED);
  });
});
