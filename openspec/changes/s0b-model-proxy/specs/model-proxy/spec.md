## ADDED Requirements

### Requirement: 透传端点与 bearer 鉴权
app-server SHALL expose POST /v1/chat/completions through registerModelProxy(app,{upstream,tokens}). model-proxy SHALL own TokenLookup={lookup(token:string):string|null}; it SHALL NOT import sessions or implement TokenRegistry. Canonical typed errors SHALL come from core/errors, with the existing HTTP mapper supplied by the caller.
Authorization SHALL carry a64hex bearer whose exact lookup hits a live runtime. Missing, malformed, unknown or revoked bearer SHALL return401 unauthorized with no upstream request. Authentication SHALL precede upstream configuration checks and body parsing; absent upstream configuration yields502 agent_unavailable only after successful authentication. Every proxy response, including errors, SHALL carry Cache-Control:no-store without changing sibling cache/guard policy.
Authenticated, configured requests SHALL accept JSON media/syntax with a4MiB raw-byte limit and forward the original body bytes and content-type to the configured baseURL plus /chat/completions. InvalidJSON/unsupportedmedia/overlimit SHALL produce400 bad_request before upstream contact. No message-semantic parsing, body reserialization or message logging is permitted. Upstream Authorization SHALL be replaced with `Bearer <configured apiKey>`; client bearer/cookie SHALL NOT be forwarded as headers.
Non5xx upstream status, content-type and opaque body bytes SHALL be streamed in order without waiting for the complete response; the proxy SHALL NOT follow redirects or transform response body bytes. HTTP5xx SHALL discard upstream errorbody and return sanitized local502 agent_unavailable. Connection failure or failure to establish the applicable transport (DNS/TCP/TLS) within10,000ms SHALL return the same502. The timer SHALL end when transport is established; it SHALL NOT impose a response-header/TTFT or whole-response deadline. No retries are added.
Before downstream commitment, upstream transport failure SHALL map to502; after commitment, it SHALL terminate the failed stream without appending a JSON error or falseDONE. Downstream cancellation and app shutdown SHALL release owned upstream requests/responses/timers/connections, including pending header acquisition. Generated errors/diagnostics SHALL NOT expose keys, sessionbearers or raw upstream error details. The module SHALL NOT register product startup assembly, models.yml or cookie-auth exemptions.

#### Scenario: Invalid bearer never reaches upstream
- WHEN Authorization is missing, malformed/non64hex, unknown or revoked, including malformed bodies and absent upstream configuration
- THEN401 unauthorized and no-store are returned before parsing/config failure, with zero upstream requests

#### Scenario: Missing configuration after valid authentication
- WHEN a valid token is supplied but upstream is absent
- THEN502 agent_unavailable and no-store are returned, without throwing during module registration or affecting siblinghealth

#### Scenario: Byte-preserving credential substitution
- WHEN a valid token sends JSON containing distinct whitespace, escape spelling and multibyte text with an explicit JSON content-type
- THEN the recording real upstream receives identical bytes/content-type and the configured APIkey bearer, never the incoming bearer/cookie as forwardedheaders

#### Scenario: Real two-round fake model
- WHEN authenticated requests through the proxy reach the #88 fake-upstream first without tool role and then with tool result
- THEN its bash toolcall round and exact multievent Chinese reply/DONE reach the client unchanged; the proxy does not interpret tool/message semantics

#### Scenario: Incremental non5xx passthrough
- WHEN a real upstream emits the first bytes then holds the response open until the downstream observes them
- THEN the client observes those bytes before upstreamcompletion, subsequent bytes preserve order/exactvalue, and non5xx status/content-type (including non200 such as429) remain unchanged withno-store

#### Scenario: Upstream failures normalized
- WHEN upstream returns HTTP500 or another5xx, refuses connection, or DNS/TCP/TLS connection establishment remains incomplete beyond10,000ms
- THEN local502 agent_unavailable/no-store replaces rawupstreambody/details, without leaked credentials or successfulstreamcompletion

#### Scenario: Parser byte limit and sibling isolation
- WHEN a configured authenticated request is malformedJSON, unsupportedmedia or exceeds4MiB rawbytes
- THEN400 bad_request/no-store occurs before upstreamcontact; a validJSON request of exactly4MiB is forwarded byte-identically
- WHEN siblingauth/API routes parse requests after proxy registration
- THEN their existing parser/bodylimit/guard/cache behavior is unchanged; /v1 does not require a cookie or broadenpublicexemptions

#### Scenario: Cancellation and late stream failure
- WHEN the downstream disconnects, appclose occurs while an upstream is pending, or upstream resets after responsebytes have begun
- THEN owned upstream work settles/reclaims without unhandled errors or hangs; late failure closes the downstream stream rather than producing a forgedJSON envelope orDONE

#### Scenario: Long established stream
- WHEN a response has begun normally and remains open beyond10seconds
- THEN the connection-establishment deadline does not cut it off; normal completion or clientcancellation still performs cleanup

#### Scenario: Established transport with delayed headers
- WHEN the appropriate transport connection is already established but the model has not yet sent response headers after10seconds
- THEN this connection timer SHALL NOT produce502 or cancel the request; later headers/body pass normally, while clientdisconnect/appclose still cancel owned pending work
