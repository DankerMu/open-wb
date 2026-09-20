## ADDED Requirements

### Requirement: 托管 models.yml
The model-proxy module SHALL export deriveProxyBaseUrl(address:AddressInfo):string and writeManagedModelsYml(agentDir,{proxyBaseUrl,modelId}):Promise<void>. Actual TCP listen addresses SHALL map wildcard0.0.0.0 to127.0.0.1 and wildcard:: to::1; explicit IPv4/IPv6 SHALL be retained, IPv6 enclosed in brackets, actual port used and /v1 appended with http scheme.
The writer SHALL create missing agentDir parents and deterministically overwrite agentDir/models.yml with block YAML containing providers.workbuddy: api openai-completions, supplied proxyBaseUrl, literal apiKey WORKBUDDY_MODEL_TOKEN, and exactly one model with supplied id/name, contextWindow128000 and maxTokens8192. It SHALL NOT write authHeader or read/expand parent environment credentials. Supplied string values SHALL remain strings and SHALL NOT inject YAML properties. Identical inputs SHALL produce identical bytes; changed inputs SHALL replace obsolete managed content. Filesystem failures SHALL reject rather than report success. Startup invocation after listen remains a later assembly responsibility, not this module's side effect.

#### Scenario: Connectable address derivation
- WHEN the actual listener address is0.0.0.0:18016 or IPv6:::18016
- THEN URLs are http://127.0.0.1:18016/v1 and http://[::1]:18016/v1 respectively
- WHEN an explicit IPv4 or IPv6 address is supplied
- THEN that address and actual port are retained with correct IPv6 brackets

#### Scenario: Credential-safe managed output
- WHEN generation runs with proxyBaseUrl http://127.0.0.1:18016/v1 and modelId deepseek-v4.1-flash while parent upstream/token environment sentinels exist
- THEN parsed output contains only the declared workbuddy provider/model, literal env-name apiKey, required limits and no authHeader; file content contains none of the unrelated sentinel values

#### Scenario: Deterministic overwrite and escaped model identity
- WHEN identical options are written twice, then a different modelId containing quotes, newline and YAML-significant characters is written
- THEN the first two files are byte-identical and the final parsed file preserves the exact new modelId/name without extra keys/providers or stale model entries

#### Scenario: Real filesystem ownership
- WHEN agentDir does not yet exist
- THEN its parents and models.yml are created and readable after the promise resolves
- WHEN agentDir cannot be created or models.yml cannot be written because a regular file occupies a needed directory path
- THEN the promise rejects and unrelated files remain unchanged
