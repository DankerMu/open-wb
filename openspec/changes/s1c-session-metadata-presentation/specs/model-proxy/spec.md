# Spec delta: model-proxy（S1c B 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario，另加 B 的 Scenario）；归档时以本文整段替换 promoted 的同名 Requirement，未在此重述的 Requirement 不变。

## MODIFIED Requirements

### Requirement: 托管 models.yml
The model-proxy module SHALL export deriveProxyBaseUrl(address:AddressInfo):string and writeManagedModelsYml(agentDir,{proxyBaseUrl,modelId,reasoning?}):Promise<void> where `reasoning` is an optional boolean defaulting to false when omitted (an omitted `reasoning` writes exactly the false-variant file; the server always passes the parsed `MODEL_REASONING` value). Actual TCP listen addresses SHALL map wildcard0.0.0.0 to127.0.0.1 and wildcard:: to::1; explicit IPv4/IPv6 SHALL be retained, IPv6 enclosed in brackets, actual port used and /v1 appended with http scheme.
The writer SHALL create missing agentDir parents and deterministically overwrite agentDir/models.yml with block YAML containing providers.workbuddy: api openai-completions, supplied proxyBaseUrl, literal apiKey WORKBUDDY_MODEL_TOKEN, and exactly one model with supplied id/name, contextWindow128000 and maxTokens8192. When `reasoning` is true the model entry SHALL additionally contain, after maxTokens and in this order, `reasoning: true` and a `compat` mapping holding exactly `reasoningContentField: reasoning_content` (omp v18.0.10 `ModelDefinitionSchema` places `reasoningContentField` under `compat`); when false both keys SHALL be absent and the output SHALL be byte-identical to the pre-reasoning managed output. The declaration only tells omp the model is a reasoning model on the request side (thinking/effort parameters, and replaying stored thinking into multi-turn history under the `compat.reasoningContentField` name, which DeepSeek-style upstreams validate); it SHALL NOT be relied on to gate the host thinking pipeline, because omp parses `reasoning_content`/`reasoning`/`reasoning_text` response deltas into thinking frames regardless of it (thinking-fold). The mapping from environment variable `MODEL_REASONING` (`on` default → true, `off` → false, any other value including empty rejected at startup with an error naming the variable) belongs to startup assembly (`server/src/agent-config.ts`), not to this module. It SHALL NOT write authHeader or read/expand parent environment credentials. Supplied string values SHALL remain strings and SHALL NOT inject YAML properties. Identical inputs SHALL produce identical bytes; changed inputs SHALL replace obsolete managed content. Filesystem failures SHALL reject rather than report success. Startup invocation after listen remains a later assembly responsibility, not this module's side effect.

#### Scenario: Connectable address derivation
- WHEN the actual listener address is0.0.0.0:18016 or IPv6:::18016
- THEN URLs are http://127.0.0.1:18016/v1 and http://[::1]:18016/v1 respectively
- WHEN an explicit IPv4 or IPv6 address is supplied
- THEN that address and actual port are retained with correct IPv6 brackets

#### Scenario: Credential-safe managed output
- WHEN generation runs with proxyBaseUrl http://127.0.0.1:18016/v1 and modelId deepseek-v4.1-flash while parent upstream/token environment sentinels exist
- THEN parsed output contains only the declared workbuddy provider/model, literal env-name apiKey, required limits, the reasoning keys exactly as selected by the `reasoning` option and no authHeader; file content contains none of the unrelated sentinel values

#### Scenario: Deterministic overwrite and escaped model identity
- WHEN identical options are written twice, then a different modelId containing quotes, newline and YAML-significant characters is written
- THEN the first two files are byte-identical and the final parsed file preserves the exact new modelId/name without extra keys/providers or stale model entries
- WHEN the same options are written with `reasoning` true and then false
- THEN the second file contains no `reasoning` or `compat` key and no stale reasoning line remains

#### Scenario: Real filesystem ownership
- WHEN agentDir does not yet exist
- THEN its parents and models.yml are created and readable after the promise resolves
- WHEN agentDir cannot be created or models.yml cannot be written because a regular file occupies a needed directory path
- THEN the promise rejects and unrelated files remain unchanged

#### Scenario: Reasoning declaration toggles
- WHEN generation runs with modelId deepseek-v4.1-flash and `reasoning` true, then with `reasoning` false
- THEN the first parsed model entry has `reasoning: true` and `compat: {reasoningContentField: "reasoning_content"}` and no other added key, and is accepted by omp's models.yml schema; the second has neither key; each variant written twice is byte-identical
- WHEN startup reads `MODEL_REASONING` unset, `on`, `off`, empty and `yes`
- THEN the writer receives true, true and false respectively, and empty or `yes` fails startup before models.yml is written, naming `MODEL_REASONING` without echoing unrelated environment values
