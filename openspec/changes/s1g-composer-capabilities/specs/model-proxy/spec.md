## MODIFIED Requirements

### Requirement: 托管 models.yml
The model-proxy module SHALL export deriveProxyBaseUrl(address:AddressInfo):string and writeManagedModelsYml(agentDir,{proxyBaseUrl,models}):Promise<void> where `models` is the non-empty ordered model whitelist (model-selection「模型白名单配置」), each element `{id,name,reasoning,vision,efforts?}` (the server always passes the whole resolved whitelist; an empty array rejects without touching the file). Actual TCP listen addresses SHALL map wildcard0.0.0.0 to127.0.0.1 and wildcard:: to::1; explicit IPv4/IPv6 SHALL be retained, IPv6 enclosed in brackets, actual port used and /v1 appended with http scheme.
The writer SHALL NOT create agentDir or any parent — the directory is established by omp-runtime「OMP_STATE_DIR 托管布局」 before the writer runs, and a missing agentDir rejects — and SHALL deterministically replace agentDir/models.yml — by writing a fresh temporary file in agentDir (created exclusively, never through an existing path) with mode exactly `0640` regardless of the process umask and renaming it over `models.yml`, so that a symlink or foreign file planted at `models.yml` is replaced rather than followed or written through, and no partially written file is ever visible; a failed write SHALL leave no temporary file behind — with block YAML containing providers.workbuddy: api openai-completions, supplied proxyBaseUrl, literal apiKey WORKBUDDY_MODEL_TOKEN, and exactly one model entry per element of `models`, in array order and with no other entry, each holding the element's `id`, its `name`, contextWindow128000 and maxTokens8192 (the same two limits for every model). When an element's `reasoning` is true its entry SHALL additionally contain, after maxTokens and in this order, `reasoning: true` and a `compat` mapping holding exactly `reasoningContentField: reasoning_content` (omp v18.0.10 `ModelDefinitionSchema` places `reasoningContentField` under `compat`); when false both keys SHALL be absent from that entry. After those keys, an element that carries `efforts` SHALL add a `thinking` mapping holding exactly `mode: effort` and `efforts` as a block list of the element's values in their given order, and an element whose `vision` is true SHALL add `input` as a block list of exactly `text` and `image`, in this order (`thinking` before `input`); an element without `efforts` has no `thinking` key and an element whose `vision` is false has no `input` key. For a whitelist of one element whose `name` equals its `id`, with no `efforts` and `vision` false — the whitelist of an installation that sets no `MODEL_CATALOG` — the output SHALL be byte-identical to what this writer produced before this change for the same id and reasoning value (with `reasoning` false, byte-identical to the pre-reasoning managed output). The `thinking` and `input` keys are consumed by omp without schema validation on the host side: their acceptance by omp v18.0.10 and their effect on `get_available_models` are pinned by the official-binary comparison case of model-selection「模型与强度从下一条消息起生效」 and SHALL be re-verified on an omp upgrade. The declaration only tells omp the model is a reasoning model on the request side (thinking/effort parameters, and replaying stored thinking into multi-turn history under the `compat.reasoningContentField` name, which DeepSeek-style upstreams validate); it SHALL NOT be relied on to gate the host thinking pipeline, because omp parses `reasoning_content`/`reasoning`/`reasoning_text` response deltas into thinking frames regardless of it (thinking-fold). The mapping from environment variable `MODEL_REASONING` (`on` default → true, `off` → false, any other value including empty rejected at startup with an error naming the variable) and the parsing of `MODEL_CATALOG` into the whitelist belong to startup assembly (`server/src/agent-config.ts`), not to this module: the writer receives the resolved whitelist and performs no validation of its own beyond rejecting an empty array. It SHALL NOT write authHeader or read/expand parent environment credentials. Supplied string values SHALL remain strings and SHALL NOT inject YAML properties. Identical inputs SHALL produce identical bytes; changed inputs SHALL replace obsolete managed content. Filesystem failures SHALL reject rather than report success. Startup invocation after listen remains a later assembly responsibility, not this module's side effect.

