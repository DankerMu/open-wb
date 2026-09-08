## 1. Baseline and red proof

- [x] 1.1 Record the current server native-loader command exiting 1 with `ERR_MODULE_NOT_FOUND` for extensionless `vitest.shared` before tests/coverage start.
- [x] 1.2 Record the current web native-loader command exiting 1 with `ERR_MODULE_NOT_FOUND` for nonexistent `vitest.shared.js` before tests/coverage start.
- [x] 1.3 Inventory every shared-config consumer and confirm the selected boundary is one tracked `.mjs` file, two exact workspace imports, the Makefile lint/fmt source list and the `biome.json` root include; no root package-wide ESM change is required.

## 2. Atomic ESM boundary

- [x] 2.1 Rename `vitest.shared.ts` to `vitest.shared.mjs` without changing its V8 provider, `src/**/*.{ts,tsx}` include or four 80% thresholds.
- [x] 2.2 Update server and web Vitest configs to consume exact `../vitest.shared.mjs`; preserve server re-export and web `mergeConfig`, `jsdom` and `e2e/**` exclusion.
- [x] 2.3 Update Makefile lint/fmt source lists and the `biome.json` root include from the obsolete root `*.ts` identity to exact `vitest.shared.mjs`; keep the CI Biome command, root/workspace package module types, test scripts, dependencies/lockfile and product sources unchanged.
- [x] 2.4 Prove the old `.ts`, generated `.js`, wrapper/fallback and warning-ignore paths are absent and all tracked references resolve to the unique `.mjs` file.

## 3. Native and default loader evidence

- [x] 3.1 Run the server native-loader command; require exit 0 plus actual test counts and V8 coverage summary with all four thresholds enforced.
- [x] 3.2 Run the web native-loader command; require exit 0 plus actual test counts, V8 coverage summary, jsdom behavior and no `e2e/**` discovery.
- [x] 3.3 Run `make check`; require exit 0 and inspect raw output for absence of native-loader incompatibility, CommonJS shared-config and module-resolution warnings.
- [x] 3.4 Run `make test-guardrails`, strict OpenSpec validation, `git diff --check` and source/config preservation checks; prove `make lint` actually processes `vitest.shared.mjs` while the CI Biome command stays unchanged.

## 4. Non-goals

- [x] 4.1 Do not set `VITE_CONFIG_NATIVE_IGNORE_WARNING`, filter diagnostics, add root `type: module`, upgrade Vite/Vitest/Node, weaken coverage, change tests/product behavior, add dependencies or retain parallel config identities.
