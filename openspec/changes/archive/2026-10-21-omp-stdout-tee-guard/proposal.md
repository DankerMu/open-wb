# omp-stdout-tee-guard — 官方测试的 stdout tee 容错非 JSON 行（#1592）

## Why

`server/test/omp-official-overlay-pins.test.ts:103-113` 的 `teeFrames` 在子进程 stdout 的 `data` 监听器里对每一非空行直接 `JSON.parse`。omp 只要写出一行非 JSON（将来的版本、或只在 Linux 上走到的路径），异常就在流回调里抛出，vitest 报 "Unhandled error"，官方套件因与 advisor / ida 钉无关的原因变红；同一 chunk 里坏行之后的合法帧也进不了 sink，后面的断言看到的帧不全。生产解析器 `server/src/sessions/omp/process.ts:529-535` 对同样输入是 try/catch 后跳过，所以这类红只会出在测试的 tee 里，是误报。兄弟副本 `omp-official-rpc-ui.test.ts:102-115`（`teeUiRequests`）先按子串过滤再解析，过滤后的 `JSON.parse` 同样无保护；第三份 `server/test/support/omp-official-proxied.ts:178-191`（`teeFrames`，供 approval-pairing / upstream-failure / delta-coalescing 三个官方套件用）只按 `line.startsWith("{")` 过滤，`{` 开头的截断行照样抛。三处都是「只旁听」的第二监听器，生产解析器 `process.ts:537-540` 还把解析出来不是对象的行（`null` / 数字 / 字符串 / 数组）当坏行，测试侧也要一致，否则 `frame.type` 取属性会在 `null` 上抛 TypeError。

## What

- 把 tee 抽成 `server/test/support/omp-official.ts` 的一个导出 helper `teeStdoutFrames(stream: Readable, onFrame: (frame: OmpFrame) => void): { malformed(): number }`：只挂 `on("data")`（不 `setEncoding` / `pipe` / `read` / `pause`，`process.ts` 在同一条流上按 Buffer 读），用 `StringDecoder` 解码（多字节 UTF-8 跨 chunk 不乱码），按 `\n` 切分、跨 chunk 拼接半行、空白行跳过不计数、每行 `JSON.parse` 包 try/catch，解析失败或结果不是对象（`null`、数组、标量）的行跳过并计数，合法帧按序回调。三处 tee 都改用它：`omp-official-overlay-pins.test.ts`（全收）、`omp-official-rpc-ui.test.ts`（回调里只收 `type === "extension_ui_request"`，`run.ui` 语义不变）、`support/omp-official-proxied.ts`（全收）。
- 坏行计数进 `overlay-pins` 既有的 `[overlay-pins]` 读数日志（`:241-243`），便于看出 omp 输出的变化。
- 新增一条不依赖官方二进制、默认套件就跑的单测（`server/test/omp-stdout-tee.test.ts`）：用 `PassThrough` 喂含坏行、非对象 JSON 行与跨 chunk 半行的数据，断言不抛、合法帧全部按序回调、坏行计数正确。
- 不改 `server/src/`、不改 CI 清单（新单测不在官方套件清单里，默认套件按 glob 跑）。

`design.md` 省略：compact 级，只改测试支撑代码，无运行时改动。

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; XS test-support fix, no runtime behavior)
Blast radius: none at runtime; a wrong helper would either drop legitimate frames (caught by the new unit test's order/count assertions and by the official suites' existing frame assertions — five files use the three tees) or still throw (caught by the unit test's bad-line and null-line cases)
Selected risk packs: Error handling / rollback (bad line must be skipped, never thrown, the remaining lines of the chunk kept); Concurrency / shared state / ordering (the tee is a second listener on the same stream — frame order and completeness must be preserved); Release / packaging (no new official file, so no CI list change — verified, not assumed)
Evidence floor: npm test --workspace server (default suite incl. the new unit test, green — also proves importing support/omp-official.ts ungated has no module-level side effect); WORKBUDDY_OMP_TEST=1 OMP_BIN=$PWD/var/omp/omp npx vitest run --root server --no-file-parallelism test/omp-official- (all 11 files green — five of them use the tees; malformed count 0 in the [overlay-pins] readings); typecheck; make check; git diff --stat has no server/src and no CI scripts
```
