## Why
Issue #119 supplies safe, network-independent file preview components before the files page is wired in #129.
## What Changes
Add md-render.ts, csv.ts and preview.tsx with paired jsdom tests, preserving demo provenance and supported rendering behavior without new dependencies.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `files-web`: add a separate preview-component requirement; do not promote unfinished tree/page behavior from the parent combined requirement.
## Impact
Issue type: feature
Fixture level: expanded
Upstream suggested level: compact (override: untrusted Markdown-to-HTML parser and DOM rendering are security/reader boundaries).
Blast radius: future files PreviewPane consumers; no API, route, server or filesystem changes.
Selected risk packs: public component/parser API, rendering input safety, shape/metadata, local state transitions, resource ownership, demo compatibility, errors, provenance.
Evidence floor: semantic RED/GREEN, Markdown semantic snapshot and DOM security assertions, full web suite/typecheck/build/static/drift, real Chromium isolated-component smoke plus screenshot and zero errors, static cross-review and CI.