#### Scenario: Connectable address derivation
- WHEN the actual listener address is0.0.0.0:18016 or IPv6:::18016
- THEN URLs are http://127.0.0.1:18016/v1 and http://[::1]:18016/v1 respectively
- WHEN an explicit IPv4 or IPv6 address is supplied
- THEN that address and actual port are retained with correct IPv6 brackets

#### Scenario: Credential-safe managed output
- WHEN generation runs with proxyBaseUrl http://127.0.0.1:18016/v1 and the single-model whitelist `[{id:"deepseek-v4.1-flash",name:"deepseek-v4.1-flash",reasoning:true,vision:false}]` while parent upstream/token environment sentinels exist
- THEN parsed output contains only the declared workbuddy provider/model, literal env-name apiKey, required limits, the reasoning keys exactly as selected by that model's `reasoning` value and no authHeader; file content contains none of the unrelated sentinel values

#### Scenario: Deterministic overwrite and escaped model identity
- WHEN identical options are written twice, then a single-model whitelist whose id and name contain quotes, newline and YAML-significant characters is written
- THEN the first two files are byte-identical and the final parsed file preserves the exact new id/name without extra keys/providers or stale model entries
- WHEN the same single-model whitelist is written with its `reasoning` true and then false
- THEN the second file contains no `reasoning` or `compat` key and no stale reasoning line remains

#### Scenario: Real filesystem ownership
- WHEN agentDir exists and holds no models.yml
- THEN models.yml is created and readable after the promise resolves
- WHEN agentDir does not exist, or is a regular file
- THEN the promise rejects and unrelated files remain unchanged

#### Scenario: Reasoning declaration toggles
- WHEN generation runs with the single model deepseek-v4.1-flash whose `reasoning` is true, then false
- THEN the first parsed model entry has `reasoning: true` and `compat: {reasoningContentField: "reasoning_content"}` and no other added key, and is accepted by omp's models.yml schema; the second has neither key; each variant written twice is byte-identical
- WHEN startup reads `MODEL_REASONING` unset, `on`, `off`, empty and `yes`
- THEN the single model passed to the writer has `reasoning` true, true and false respectively, and empty or `yes` fails startup before models.yml is written, naming `MODEL_REASONING` without echoing unrelated environment values

#### Scenario: Planted link is replaced and the mode is fixed
- **WHEN** `agentDir/models.yml` is a symlink to a file outside agentDir and the writer runs under umask `000` and again under umask `077`
- **THEN** both times `models.yml` is a regular file of mode `0640` holding the managed content, the outside file is byte-identical to before, and agentDir holds no leftover temporary file

#### Scenario: Several models in whitelist order
- **WHEN** generation runs with the whitelist `[{id:"m1",name:"通用",reasoning:true,vision:false},{id:"m2",name:"m2",reasoning:false,vision:false},{id:"m3",name:"深度",reasoning:true,vision:true,efforts:["low","high"]}]`, then again with only `[{id:"m2",name:"m2",reasoning:false,vision:false}]`
- **THEN** the first parsed file has exactly one provider `workbuddy` whose `models` are three entries in that order: `m1` with name `通用`, the two limits, `reasoning: true` and `compat: {reasoningContentField: "reasoning_content"}` and no `thinking` or `input` key; `m2` with the two limits only; `m3` with name `深度`, the two limits, the reasoning keys, `thinking: {mode: "effort", efforts: ["low","high"]}` and `input: ["text","image"]`; writing the same whitelist twice is byte-identical; the second file holds the single `m2` entry and no line of `m1` or `m3` remains

#### Scenario: Single-model output is unchanged
- **WHEN** generation runs with `[{id:"deepseek-v4.1-flash",name:"deepseek-v4.1-flash",reasoning:true,vision:false}]` and with the same element whose `reasoning` is false, and the results are compared with the files this writer produced before this change for `modelId` deepseek-v4.1-flash with `reasoning` true and false (fixtures checked in with the test)
- **THEN** both pairs are byte-identical
- **WHEN** generation runs with an empty whitelist
- **THEN** the promise rejects and an existing `models.yml` is left unchanged

