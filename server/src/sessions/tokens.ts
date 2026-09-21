/**
 * Process-local per-session bearer registry. One live token per session and
 * one session per live token; lookup is an exact opaque-string match.
 */
import { randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

export class TokenRegistry {
  readonly #byToken = new Map<string, string>();
  readonly #bySession = new Map<string, string>();

  issue(sessionId: string): string {
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    if (this.#byToken.has(token)) {
      throw new Error("failed to issue session token");
    }
    const previous = this.#bySession.get(sessionId);
    if (previous !== undefined) {
      this.#byToken.delete(previous);
    }
    this.#byToken.set(token, sessionId);
    this.#bySession.set(sessionId, token);
    return token;
  }

  lookup(token: string): string | null {
    return this.#byToken.get(token) ?? null;
  }

  revoke(sessionId: string): void {
    const token = this.#bySession.get(sessionId);
    if (token === undefined) {
      return;
    }
    this.#bySession.delete(sessionId);
    this.#byToken.delete(token);
  }
}
