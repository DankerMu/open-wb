/**
 * core/base-url — the one implementation of an upstream base URL's view form, sanitiser parts and
 * sub-path join (model-registry「上游地址的视图形式与拼接」, s1d-registry-followups D1–D4). Pure, no imports: `models/`
 * and `model-proxy/` both reach it through core. An env seed row is stored as given (it never meets
 * the REST address rule), so a stored address may carry userinfo in any form WHATWG `new URL` accepts
 * (`http:/u:p@h`, `https:\u:p@h`, leading spaces), not only `scheme://u:p@h`, and some it rejects
 * (` https://u:p@h:abc`, `https:\u:p@ho st`).
 */

/**
 * The fallback for what WHATWG gives no userinfo: optional leading whitespace, `scheme:` and any run
 * of `/` or `\`, then the userinfo up to the last `@` before the authority ends (`/`, `?`, `#`). The
 * userinfo allows `\` (`DOMAIN\user:p@h`, an unencoded `\` in the password), but its first character
 * excludes `/` and `\`: the prefix run then ends at one fixed place, so matching stays linear (a
 * userinfo that could also start with `\` makes `https:\\\…` without `@` try every split, O(n²)).
 * Group 1 is what the view keeps (the leading whitespace goes), group 2 the raw userinfo (may be empty).
 */
const USERINFO = /^\s*([A-Za-z][A-Za-z0-9+.-]*:[/\\]*)((?:[^/\\?#][^/?#]*)?)@/u;

function parsed(baseUrl: string): URL | undefined {
  try {
    return new URL(baseUrl);
  } catch {
    return undefined;
  }
}

/**
 * The view form (D2): an address WHATWG parses with a user name or password comes back as its `href`
 * with both cleared; otherwise (no userinfo, or unparseable) the regex replacement, which leaves an
 * address without `@` in its authority byte for byte and still drops an empty `https://@host`.
 */
export function withoutUserinfo(baseUrl: string): string {
  const url = parsed(baseUrl);
  if (url !== undefined && (url.username !== "" || url.password !== "")) {
    url.username = "";
    url.password = "";
    return url.href;
  }
  return baseUrl.replace(USERINFO, "$1");
}

/**
 * The userinfo secrets of an address (D3): the regex's raw userinfo and its password segment, then
 * WHATWG's whole userinfo (`username` alone when there is no password) and `password`, then the
 * percent-decoded forms of those two (skipped when decoding fails). Empty and repeated entries go.
 * The user name is never listed on its own: a short one (`u`, `admin`) would shred ordinary text. So
 * WHATWG's whole userinfo joins only when it has a password or the regex found none: for
 * `https://admin:@h` the raw `admin:` is listed, the bare `admin` is not.
 */
export function userinfoParts(baseUrl: string): string[] {
  const parts: string[] = [];
  const raw = USERINFO.exec(baseUrl)?.[2];
  if (raw !== undefined) {
    const colon = raw.indexOf(":");
    parts.push(raw, colon === -1 ? "" : raw.slice(colon + 1));
  }
  const url = parsed(baseUrl);
  if (url !== undefined) {
    const whole =
      url.password !== ""
        ? `${url.username}:${url.password}`
        : raw === undefined
          ? url.username
          : "";
    parts.push(whole, url.password);
    for (const part of [whole, url.password]) {
      try {
        parts.push(decodeURIComponent(part));
      } catch {
        // A malformed escape: the raw form above is all there is to list.
      }
    }
  }
  return [...new Set(parts.filter((part) => part !== ""))];
}

/**
 * The upstream endpoint for `sub` (D4): the parsed path with its trailing slashes dropped, then
 * `/<sub>`; the fragment goes, the query and userinfo stay. The probe joins `models`, the proxy
 * `chat/completions`, so both hit the same prefix. Throws `TypeError` on what WHATWG cannot parse.
 * The trim scans back by hand: `/\/+$/u` retries every start of a slash run that stops short of the
 * end (`/` × n then `x`), O(n²).
 */
export function upstreamEndpoint(baseUrl: string, sub: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname;
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  url.pathname = `${path.slice(0, end)}/${sub}`;
  url.hash = "";
  return url;
}
