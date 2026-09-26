## Risk Packs
- Legacy compatibility — selected: `formatSize` output and the header structure `<大小> · <修改时间>` are unchanged, and no other test changes behaviour because of the TZ mechanism → 1.1, 1.3, 2.2.
- Public API, Config, Schema, File IO, Auth/secrets, Concurrency, Resource limits, Error handling, Accessibility, Documentation, Release — not selected (display-only; the checklist row is the only doc).

## 1. Implementation
- [x] 1.1 `web/src/features/files/file-meta.ts`: add the exported `formatMtime(ms: number): string` beside `formatSize` (`:31`), with a one-line doc comment in the file's style.
  - Build the string from the local `Date` getters with `padStart(2, "0")`, as `YYYY-MM-DD HH:mm` (24 h).
  - Return `—` when `!Number.isFinite(ms)`.
  - Format `0` as a normal instant.
  - Do not use `toISOString` or `toLocale*`.
  - `web/src/features/files/preview.tsx:123`: replace `new Date(mtime).toISOString()` with `formatMtime(mtime)`.
- [x] 1.2 `web/test/file-meta.test.ts`: add a `formatMtime` describe that pins `Asia/Shanghai` (UTC+8, no DST since 1991).
  - Prefer a file-local pin, set at **module top level before any `describe`**. `it.each` tables are evaluated at collection time, before `beforeAll`, so local-component inputs such as `new Date(2026, 0, 5, 7, 3)` would otherwise be built in the machine TZ. Alternatively, build those inputs inside the `it` body.
  - Restore in `afterAll`: if the original value was undefined, `delete process.env.TZ`. Assigning `undefined` yields the string `"undefined"`.
  - This works because vitest's default `forks` pool honours a runtime TZ change.
  - First assert the pin took effect: `new Date(0).getHours() === 8`.
  - Cases, per the spec scenario `修改时间本地格式`:
    - `new Date(2026, 0, 5, 7, 3).getTime()` → `2026-01-05 07:03`;
    - `23:59` and the following midnight `00:00`;
    - `Date.UTC(2026, 8, 25, 8, 31)` → `2026-09-25 16:31`;
    - `0` → `1970-01-01 08:00`;
    - `NaN`, `Infinity` and `-Infinity` → `—`.
  - Write it first and show it RED, since `formatMtime` does not exist yet.
- [x] 1.3 Update the tests that pin the ISO text, so none of them depends on the machine TZ. Compute the expectation with `formatMtime(FILE_MTIME)`, or pin the TZ.
  - `web/test/preview.test.tsx`: `:12` (`FILE_MTIME_ISO`), `:157`, `:495`, `:529` and `:536`. In one of them also assert that `.files-preview-meta` matches `/^\S+ \S+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/` and does not match `/T\d{2}:|Z$/`.
  - `web/test/files-page.test.tsx:512`.
  - `grep -rn "toISOString" web/test` afterwards: nothing preview-related remains.
- [x] 1.4 `docs/acceptance/demo-parity-checklist.md`: add a new row FI-34 right after FI-33 (`:239`), in the table's column format.
  - demo refs: `demo:3916`, `demo:1532-1540`.
  - §4 source: `§4.4#4`.
  - Expected: the preview header's modification time is shown as viewer-local `YYYY-MM-DD HH:mm` (24 h, zero-padded), with no ISO `T`/`Z` and no milliseconds. Equivalence note: the demo samples use relative times (`今天 09:12`); by the user's decision (2026-09-25) the app shows absolute local time.
  - Implementation: `web/src/features/files/file-meta.ts:<line>` and `web/src/features/files/preview.tsx:<line>`.
  - Verification: jsdom `web/test/file-meta.test.ts:<line>` and `web/test/preview.test.tsx:<line>`, plus ui-shots `files-readme @1440-light`.
  - All refs carry the suffix `（@#421）` per the header rule at `:11`.
  - Sign-off: `待签`.

## 2. Verification
- [x] 2.1 RED: 1.2 fails before 1.1 (record the failure); everything passes after it.
- [x] 2.2 `make lint`, `make typecheck`, `make test` and `make anti-drift` exit 0. Also run the web suite once with `TZ=UTC` and once with `TZ=America/Los_Angeles` (for example `TZ=… npx vitest run` in `web/`) to prove the tests are machine-TZ independent.
- [x] 2.3 Local `make ui-shots` (compiled server plus fake upstream, fresh temp dir) → `截图 60/60，失败 0`. Hand the output dir to the orchestrator, who checks the `files-readme` header text.
- [x] 2.4 (Precondition: this change archives before the parent `s1e-frontend-parity`; otherwise the child `工作空间页` block must be rewritten against the then-current main spec.) `openspec validate files-mtime-format --strict --no-interactive` and `openspec validate s1e-frontend-parity --strict --no-interactive` pass.
