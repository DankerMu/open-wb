## ADDED Requirements

### Requirement: 轮询读取并发追加的 JSONL 时只解析已结束的行

测试会在另一个进程（假 rclone、假 `fusermount3` 等）往一个 JSONL 文件追加记录的同时轮询读取它。这类读取 SHALL 只解析以 `\n` 结束的行，末尾没有 `\n` 的那一段 SHALL 视为没写完、本次丢弃，等下次读取再看。以 `\n` 结束、但不是合法 JSON 的行 SHALL 照样抛错。同一个文件的各个读取点 SHALL 用同一个读法，不得各留一份不一致的副本。

实例：#1878 的 `fake-rclone-calls.jsonl` 与 `fusermount3-calls.jsonl`。

#### Scenario: 半行不进解析
- **WHEN** 文件内容是一条完整记录加换行，后面跟着第二条记录的前半段（没有换行）
- **THEN** 读取只返回第一条；第二条补全并写入换行之后，下一次读取返回两条

#### Scenario: 已结束的坏行仍然报错
- **WHEN** 文件里有一行以 `\n` 结束，但内容不是合法 JSON
- **THEN** 读取抛错，不把这一行跳过