### Requirement: 透传端点与 bearer 鉴权
app-server SHALL expose POST /v1/chat/completions through registerModelProxy(app,{upstream,tokens,allowedModels}), where `allowedModels` is the non-empty set of the model ids of the resolved whitelist (model-selection「模型白名单配置」; for an installation without `MODEL_CATALOG` it holds exactly the `MODEL_ID` value) supplied by the caller at assembly — model-proxy SHALL NOT read the environment or import the whitelist resolver, and registration with an empty set SHALL throw. model-proxy SHALL own TokenLookup={lookup(token:string):string|null}; it SHALL NOT import sessions or implement TokenRegistry. Canonical typed errors SHALL come from core/errors, with the existing HTTP mapper supplied by the caller.
Authorization SHALL carry a64hex bearer whose exact lookup hits a live runtime. Missing, malformed, unknown or revoked bearer SHALL return401 unauthorized with no upstream request. Authentication SHALL precede upstream configuration checks and body parsing; absent upstream configuration yields502 agent_unavailable only after successful authentication. Every proxy response, including errors, SHALL carry Cache-Control:no-store without changing sibling cache/guard policy.
Authenticated, configured requests SHALL accept JSON media/syntax with a4MiB raw-byte limit and forward the original body bytes and content-type to the configured baseURL plus /chat/completions. InvalidJSON/unsupportedmedia/overlimit SHALL produce400 bad_request before upstream contact.
**Model whitelist.** As part of that same body validation — which applies to authenticated, configured requests only: after authentication, after the upstream-configuration check and after the media, size and JSON-syntax checks, before any upstream contact — the proxy SHALL require the body's top-level JSON value to be an object holding exactly one member whose key, after JSON string unescaping, equals `model`, and that member's value to be a JSON string equal, code unit for code unit (no trimming, no case folding, no Unicode normalization), to one element of `allowedModels`. A top-level value that is not an object, a missing `model`, two or more members whose decoded keys equal `model` (whatever their values: JSON parsers disagree on which duplicate wins and the body is forwarded verbatim, so a duplicate would let the upstream read a different model than the one checked), a `model` that is not a string, and a string outside the whitelist SHALL each produce the same 400 bad_request envelope with no-store and zero upstream requests; the response and any diagnostic SHALL NOT echo the offered model name. The existing order is unchanged: with a valid token and absent upstream configuration the answer stays 502 agent_unavailable whatever the body (the body is not read, so the whitelist is not consulted, and no upstream request can occur). Only the top-level member keys and the `model` value are read: nested `model` members are ignored, the request's `stream` member is not read, and the rule is the same for streaming and non-streaming requests (the response path is unchanged). A body that passes SHALL still be forwarded as its original bytes. Apart from this check, no message-semantic parsing, body reserialization or message logging is permitted. Upstream Authorization SHALL be replaced with `Bearer <configured apiKey>`; client bearer/cookie SHALL NOT be forwarded as headers.
Non5xx upstream status, content-type and opaque body bytes SHALL be streamed in order without waiting for the complete response; the proxy SHALL NOT follow redirects or transform response body bytes. HTTP5xx SHALL discard upstream errorbody and return sanitized local502 agent_unavailable. Connection failure or failure to establish the applicable transport (DNS/TCP/TLS) within10,000ms SHALL return the same502. The timer SHALL end when transport is established; it SHALL NOT impose a response-header/TTFT or whole-response deadline. No retries are added.
Before downstream commitment, upstream transport failure SHALL map to502; after commitment, it SHALL terminate the failed stream without appending a JSON error or falseDONE. Downstream cancellation and app shutdown SHALL release owned upstream requests/responses/timers/connections, including pending header acquisition. Generated errors/diagnostics SHALL NOT expose keys, sessionbearers or raw upstream error details. The module SHALL NOT register product startup assembly, models.yml or cookie-auth exemptions.

