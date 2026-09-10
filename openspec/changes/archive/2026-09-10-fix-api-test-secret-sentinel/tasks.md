## 1. Fixture repair
- [x] 1.1 Replace only the ServiceInfo matrix secret values and both exclusions with one unique constant; preserve four cases, statuses and fallback.
## 2. Evidence
- [x] 2.1 Parent captures old test failures under physical /private path, then proves candidate four cases pass under both path forms.
- [x] 2.2 Disposable message-leak and stack-leak mutants each fail the real matrix; restore clean source after each (no product edits committed).
- [x] 2.3 Full Web test/coverage, build and default make check pass; strict OpenSpec validation; Phase2 audit confirms fixture-only diff with no weakening, tier none review-not-required record bound to final SHA plus required CI.
