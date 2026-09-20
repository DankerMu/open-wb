## Why
Issue#89 completes the credential-safe models.yml producer needed by later startup assembly. omp must learn only the local proxy address and fixed session-token environment-variable name, never parent upstream configuration.
## What Changes
- Add only server/src/model-proxy/models-yml.ts and paired tests: deriveProxyBaseUrl(AddressInfo), writeManagedModelsYml(agentDir,{proxyBaseUrl,modelId}).
- Deterministic block YAML, one workbuddy provider/model, safe scalar serialization, recursive agent directory creation and propagated filesystem errors.
- Do not modify server.ts, proxy route, fake-omp, dependencies/config/CI, or upstream code.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- model-proxy: add managed models.yml requirement; existing endpoint and fake-upstream requirements remain unchanged.
## Impact
Pure address transformation and local filesystem generation; production assembly remains#102. Fixture level expanded (retain upstream classification because generated config is read by the credential-isolated child). Selected packs: public API, config/schema, fileIO, secrets, compatibility, error, release/docs. Runtime HTTP/token authentication is inherited group scope but explicitly not part of this generator slice.
