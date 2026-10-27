## 1. 夹具收窄

- [x] 1.1 `server/test/session-delete-sibling.test.ts` 用例 (e)：在 `chmodSync(join(artifacts, "local"), 0o500)` 之前执行 `rmSync(join(artifacts, "1.bash.log"))`，并照 #1490 的写法加一行注释：Node 的 rm 并行删除子项、首个错误即 reject，所以夹具只留一个顶层项。`:158` 的精确树断言，以及「报告一次 EACCES、204、行已删、会话文件与原位置的产物目录都已不在」这几条断言，都保持不变。

验证：
- `npm run test:focus --workspace server -- session-delete-sibling` → 退出码 0。
- 连续跑 20 次：`for i in $(seq 20); do npm run test:focus --workspace server -- session-delete-sibling || break; done` → 全部退出 0。
- `make check` → 退出码 0。

## Risk packs

- 全部 not selected：只改测试夹具，没有运行时代码、接口、配置或文件 IO 行为的变化。
