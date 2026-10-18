# Spec Delta

## MODIFIED Requirements

### Requirement: 托管 models.yml
The model-proxy module SHALL export deriveProxyBaseUrl(address:AddressInfo):string and writeManagedModelsYml(agentDir,{proxyBaseUrl,models}):Promise<void> where `models` is the non-empty ordered model whitelist (model-selection「模型白名单配置」), each element `{id,name,reasoning,vision,maxTokens,efforts?}` (model-selection「模型白名单配置」的白名单项，`maxTokens` 恒有) (the server always passes the whole resolved whitelist; an empty array rejects without touching the file). Actual TCP listen addresses SHALL map wildcard0.0.0.0 to127.0.0.1 and wildcard:: to::1; explicit IPv4/IPv6 SHALL be retained, IPv6 enclosed in brackets, actual port used and /v1 appended with http scheme.
The writer SHALL NOT create agentDir or any parent — the directory is established by omp-runtime「OMP_STATE_DIR 托管布局」 before the writer runs, and a missing agentDir rejects — and SHALL deterministically replace agentDir/models.yml — by writing a fresh temporary file in agentDir (created exclusively, never through an existing path) with mode exactly `0640` regardless of the process umask and renaming it over `models.yml`, so that a symlink or foreign file planted at `models.yml` is replaced rather than followed or written through, and no partially written file is ever visible; a failed write SHALL leave no temporary file behind — with block YAML containing providers.workbuddy: api openai-completions, supplied proxyBaseUrl, literal apiKey WORKBUDDY_MODEL_TOKEN, and exactly one model entry per element of `models`, in array order and with no other entry, each holding the element's `id`, its `name`, contextWindow 128000 (the same for every model) and maxTokens equal to the element's `maxTokens` (model-selection「模型白名单配置」: 32768 by default, per model via `MODEL_CATALOG`; fixed at 8192 before owner's 2026-10-18 ruling). When an element's `reasoning` is true its entry SHALL additionally contain, after maxTokens and in this order, `reasoning: true` and a `compat` mapping holding exactly `reasoningContentField: reasoning_content` (omp v18.0.10 `ModelDefinitionSchema` places `reasoningContentField` under `compat`); when false both keys SHALL be absent from that entry. After those keys, an element that carries `efforts` SHALL add a `thinking` mapping holding exactly `mode: effort` and `efforts` as a block list of the element's values in their given order, and an element whose `vision` is true SHALL add `input` as a block list of exactly `text` and `image`, in this order (`thinking` before `input`); an element without `efforts` has no `thinking` key and an element whose `vision` is false has no `input` key. Every reasoning element that comes from `MODEL_CATALOG` carries `efforts` by construction (model-selection「模型白名单配置」 rejects a `reasoning: true` element without it at startup), so every such entry has a `thinking` mapping; the only reasoning element without `efforts`, and therefore the only reasoning entry without a `thinking` key, is the single element of an installation that sets no `MODEL_CATALOG`. For that whitelist — one element whose `name` equals its `id`, with no `efforts`, `vision` false and `maxTokens` 32768 — the output SHALL differ from the files this writer produced before the maxTokens change (checked-in fixtures) in exactly one line, `maxTokens: 8192` becoming `maxTokens: 32768`; every other line SHALL be byte-identical and in the same order. The `thinking` and `input` keys are consumed by omp without schema validation on the host side: their acceptance by omp v18.0.10 and their effect on `get_available_models` are pinned by the official-binary comparison case of model-selection「模型与强度从下一条消息起生效」 and SHALL be re-verified on an omp upgrade; for the `MODEL_CATALOG`-unset entry, which has no `thinking` key, omp derives an effort set of its own from the model id (model-selection「推理强度集合」). The declaration only tells omp the model is a reasoning model on the request side (thinking/effort parameters, and replaying stored thinking into multi-turn history under the `compat.reasoningContentField` name, which DeepSeek-style upstreams validate); it SHALL NOT be relied on to gate the host thinking pipeline, because omp parses `reasoning_content`/`reasoning`/`reasoning_text` response deltas into thinking frames regardless of it (thinking-fold). The mapping from environment variable `MODEL_REASONING` (`on` default → true, `off` → false, any other value including empty rejected at startup with an error naming the variable) and the parsing of `MODEL_CATALOG` into the whitelist belong to startup assembly (`server/src/agent-config.ts`), not to this module: the writer receives the resolved whitelist and performs no validation of its own beyond rejecting an empty array. It SHALL NOT write authHeader or read/expand parent environment credentials. Supplied string values SHALL remain strings and SHALL NOT inject YAML properties. Identical inputs SHALL produce identical bytes; changed inputs SHALL replace obsolete managed content. Filesystem failures SHALL reject rather than report success. Startup invocation after listen remains a later assembly responsibility, not this module's side effect.

#### Scenario: Connectable address derivation
- WHEN the actual listener address is0.0.0.0:18016 or IPv6:::18016
- THEN URLs are http://127.0.0.1:18016/v1 and http://[::1]:18016/v1 respectively
- WHEN an explicit IPv4 or IPv6 address is supplied
- THEN that address and actual port are retained with correct IPv6 brackets

#### Scenario: Credential-safe managed output
- WHEN generation runs with proxyBaseUrl http://127.0.0.1:18016/v1 and the single-model whitelist `[{id:"deepseek-v4.1-flash",name:"deepseek-v4.1-flash",reasoning:true,vision:false,maxTokens:32768}]` while parent upstream/token environment sentinels exist
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
- **WHEN** generation runs with the whitelist `[{id:"m1",name:"通用",reasoning:true,vision:false,maxTokens:32768,efforts:["minimal","low","medium","high","xhigh","max"]},{id:"m2",name:"m2",reasoning:false,vision:false,maxTokens:8192},{id:"m3",name:"深度",reasoning:true,vision:true,maxTokens:32768,efforts:["low","high"]}]`, then again with only `[{id:"m2",name:"m2",reasoning:false,vision:false,maxTokens:8192}]`
- **THEN** the first parsed file has exactly one provider `workbuddy` whose `models` are three entries in that order: `m1` with name `通用`, `contextWindow: 128000`, `maxTokens: 32768`, `reasoning: true`, `compat: {reasoningContentField: "reasoning_content"}`, `thinking: {mode: "effort", efforts: ["minimal","low","medium","high","xhigh","max"]}` and no `input` key; `m2` with `contextWindow: 128000` and `maxTokens: 8192` only; `m3` with name `深度`, `contextWindow: 128000`, `maxTokens: 32768`, the reasoning keys, `thinking: {mode: "effort", efforts: ["low","high"]}` and `input: ["text","image"]`; writing the same whitelist twice is byte-identical; the second file holds the single `m2` entry and no line of `m1` or `m3` remains

#### Scenario: Single-model output is unchanged
- **WHEN** generation runs with the whitelist of an installation that sets no `MODEL_CATALOG` — `[{id:"deepseek-v4.1-flash",name:"deepseek-v4.1-flash",reasoning:true,vision:false,maxTokens:32768}]` (no `efforts`) — and with the same element whose `reasoning` is false, and the results are compared with the files this writer produced before the maxTokens change for `modelId` deepseek-v4.1-flash with `reasoning` true and false (fixtures checked in with the test, left unchanged) after replacing the fixture's single `        maxTokens: 8192` line with `        maxTokens: 32768`
- **THEN** both pairs are byte-identical; compared with the unmodified fixtures, the new output differs in exactly that one line and every other line is byte-identical and in the same order

- **WHEN** generation runs with an empty whitelist
- **THEN** the promise rejects and an existing `models.yml` is left unchanged

#### Scenario: maxTokens reaches the upstream request
- **WHEN** the official pinned omp 18.0.10 binary is started against the fake upstream with a managed `models.yml` whose model entry carries `maxTokens: 32768`, and one prompt turn runs; another run uses an entry with `maxTokens: 8192`
- **THEN** every entry the fake upstream records for that turn (omp-test-harness「受控上游请求记录」) has `maxTokens` equal to 32768, and 8192 in the second run — omp passes the limit through rather than dropping or clamping it (re-verified on an omp upgrade like the other official-binary comparison cases)
