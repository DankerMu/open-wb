## Why

#115 now supplies canonical preview rejection errors. #117 can deliver the atomic filesystem helper slice needed by later workspace REST without implementing routes, authorization or web rendering.

## What Changes

- Add one-level directory metadata listing with dirs first, UTF-8 byte ordering, and no symlink/special-file traversal.
- Add metadata-only preview classification, production-owned safe response header metadata, and bounded raw-byte Readable creation.
- Verify real temporary directories/FIFO/symlinks, exact byte boundaries and stream lifecycle. No DB/Fastify dependency or sandbox replacement.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `workspaces`: add helper-only listing and preview requirements; existing schema remains unchanged and HTTP route requirements remain pending #127.

## Impact

server/src/workspaces/tree.ts, preview.ts and paired tests with one shared workspace-file-helpers test support module reusing existing tempDir/removeTempDirs; knip.json additionally declares the server test's POSIX mkfifo binary via exact workspace-scoped ignoreBinaries. Interface refinement adds headers and limit to classifyPreview's existing kind/contentType/truncated result so tests consume a real production header builder and #127 need not duplicate size/cutoff logic. Caller authorization/stat/type404 handling remains outside this slice.

Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: filesystem metadata, byte streams, public helper contract and limits)
Blast radius: file listing leakage/incorrect metadata, unsafe content metadata, overreading or leaked streams.
Selected risk packs: public API; file IO; field units; trust boundary; stream lifecycle; resource limits; compatibility; errors; documentation.
Evidence floor: real filesystem TDD, exact 1MiB/10MiB boundaries, production-generated headers, no-content-open rejection evidence, native stream close/error/destroy, server regression/type/build/static and compiled real-file smoke.
