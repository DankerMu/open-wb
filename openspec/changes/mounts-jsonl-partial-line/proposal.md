## Why

假 rclone 正在往 `fake-rclone-calls.jsonl` 追加一条记录时，测试进程如果去读这个文件，可能只读到这一行的前半段：这时行尾还没有换行。读方 `readJsonl`（`server/test/mounts-manager-helpers.ts:305-311`）按 `\n` 切开文件、过滤空串，再逐段 `JSON.parse`，并不检查最后一段是否以换行结束。半行一进 `JSON.parse` 就抛 `SyntaxError`，`waitFor` 又不捕获异常，用例当场判红（#1878，CI run 41375024035，`mounts-manager-lifecycle.test.ts:577`）。被测的挂载管理器本身没有问题，失败只来自测试侧的读法。

## What Changes

- `server/test/support/jsonl.mjs`（类型在 `jsonl.d.mts`）新增导出的 `readCompleteJsonl(file)`：
  - 文件不存在时返回空数组；
  - 只解析以 `\n` 结束的行，末尾没有 `\n` 的那一段视为没写完，直接丢弃，下次读取时再看；
  - 以 `\n` 结束、但内容不是合法 JSON 的行照样抛错，不吞掉。

  这样判定半行是成立的：写方每条记录只调用一次 `appendFileSync(JSON + "\n")`，`\n` 是这次写入的最后一个字节；`JSON.stringify` 又会把字符串里的换行转义，所以半行里不可能出现 `\n`。
- 下列读取点改用同一语义：
  - `mounts-manager-helpers.ts` 的 `readJsonl`：它是 `calls`、`mountCalls`、`fusermountCalls`、`disposeWorlds` 的共同来源；
  - `mounts-manager-assembly.test.ts` 的 `mountCalls`；
  - `server-startup-mounts.test.ts` 的 `mountCalls`；
  - `mounts-rclone-conf.test.ts` 的 `calls`；
  - `fixtures/threadpool-recovery.mjs` 的 `lines`：helper 写成 `.mjs`，这个子进程脚本直接导入同一份。
- 产品代码、假 rclone 与假 `fusermount3` 的写法、`waitFor`、超时都不改，也不加 retry。
- 在 verification-harness 增加一条要求：「轮询读取并发追加的 JSONL 时只解析已结束的行」。

## Triage

```text
Issue type: test
Fixture level: none
Upstream suggested level: absent（issue 自评 p3 / S）
Blast radius: 只影响测试稳定性；改错会让 mounts 用例读不到记录（waitFor 超时变红）或吞掉真实的格式错误
Selected risk packs: none
Evidence floor: 确定性用例覆盖「完整行 + 半行」「半行补全后」「已结束的非法行仍抛错」；全部读取点改为同一语义（grep 证明）；test:focus 三组通过；make check
```

`design.md` 省略：本 change 为 none 级，取舍已写在上文和 #1878 的「解决思路」里。
