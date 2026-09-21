## ADDED Requirements

### Requirement: 会话 bearer 登记与轮换
TokenRegistry SHALL expose issue(sessionId:string):string, lookup(token:string):string|null and revoke(sessionId:string):void. It SHALL be structurally compatible with the existing proxy TokenLookup and runtime SessionTokens ports without reversing the proxy→sessions dependency boundary. Registry state SHALL be private, process-local and isolated per instance, with one live token per session and one session per live token.
issue SHALL acquire32 cryptographically random bytes from node:crypto randomBytes and encode64lowercasehex characters.1000 real issuances SHALL have the required shape and no repeats. Successful same-session issuance SHALL replace the old token atomically; lookup of the old token SHALL immediately returnnull and the new token SHALL identify that session. Other sessions SHALL remain unchanged.
lookup SHALL match the exact opaque token string and returnnull for unknown/empty/malformed/altered-case/revoked values. revoke SHALL invalidate the current token for that session; unknown or repeated revocation SHALL be harmless. Lookup and revocation SHALL use indexed state rather than scanning all tokens.
Entropy failure or a candidate colliding with any currently live token SHALL throw without modifying either existing binding or publishing a new one; errors SHALL not include credential values and there SHALL be no insecure fallback or implicit retry. The registry SHALL NOT retain an unbounded history of revoked tokens, read configuration/upstream keys, perform IO, start timers or log credentials. Runtime lifecycle and proxy route assembly remain outside this slice.

#### Scenario: Random opaque issuance
- WHEN 1000 distinct sessions obtain tokens from a fresh registry using real Node crypto
- THEN every token matches64lowercasehex, all are distinct and each lookup returns its original session

#### Scenario: Rotation, revocation and isolation
- WHEN two sessions hold tokens and one session rotates
- THEN its old token returnsnull, its new token resolves correctly and the other session is unaffected
- WHEN that session is revoked twice, or an unknown session is revoked
- THEN no unrelated binding changes and the revoked token remains unknown
- WHEN another registry instance queries those tokens
- THEN it returnsnull

#### Scenario: Exact lookup
- WHEN a caller submits an unknown, empty, malformed or case-altered token
- THEN lookup returnsnull without modifying valid bindings

#### Scenario: Failed issuance preserves authority
- WHEN crypto throws during initial issuance or rotation, or returns a token already live for the same or another session
- THEN issue throws, no candidate is published, old/current bindings remain exact, and no credential is included in the error
- WHEN the external entropy failure is removed and issue is called again
- THEN normal issuance/rotation succeeds without stale reverse bindings

#### Scenario: Proxy port integration
- WHEN an unchanged model-proxy route receives a current registry-issued bearer and then an old/revoked bearer
- THEN the current bearer reaches the configured local upstream while the old/revoked bearer receives401 without contacting that upstream
