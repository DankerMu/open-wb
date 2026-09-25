# Tasks: legible-smoke-fixtures（#296）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate legible-smoke-fixtures --strict --no-interactive` exit 0。

## 2. Implementation
- [x] 2.1 先改 ui-walk 断言（csv 5 行、`共 4 行`、logo 256×256），用旧夹具跑 ui-walk 应当变红。
- [x] 2.2 替换三个夹具文件，新增 `smoke/fixtures/README.md`；2.1 转绿。
- [x] 2.3 反向注入六项（design Required evidence）各红并回退。

## 3. Verification
- [x] 3.0 archive PR：勾父 tasks 6.2。父 `demo-parity-acceptance` 的「肉眼可辨夹具」在父 change 最终归档时 ADDED，这里只核对它与子 delta 的 files-harness 文本一致，不一致的地方同步到父句。
- [x] 3.1 `make check` exit 0；新文件的 naming-guard exit 0；`git ls-files smoke/fixtures/sandbox` 恰三行。
- [x] 3.2 `make test-guardrails` exit 0。
- [x] 3.3 本地 `ci-compiled-server.sh smoke` 与 `ci-compiled-server.sh ui-walk`（CI 环境变量）各 exit 0；CI smoke、ui-walk、uid-isolation 三个 job 均绿。

## Risk pack mapping
- Not selected Public API / CLI / script entry：不改命令面。
- Not selected Config / project setup：不加依赖、不改 Makefile。
- Selected File IO / path safety / overwrite：README 不进入沙箱复制面。证据：`git ls-files smoke/fixtures/sandbox` 恰三行（design Test plan）与注入 5；CI 的 ui-walk 与 test-guardrails 不检查多余文件。
- Selected Schema / columns / units / field names：csv 表头与行数、png 尺寸。证据：注入 1、2、4，3.3。
- Not selected Auth / permissions / secrets：README 不含敏感信息（gitleaks 在提交时扫描）。
- Not selected Concurrency / shared state / ordering：无。
- Not selected Resource limits / large input / discovery：夹具只有几 KB。
- Selected Legacy compatibility / examples：readme 首行、csv 首两行、文件名不变；files.hurl 与复制 oracle 不改仍绿。证据：注入 3、6，3.2、3.3。
- Not selected Error handling / rollback / partial outputs：无。
- Selected Release / packaging / dependency compatibility：PNG 合法，能在真实浏览器解码。证据：`file` 输出、注入 2、3.3。
- Not selected Documentation / migration notes：README 本身即文档，不涉及迁移。

3.0 实际：勾父 tasks 6.2；父 `demo-parity-acceptance`「肉眼可辨夹具」句中 `naturalWidth === 256` 与父 Scenario 及子 delta 对齐为 `naturalWidth`/`naturalHeight` 均为 256；其余与子 delta 一致，无需改。