#### Scenario: Invalid bearer never reaches upstream
- WHEN Authorization is missing, malformed/non64hex, unknown or revoked, including malformed bodies and absent upstream configuration
- THEN401 unauthorized and no-store are returned before parsing/config failure, with zero upstream requests

#### Scenario: Missing configuration after valid authentication
- WHEN a valid token is supplied but upstream is absent, whatever the body — well-formed with a whitelisted `model`, malformed, or naming a model outside the whitelist
- THEN502 agent_unavailable and no-store are returned, without throwing during module registration or affecting siblinghealth

#### Scenario: Byte-preserving credential substitution
- WHEN a valid token sends JSON containing a whitelisted `model`, distinct whitespace, escape spelling and multibyte text with an explicit JSON content-type
- THEN the recording real upstream receives identical bytes/content-type and the configured APIkey bearer, never the incoming bearer/cookie as forwardedheaders

#### Scenario: Real two-round fake model
- WHEN authenticated requests naming the whitelisted model reach the #88 fake-upstream through the proxy, first without tool role and then with tool result
- THEN its bash toolcall round and exact multievent Chinese reply/DONE reach the client unchanged; the proxy does not interpret tool/message semantics

#### Scenario: Incremental non5xx passthrough
- WHEN a real upstream emits the first bytes then holds the response open until the downstream observes them
- THEN the client observes those bytes before upstreamcompletion, subsequent bytes preserve order/exactvalue, and non5xx status/content-type (including non200 such as429) remain unchanged withno-store

#### Scenario: Upstream failures normalized
- WHEN upstream returns HTTP500 or another5xx, refuses connection, or DNS/TCP/TLS connection establishment remains incomplete beyond10,000ms
- THEN local502 agent_unavailable/no-store replaces rawupstreambody/details, without leaked credentials or successfulstreamcompletion

#### Scenario: Parser byte limit and sibling isolation
- WHEN a configured authenticated request is malformedJSON, unsupportedmedia or exceeds4MiB rawbytes
- THEN400 bad_request/no-store occurs before upstreamcontact; a validJSON request of exactly4MiB carrying a whitelisted `model` is forwarded byte-identically
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

#### Scenario: Model outside the whitelist is refused
- **WHEN** `allowedModels` is `{"m1","m3"}` and a valid token posts, each once with `"stream":true` and once without it, the bodies `{"model":"m2","messages":[]}`, `{"model":"M1","messages":[]}`, `{"model":" m1","messages":[]}`, `{"messages":[]}`, `{"model":1}`, `{"model":null}`, `{"model":["m1"]}`, `["m1"]`, `"m1"`, `{"model":"m1","model":"other"}`, `{"model":"other","model":"m1"}` and `{"model":"other","mod\u0065l":"m1"}` to a proxy whose recording real upstream is configured
- **THEN** every response is 400 `{"error":{"code":"bad_request","message":"请求格式不正确"}}` with no-store; the recording upstream has received zero requests; no response body contains `m2`, `M1` or `other`

#### Scenario: Whitelisted model is forwarded untouched
- **WHEN** with the same whitelist a valid token posts `{ "stream" : true, "metadata":{"model":"other"}, "mod\u0065l" : "m3", "messages":[{"role":"user","content":"你好"}] }` (unusual whitespace, an escaped spelling of the single top-level `model` key, a nested `model` member) and, separately, the same body without `stream`
- **THEN** the recording upstream receives each body byte-identically with the configured API-key bearer, and the upstream's streamed and non-streamed responses reach the client unchanged

#### Scenario: Default single-model whitelist
- **WHEN** the server starts without `MODEL_CATALOG` and with `MODEL_ID` unset, and a live session bearer posts a body naming `deepseek-v4.1-flash`, then one naming `gpt-x`
- **THEN** the first is forwarded and the second is 400 bad_request with zero additional upstream requests; real omp turns in `make smoke` (whose managed `models.yml` names only whitelisted ids) complete as before
