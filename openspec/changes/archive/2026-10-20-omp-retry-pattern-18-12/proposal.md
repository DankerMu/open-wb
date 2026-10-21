# omp-retry-pattern-18-12 — upstream-failure-sanitize 测试的 omp 重试正则重抄为 v18.12.3、model-proxy 424 理由改以 v18.12.3 为基线（#1586）

## Why

`server/test/upstream-failure-sanitize.test.ts:24-28` 的三条正则逐字抄自 omp v18.0.10（`flags.ts` @ 33cc6b9），用例「composes no 424 text that omp's session layer would retry or flag as auth」（`:174-195`）靠它们证明宿主的四份 424 正文不会被 omp 会话层按文本判为可重试 / 鉴权失败。钉住的二进制在 #1563 已翻到 v18.12.3，其 `TRANSIENT_TRANSPORT_PATTERN`（`packages/ai/src/error/flags.ts:229-230`）变宽了九个分支（`auth-gateway\s+5\d{2}`、`temporar(?:y|ily)[ _-]?unavailable`、`use of closed network connection`、`\bE(?:TIMEOUT|NOTFOUND|NETUNREACH|HOSTUNREACH)\b`、`\bFailedToOpenSocket\b`、`no internet connection`、`couldn.?t reach`、`couldn.?t connect to`、`tls certificate verification failed`），`TIMEOUT_PATTERN`（`:168`）与 `AUTH_FAILURE_PATTERN`（`:231-232`）字面不变；并新增 4xx 终止闸 `isTerminalClientErrorStatus`（`:614-616`，`400 ≤ status < 500` 且非 408/429）：`classifyText` 里文本→`Transient`/`Timeout` 的那一段（含 `isTransientErrorText`）包在 `if (!isTerminalClientErrorStatus(statusClean))` 里（`:677-695`）；其余文本判定——`isAuthFailureText`（`:646`）、`EMPTY_RESPONSE_PATTERN`（`:632`）、usage-limit（`:661-669`）、`CONCURRENT_LIMIT`（`:700`）——不受闸约束，424 仍走它们，只是这几条都是英文专用短语、中文 424 正文碰不到。状态来自 HTTP 响应的结构化路径（`ProviderHttpError.status` → `finalize.ts:48,71` → `openai-completions.ts:1832` `errorStatus` → `turn-recovery.ts:1407-1417`），不是文本前缀解析（`STATUS_MESSAGE_PATTERNS :473-479` 解不出「424 模型服务…」），所以闸依赖 `errorStatus` 在场。现在这条用例证明的是「不命中一个已不存在的正则」——假绿；`openspec/specs/model-proxy/spec.md:84` 的 424 理由仍写「为 omp v18.0.10 选的」、只讲措辞，而 v18.12.3 下 Transient/Timeout 这一面的主因已是 4xx 闸（auth 一面仍只靠措辞）。issue-scribe 只读复核：四份 424 文本对 v18.12.3 三条正则均不命中，`param=connect_timeout` / `param=status.504` 正对照仍命中，所以无用户可见后果，只是钉住证明过期。

## What

- 测试期望改动：`server/test/upstream-failure-sanitize.test.ts:24-28` 三条正则换成 v18.12.3 的逐字拷贝（只有 `TRANSIENT_TRANSPORT_PATTERN` 实际变化），`:6-9` 注释出处改为 v18.12.3 `packages/ai/src/error/flags.ts` `:168` / `:229-230` / `:231-232`，并加一句 v18.12.3 的 4xx 终止闸（`:614-616`、`:677-695`）让 424 跳过文本的 Transient/Timeout 判定、文本不命中是第二层，鉴权判定（`AUTH_FAILURE_PATTERN`，对任何状态都检查）仍只靠措辞；出处写 `can1357/oh-my-pi` tag `v18.12.3`。用例本体不变，正对照由三条加到四条：常驻 `TRANSIENT_TRANSPORT_PATTERN.test("temporarily unavailable") === true`——v18.0.10 的正则不命中这句（`service.?unavailable` 要求 `service`），所以它长期证明抄的是 v18.12.3 版，不必临时改 `server/src`。
- spec（编排方）：`model-proxy/spec.md:84` 改为以 v18.12.3 为基线——Transient/Timeout 一面主因是 4xx 终止闸（424 跳过这段文本判定，`:677-695`），次因正文 / 种类名不含可重试词；auth 一面只有措辞一层（`AUTH_FAILURE_PATTERN` 不看状态）。
- 不改 `server/src/`：424 / 502 正文、状态码、`upstream-classify.ts` 的 `SENTENCES` 全部不动；v18.12.3 `isTransientErrorText`（`flags.ts:565-574`）另并入的 `isUnexpectedSocketCloseMessage` / `STREAM_READ_ERROR_PATTERN` / Python h2/h11 谓词不抄：`isTransientErrorText` 只在 `:679` 被调用，就在 4xx 闸里面，424 根本走不到它；用例守的仍是 #909 D7 的三条正则。

`design.md` 省略：compact 级，测试期望 + spec 一句，无运行时改动。

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; compact — test expectation + one spec sentence, no runtime change)
Blast radius: none at runtime; a wrong copy would be a false green (the case guards nothing) or a false red (a 424 text newly matching) — both caught by running the case against the verbatim v18.12.3 patterns
Selected risk packs: Legacy compatibility — meaning only「byte-identical to the pinned upstream source」, not a reason to go expanded (the copied patterns must match omp v18.12.3 flags.ts line for line); Documentation / migration notes (spec :84 baseline sentence, test header provenance)
Evidence floor: npm test --workspace server -- upstream-failure-sanitize (green); diff of the three test regexes against the v18.12.3 source lines is empty (bodies extracted by line number — source sed -n '168p;230p;232p', test sed -n '24p;26p;28p', each grep -o '/.*/i' — diff -u, recorded in the PR); typecheck; make check; git diff --stat has no server/src
```
