/**
 * core/base-url — the one implementation of an upstream base URL's view form and sanitiser parts
 * (model-registry「上游地址的视图形式与拼接」, s1d-registry-followups D1–D3). Pure, no imports: `models/`
 * and `model-proxy/` both reach it through core. An env seed row is stored as given (it never meets
 * the REST address rule), so a stored address may carry userinfo in any form WHATWG `new URL` accepts
 * (`http:/u:p@h`, `https:\u:p@h`, leading spaces), not only `scheme://u:p@h`.
 */

/** `scheme://`, then the userinfo up to the last `@` inside the authority. */
const USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)@/u;

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
 * The user name is never listed on its own: a short one (`u`, `admin`) would shred ordinary text.
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
    const whole = url.password === "" ? url.username : `${url.username}:${url.password}`;
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
