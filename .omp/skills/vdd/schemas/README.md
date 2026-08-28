# Schemas

The Draft 2020-12 JSON Schemas validate the nested structure of VDD 0.4 objective
Contracts and Evidence attestations. They enforce required identity, intent,
Claim/Defeater/Oracle, qualification, fixture, environment, discovery, command,
mode-evidence, residual-risk, merge/release, capability, and control-plane shapes.
Mode/stage and accepted/invalidated conditionals reject structurally incompatible
artifacts.

`tools/vdd_lint.py` adds semantic checks JSON Schema cannot express conveniently:
canonical Contract fingerprint comparison, unique IDs, reciprocal graph links, exact
Oracle/fixture/environment identity, discovery totals and shards, command-reference and
Claim/Defeater coverage resolution, risk-scaled qualification, ordered post-mutant
restoration, independent role authority, residual-risk expiry, cutover completeness,
declared stage-gate execution, and release parent-attestation binding.

`tools/vdd_accept.py` supplies the runtime controls the Schemas cannot: full preflight,
point-in-time execution snapshots, before/after file identity, exact discovery-output
loading, authenticated prior/parent resolution, canonical attestation digests, and
signatures.

Extensions are allowed so projects can add domain-specific evidence. Preserve all
required fields. Use a new `schema_version` for breaking semantic changes rather than
silently redefining an existing field.

```bash
python -m jsonschema -i examples/light-construction/contract.json \
  schemas/contract.schema.json
python -m jsonschema -i examples/light-construction/evidence.json \
  schemas/evidence.schema.json
```
