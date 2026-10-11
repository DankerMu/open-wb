## Context

根 `package.json` 的 workspaces 恰为 `server` 与 `web`，两者的 `test` 脚本都是 `vitest run --coverage`；拆分前 CI 的 `npm test --workspaces` 就是这两套，随后是 `cd kbservice && uv run pytest`。web 套件在 jsdom 里跑，不调用 uv、Python 或 kbservice。

实测（上一批 PR，10 分钟时限）：6:20、9:41、9:48、超时、9:09、9:57、超时。一次超时运行的分段：`npm ci` 约 8 秒，server 约 3.5 分钟，web 约 6 分钟。

## Goals / Non-Goals

**Goals:**
- server 与 web 套件各自拥有 10 分钟预算，互不占用对方的时间。
- 两个 job 合起来覆盖拆分前的全部套件，任一 failure/cancelled/skipped 使聚合失败。
- oracle 能机械拒绝新 job 缺失、脱离聚合、时限漂移与步骤漂移。

**Non-Goals:**
- 不改测试内容、覆盖率阈值或本地 `make test`（仍是 `npm test --workspaces` 加 pytest）。
- 不改其它 job 的时限，不引入测试分片，不缓存 `node_modules`。
- 不为这两个时限新增 `constraints.yaml` 镜像。

## Decisions

1. `unit-tests` 保留任务名，步骤只把 `npm test --workspaces` 换成 `npm test --workspace server`，其余（setup-uv、`uv sync`、pytest）不动。pytest 留在这一侧：server 侧约 3.5 分钟，余量比 web 侧大。
2. `unit-tests-web` 是 checkout、setup-node、`npm ci`、`npm test --workspace web` 四步，不装 uv：web 套件用不到，setup-uv 的使用点保持两个。
3. `all-checks-passed.needs` 在 `unit-tests` 之后插入 `unit-tests-web`；聚合脚本不变，failure/cancelled/skipped 仍然判失败。
4. oracle 以完整 metadata 与步骤序列钉住两个 job。拆分前 `unit-tests` 的时限与步骤没有被 oracle 钉住（只在 action 矩阵里出现）；这次改了它的步骤，又以时限为裁决依据，所以一并钉住，否则「把 server 套件从 `unit-tests` 里拿掉」或「时限改成 15」不会判红。
5. 计数随之变化：direct job 8→9，checkout 使用点 8→9，setup-node 6→7，setup-uv 仍为 2。

## Risks / Trade-offs

- 多一次 `npm ci`（缓存命中约 8 秒；历史高尾约 300 秒）。两侧在高尾下仍各剩约 4–5 分钟给测试，web 侧约 6 分钟的套件在高尾下会再次吃紧——这是已知限度，不在本变更里处理。
- 并行 job 数加一，占用一个额外 runner。
- 本地 `make test` 仍串行跑两套；CI 与本地的命令不再逐字相同，但覆盖的套件集合相同。

## Migration Plan

单个 PR 原子替换：workflow、oracle、规范 delta 与文档清单同时改。回退即 revert 该 PR。分支保护只指向 `all-checks-passed`，不需要改 Ruleset。
