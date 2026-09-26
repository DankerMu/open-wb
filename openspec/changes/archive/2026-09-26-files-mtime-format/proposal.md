## Why
#421: the file preview header renders the modification time as a UTC ISO string: `web/src/features/files/preview.tsx:123` uses `new Date(mtime).toISOString()`, which yields e.g. `2.0 KB · 2026-09-25T08:31:02.123Z`.
- For Chinese users the `T`, the milliseconds and the `Z` are noise.
- The value is in UTC, so a file edited at 16:31 local time (UTC+8) shows `08:31`.
- The demo shows a human-readable time in the same slot (`resource/workbuddy-live-demo.html:3916`; sample values at `:1532-1540`; zero-padded `fmtTime` at `:930`).

User decision (2026-09-25): show an absolute local time, not a relative one. `mtime` is already milliseconds since epoch (`server/src/workspaces/tree.ts:50`; `web/src/lib/api.ts:248-249` rejects non-finite values), so only the display changes.

## Triage
Issue type: bug (demo-parity display)
Fixture level: compact
Upstream suggested level: absent (compact: one pure formatter, one render site, test and spec text)
Blast radius: the preview header meta line only. This is the single mtime render site in `web/src` (the other matches are the type in `types.ts:13`, the API type in `api.ts:56`, validation in `api.ts:239-254`, and pass-through in `tree.tsx:291`). The ui-shots `files-readme` screenshots change text.
Selected risk packs: Legacy compatibility (size formatting and header structure `<大小> · <修改时间>` unchanged).
Evidence floor:
- formatter unit tests under a fixed non-UTC TZ, RED first;
- a header text test;
- the updated pinned tests;
- `make check` green;
- local `make ui-shots` 60/60 with the `files-readme` header reviewed; no e2e asserts the header text, so no e2e change is expected.

## What Changes
- `web/src/features/files/file-meta.ts`: add `formatMtime(ms: number): string`, placed beside `formatSize`:
  - builds `YYYY-MM-DD HH:mm` from `getFullYear`, `getMonth() + 1`, `getDate`, `getHours` and `getMinutes`, each padded with `padStart(2, "0")`;
  - returns `—` for a non-finite input;
  - formats `0` as a normal instant.
- `web/src/features/files/preview.tsx:123`: use `formatMtime(mtime)`.
- Tests:
  - `web/test/file-meta.test.ts`: formatter cases under a fixed `Asia/Shanghai` zone;
  - `web/test/preview.test.tsx:12,157,495` and `web/test/files-page.test.tsx:512`: switch to the new format, with no dependence on the machine TZ.
- `docs/acceptance/demo-parity-checklist.md`: new row FI-34 after FI-33 (`:239`).
- Spec: files-web MODIFIED `文件预览纯组件` (format clause plus a new scenario) and `工作空间页` (header clause and scenario text). The active parent change `s1e-frontend-parity` MODIFIES `工作空间页` too, so its copy is synced in this fixture with the same two phrase replacements. `文件预览纯组件` is not in the parent.

Must preserve:
- `formatSize` output;
- header DOM structure and classes;
- API validation;
- every other test's behaviour under the chosen TZ mechanism. If TZ is set suite-wide, the whole web suite must stay green; a file-local TZ is preferred.

Out of scope: relative time, mtime in tree rows, time display on other pages, server `mtime`.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `files-web`: MODIFIED `文件预览纯组件`, `工作空间页` (parent copy of `工作空间页` synced).

## Impact
- Code: `web/src/features/files/file-meta.ts`, `web/src/features/files/preview.tsx`.
- Tests: `web/test/file-meta.test.ts`, `web/test/preview.test.tsx`, `web/test/files-page.test.tsx`.
- Docs and specs: checklist row FI-34, and `openspec/changes/s1e-frontend-parity/specs/files-web/spec.md` (parent sync, done in the fixture).
