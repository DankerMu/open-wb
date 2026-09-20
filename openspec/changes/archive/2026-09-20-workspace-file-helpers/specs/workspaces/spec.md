## ADDED Requirements

### Requirement: 单层目录列举辅助
`listOneLevel(absDir)` SHALL return only direct ordinary file/directory entries `{name,type:'dir'|'file',size,mtime}` from non-following metadata. size SHALL be native byte size and mtime SHALL be epoch milliseconds. Directories SHALL precede files; names within each category SHALL use UTF-8 byte order, not locale or UTF-16 order. Symlinks including dangling links and all special files SHALL be omitted; nested descendants SHALL NOT be traversed. Metadata/read-directory errors SHALL propagate rather than yield a fabricated empty result.

#### Scenario: 真实一层与类型过滤
- WHEN a directory contains out/ with a.md, b.txt, symlinks to a file/directory/missing target and a FIFO
- THEN root listing contains exactly out(dir) and b.txt(file), while explicitly listing out yields a.md; no symlink/FIFO content is opened

#### Scenario: 字节序与元数据单位
- WHEN retained names include numeric lexical strings, CJK, U+E000 and U+10000, with known file byte contents and mtime
- THEN directories remain first and each group follows explicit UTF-8 order, size is bytes and mtime is the expected epoch-ms value without name normalization

### Requirement: 预览分类元数据与有界字节流
`classifyPreview(absPath,ext,size)` SHALL decide from trusted extension/size metadata without filesystem body IO. Allowed bare extensions case-normalized to lowercase SHALL be md/txt/log/csv/json/js/ts/tsx/html/png/jpg/jpeg. It SHALL return kind, contentType, truncated, limit and production-owned headers for the future route; unsupported names SHALL throw canonical HttpError(preview_unsupported). Text contentType SHALL be text/plain; charset=utf-8 and limit=min(size,1048576), truncated iff size>1048576. Images SHALL be image/png or image/jpeg, untruncated with limit=size, but size>10485760 SHALL throw preview_too_large before content opening. Headers SHALL include Content-Type, nosniff, no-store and original decimal X-Workbuddy-Size; only truncated text SHALL include X-Workbuddy-Truncated:1. `openPreviewStream(absPath,limit)` SHALL yield at most limit raw bytes, zero as empty output, without whole-file buffering/decoding, propagate read errors and release file resources on completion/error/destroy.

#### Scenario: 文本精确阈值与安全元数据
- WHEN classifying and streaming zero-byte text, exact1MiB,1MiB+1 and1.5MiB log or html containing multibyte UTF8 across the cutoff
- THEN bytes equal the original bounded prefix, zero is empty, only sizes above1MiB set truncated header, original X-Workbuddy-Size remains exact, and html is never text/html; all metadata comes from the production classifier

#### Scenario: 图片大小与无正文拒绝
- WHEN a real PNG/JPEG is within10MiB or exactly10MiB, or an image is10MiB+1/11MiB, or extension is zip
- THEN allowed image bytes remain exact with correct image type and security/size metadata; rejected classifications throw preview_too_large or preview_unsupported with no body open/read, not a partial successful response

#### Scenario: 流关闭和错误
- WHEN a permitted stream is consumed, destroyed before completion, or encounters a real filesystem read/open error
- THEN completion/close/error follow native Readable behavior and owned descriptors are released; no silent error-to-empty fallback is introduced
