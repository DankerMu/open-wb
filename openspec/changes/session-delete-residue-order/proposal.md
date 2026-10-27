## Why

`server/test/session-delete-sibling.test.ts` 的用例 (e) 在负载下会偶发失败：回收站里的残留树比预期多出一个 `1.bash.log`（#1746）。

夹具 `ownedArtifactDir` 建的产物目录有两个顶层项：`1.bash.log` 和 `local/note.txt`。用例把 `local` 设成 `0500`，让删除半途失败。问题出在 Node 24 的 `fs.promises.rm`（`lib/internal/fs/rimraf.js` 的 `_rmchildren`）：它并行删除所有子项，任一子项出错就立即 reject，不等其余子项完成。这样一来，另一个子项 `1.bash.log` 删没删掉是不确定的，而用例却断言了精确的残留树。

兄弟用例 `session-delete-temp-workspace.test.ts`「删除失败不影响响应」出过同一个问题，#1490（`15420141`）把夹具收窄成只剩一个顶层项后修好了。用例 (e) 是当时漏掉的另一份副本。

## What Changes

- 用例 (e) 在 `chmodSync` 之前删掉 `1.bash.log`，产物目录只剩 `local` 一个顶层项，并照 #1490 加一行注释说明原因。`:158` 的精确树断言原样保留，现在它的结果是确定的。
- 产品代码不改：`temp-dir-remove.ts` 不改成串行删除，不调超时，不加 retry。
- ADDED verification-harness「部分删除残留断言不依赖并行删除的完成顺序」。

## Triage

```text
Issue type: test
Fixture level: none
Upstream suggested level: absent
Blast radius: 只影响测试稳定性；改错则用例 (e) 失去对「报告一次、204、行已删、残留在回收站」的覆盖
Selected risk packs: none
Evidence floor: 用例 (e) 的其余断言不变且通过；`npm run test:focus --workspace server -- session-delete-sibling` 通过；make check
```

`design.md` 省略：none 级，没有设计取舍。
