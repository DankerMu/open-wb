## Context

Change surface: workspaces/tree.ts and preview.ts plus paired tests. These are read-only filesystem helpers, not mathematically pure functions; classification itself is metadata-only.
Must preserve: PREVIEWABLE exact demo:3818 set, canonical core/errors HttpError, web Entry {name,type,size,mtime} with mtime epoch-ms (preview.tsx uses new Date(mtime)), no database/http imports or new production routes.
Governing invariant: directory results expose only direct ordinary files/directories without following symlinks; preview decisions precede body opening and emitted bytes never exceed the supplied bound.
Sibling surfaces: directory readdir/lstat/type/sort, preview extension/size classifier+headers+limit, native read stream end/close/error, future #127 stat/type checks and sandbox.resolve call, web header consumer from #118.

## Decisions

- `listOneLevel(absDir): Entry[]` is synchronous. Each direct child's lstat metadata supplies file/dir type, size in bytes and mtimeMs; directories report native stat.size (not recursively aggregated size). Skip symlink (file/dir/dangling) and all other types including FIFO. No traversal into child directories.
- Sort directories before files; within each group use UTF-8 bytes. Encode each retained name once before comparison, not per comparator invocation; no localeCompare/UTF16 default sort, and no import of core/db migration internals. Preserve names exactly.
- Filesystem metadata failures propagate (e.g. nonexistent/non-directory target). REST maps appropriate ENOENT/ENOTDIR to404 later; helpers do not swallow failures into an empty list.
- `classifyPreview(absPath, ext, size)` accepts a caller-authorized absolute path plus trusted bare extension/stat byte size. It does no filesystem/body IO. The mandated absPath parameter is opaque context, not a source of headers/errors or a second stat; retain it without inventing path validation or echoing it. Lowercase ext internally; allowed bare names exactly md/txt/log/csv/json/js/ts/tsx/html/png/jpg/jpeg.
- Result retains `{kind,contentType,truncated}` and adds `headers` and `limit`. headers are production-owned Content-Type, X-Content-Type-Options=nosniff, Cache-Control=no-store, X-Workbuddy-Size=original decimal bytes; add X-Workbuddy-Truncated=1 only for oversized text. limit is actual maximum byte count for openPreviewStream: min(size,1048576) for text, full size for allowed image. No test-only fabricated header assembly.
- All text (including html/json/js) is text/plain; charset=utf-8. Text size>1048576 truncates, equality does not. png image/png; jpg/jpeg image/jpeg. Image size>10485760 rejects canonical preview_too_large; equality allowed. Unsupported extension rejects preview_unsupported before any content IO. Rejections do not build/open a body stream.
- `openPreviewStream(absPath,limit): Readable` uses native bounded raw-byte streaming, inclusive end=limit-1 for positive limits; zero yields an empty binary-mode Readable without end=-1. Caller passes nonnegative integer limits from classifier; do not add a separate public validation policy. No readFile/full-file buffering or UTF-8 decoding. Native read errors propagate; native auto-close/destroy lifecycle releases descriptors.
- No security claim beyond supplied authorized paths/static filesystem: sandbox.resolve integration, missing/nonregular preview target404 and HTTP sending/actual statuses remain #127. No TOCTOU hardening, inode pinning, permissions mutation or new containment abstraction in this slice.
- Readiness scope clarification: real FIFO creation necessarily invokes POSIX mkfifo. Knip cannot infer system binaries from package dependencies; server workspace declares only ignoreBinaries:["mkfifo"]. No file/global ignore, threshold change, command-obfuscation workaround, npm dependency or FIFO skip. The real local/Ubuntu test and compiled smoke must actually invoke this binary; absence is a test failure.

## Evidence

Real temp tree has nested directory, plain files, symlinks to file/dir and dangling link plus mkfifo-created FIFO; exact top-level output, nested omitted. Explicit Unicode ordering includes BMP private-use U+E000 versus U+10000 (UTF16 counterexample) and numeric lexical names; set known mtime via utimes and verify millisecond consumer values.
Preview tests cover exact allowed extension set/case normalization; original size headers, nosniff/no-store/text html policy; text0/1MiB/1MiB+1 and1.5MiB, image10MiB/10MiB+1 and11MiB, actual PNG bytes. Cut across multibyte UTF8 and compare exact raw prefix, not decoded text length.
Rejected classifications use real file metadata and observe actual content-open/read seams (fs.read and createReadStream; inspect implementation for alternate read paths) zero calls. Also demonstrate classifier decisions don't require opening the path; do not mock classifier or claim future REST ordering was exercised.
Fully consumed stream, stream read error, and early destroy must close; observe native close and externally unusable captured descriptor where available without mocking stream internals. Empty output has no invalid negative end. Real compiled helper smoke exercises actual temporary files and removes all resources.

## Risks / Trade-offs

Header metadata is an additive interface clarification demanded by #117 acceptance; no Fastify coupling. #127 must forward this metadata rather than reconstruct policy. Trusted size/ext inputs and post-resolve absolute paths are caller obligations, not user-input validation seams here.
Pre-existing migrations comparator is evidence against locale/UTF16, not a shared import candidate. Existing resolve is metadata-only/static; do not claim helpers eliminate concurrent filesystem races. Invalid UTF-8 filename byte sequences are not a new transport feature in this slice.
Rollback is atomic code revert; no stored data/schema changes. Review focus: exact byte/order units, no symlink/FIFO body access, thresholds before opening, stream resource release, honest helper versus HTTP proof boundary.
