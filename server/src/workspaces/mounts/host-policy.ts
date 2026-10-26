/**
 * workspaces/mounts/host-policy — the host rule judged before every `sftp` / `smb` mount attempt
 * (s1b-workspace-mounts design D3; workspace-mounts「挂载取值与主机规则」steps 1–4 and the connect
 * address). The verdict is three-way: `rejected` (loopback or off the allow-list; the caller's 403 or
 * stay-offline), `unresolved` (the lookup failed or gave nothing usable; the caller's 502 or
 * stay-offline — an attempt failure, not a rejection), and `allowed` with the first resolved IP literal,
 * which the caller writes into `rclone.conf` so the address judged is the address connected to.
 *
 * Steps in order, each on the normalised host (lower case, all trailing `.` removed; allow-list items
 * likewise): literal loopback, allow-list (string equality only), resolution (any loopback result
 * rejects). The first two never consult the resolver. No public-address judgement: the rule only
 * refuses loopback and admits by list.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type HostVerdict =
  | { verdict: "allowed"; address: string }
  | { verdict: "rejected" }
  | { verdict: "unresolved" };

/** `dns.lookup(host, {all: true})`'s shape; injected by tests. */
export type HostResolver = (host: string) => Promise<readonly { address: string }[]>;

const systemResolver: HostResolver = (host) => lookup(host, { all: true });

/** 127.0.0.0/8, 0.0.0.0, ::1, ::; `BlockList` also matches their IPv4-mapped spellings. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("0.0.0.0", "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
LOOPBACK.addAddress("::", "ipv6");

export async function judgeHost(
  host: string,
  allow: readonly string[] | undefined,
  resolve: HostResolver = systemResolver,
): Promise<HostVerdict> {
  const name = normalise(host);
  if (name === "localhost" || name.endsWith(".localhost") || isLoopbackLiteral(name)) {
    return { verdict: "rejected" };
  }
  if (allow !== undefined && !allow.some((item) => normalise(item) === name)) {
    return { verdict: "rejected" };
  }
  if (name === "") {
    return { verdict: "unresolved" };
  }
  let results: readonly { address: string }[];
  try {
    results = await resolve(name);
  } catch {
    return { verdict: "unresolved" };
  }
  const addresses = results.map((result) => result.address);
  if (addresses.some(isLoopbackLiteral)) {
    return { verdict: "rejected" };
  }
  const [first] = addresses;
  if (first === undefined || !addresses.every((address) => isIP(address) !== 0)) {
    return { verdict: "unresolved" };
  }
  return { verdict: "allowed", address: first };
}

function normalise(host: string): string {
  return host.toLowerCase().replace(/\.+$/u, "");
}

/** Dotted-decimal IPv4 or any IPv6 spelling whose value is loopback; anything else is not a literal. */
function isLoopbackLiteral(value: string): boolean {
  const family = isIP(value);
  return family !== 0 && LOOPBACK.check(value, family === 6 ? "ipv6" : "ipv4");
}
