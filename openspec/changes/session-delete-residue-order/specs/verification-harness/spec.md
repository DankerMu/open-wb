## ADDED Requirements

### Requirement: 部分删除残留断言不依赖并行删除的完成顺序

递归删除失败后，如果用例断言残留的**完整精确树**（对整棵残留树 `toEqual`），其夹具 SHALL 在被删除的目录下只留那一个注定删不掉的顶层子树，不得同时放其它兄弟项。原因是 Node 的 `fs.promises.rm` 并行删除各子项，遇到第一个错误就 reject，兄弟项是否已经删掉不确定。只断言被锁子树仍在、不涉及兄弟项是否存在的用例，不受这条约束。实例：#1490 的「删除失败不影响响应」与 #1746 的 `session-delete-sibling.test.ts` 用例 (e)。

#### Scenario: 精确树断言与删除完成顺序无关
- **WHEN** 连续多次运行 `session-delete-sibling.test.ts` 用例 (e)，夹具的产物目录只有设为 `0500` 的 `local/note.txt` 这一个顶层子树
- **THEN** 每次都通过，残留树恰为 `local` 与 `local/note.txt`，不依赖兄弟项 unlink 的完成顺序
