# Tasks: agent-dir-host-hardening（#706 第一刀）

Fixture level: compact

归档次序（前提）：本 change 先归档进主规格；父 change `s1c-session-metadata-presentation` 的 chat-sessions 与 model-proxy delta 仍是旧文，归档前按 #754 从主规格现文重新生成全部 delta。#706 第二刀的 fixture 在本 change 归档后再从主规格生成。

## 1. 实现
- [x] 1.1 `slash-commands.ts` `listSkills`/`readBounded`：
  - 候选按 SKILL.md 路径码点序排序后只取前 256 个（`MAX_SKILL_ENTRIES`），其余不做任何 fs 访问（不 `realpath`、不 open）；
  - 每个候选：`realpathSync(<skills>/<entry>/SKILL.md)` 必须等于 `realpathSync(<skills>)` 之下的路径（按分隔符边界判断，`skills-evil` 不算在 `skills` 内），否则跳过；`realpathSync(<skills>)` 每次调用只算一次；
  - 打开解析后的路径：`O_RDONLY | O_NONBLOCK | O_NOCTTY | O_NOFOLLOW`；其余（fstat 常规文件、大小上限、按 fstat 大小读）不变；
  - 注释与 JSDoc 同步（「symlinks followed」不再成立）。
- [x] 1.2 `models-yml.ts` `writeManagedModelsYml`：在 agentDir 内以 `wx`（`O_CREAT | O_EXCL`）建临时文件（名字带进程 id 与随机后缀，以 `.` 开头），写入、`fchmod 0o640`（不受 umask 影响）、关闭，最后一步用 `node:fs/promises` 的 `rename(<临时文件>, <agentDir>/models.yml)`；临时文件创建成功之后的任何一步失败都 unlink 临时文件并 reject（`wx` 自身失败时没有可删的文件）。内容生成逻辑零 diff。
- [x] 1.3 测试：
  - skills：spec 新 Scenario 的四种条目（`inside`、`alias`、`escape`、`leak`）；300 个条目只列前 256 且其余 44 个的 SKILL.md 未被打开（对 `node:fs` 的 `openSync` **与 `realpathSync`** 计数——两者都不得触达那 44 个条目，手法同 `server/test/persist-files-changed.test.ts` 的透传记录器；因 `vi.mock("node:fs")` 作用于整个文件，放进新文件 `server/test/slash-commands-skills-hardening.test.ts`）；`skills-evil/` 前缀边界；`O_NOCTTY` 与 `O_NOFOLLOW` 出现在 open flags 里（记录器记下第二个实参）；经 `GET /api/commands` 的 inject 用例证明外部描述不出现。
  - models.yml：spec 新 Scenario（符号链接被替换、外部文件不变、umask `000` 与 `077` 下均为 `0640`、无残留临时文件）；写失败（注入 rename 失败）→ reject 且无临时文件；既有用例零 diff 通过。
  - 启动测试钩子：`server/test/server-startup-helpers.ts` 的 `gatedModelsWriteHook` 现在猴补 `fsp.writeFile` 且按路径以 `models.yml` 结尾触发——写入方改为临时文件 + rename 后它不再触发。改为扣住 `node:fs/promises` 的 `rename`（与现有写法同形：preload 里改 `fsp.rename` 后 `syncBuiltinESMExports()`，所以写入方必须经 `node:fs/promises` 模块的 `rename` 导出调用，不要用 `FileHandle` 或 `node:fs` 的回调/同步版）、目标（第二个实参）以 `models.yml` 结尾时触发（call-through 模式放行后调原函数；throw 模式抛 EACCES，写入方清理临时文件后 reject）。消费它的两条用例（`server-startup-order.test.ts` #210、`listener-shutdown.test.ts` #227）断言不动。
- [x] 1.4 除 `server/src/sessions/slash-commands.ts`、`server/src/model-proxy/models-yml.ts`、`server/test/slash-commands.test.ts`、新 `server/test/slash-commands-skills-hardening.test.ts`、`server/test/model-proxy-models-yml.test.ts`、`server/test/server-startup-helpers.ts`（仅 `gatedModelsWriteHook`）与本 change 目录外不改其它被跟踪文件。

## 评审第 1 轮修复
- [x] F1 `slash-commands.ts`：`skills` 基准与每个候选的真实路径都改用 `realpathSync.native`（内核解析）。Node 的 JS `realpathSync` 在跟随链接后的 `stat` 结果是 FIFO/socket 时直接 `break`、返回词法拼接的路径，且按字符串折叠 `..`：`SKILL.md -> L/../x/secret.yml`（`L -> deep/dir`，`deep/x/secret.yml` 是 FIFO，`x ->` skills 之外的目录）会被 JS 版解析成 `<entry>/x/secret.yml`、通过包含判断，随后 open 沿 `x` 走到外部文件。注释写明为什么必须用 `.native`。
- [x] F2 测试：spec 新 Scenario 的 FIFO 布局用例（`slash-commands-skills-hardening.test.ts`；断言外部文件的 name/description 不出现；未改源码时 RED）。记录器同时代理并记录 `realpathSync.native`（`vi.mock` 的替身函数要带 `.native` 属性，否则生产代码调用会抛）；「其余 44 个不被 resolve」与 257 次计数的断言改为数 `.native` 的调用，JS 版 `realpathSync` 的调用数断言为 0。
- [x] F3 负对照 N9：改回 JS `realpathSync` → FIFO 布局用例失败（外部描述被列出）。全量 server 测试、lint、typecheck、anti-drift（179）、size-guard 重跑；E3 smoke 重跑一次（`.native` 在真实 omp 布局上不改变结果）。

## 评审第 2 轮修复
- [x] F4 `slash-commands.ts`：两处 `realpathSync.native` 都传 `{ encoding: "buffer" }`；包含判断在字节上做（基准字节 + 分隔符字节为前缀）；`openSync` 直接收该 Buffer。任何地方都不得把解析结果解码成字符串后再用于判断或打开（`realpathSync.native` 默认按 utf8 解码，非良构字节变 U+FFFD，重新编码后是另一条路径：`f/\xFF/secret.yml` 在 `skills/` 内，解码再编码成 `f/<EF BF BD>/secret.yml`，而 `f/<U+FFFD>` 是指向外部目录的符号链接）。注释写明原因。
- [x] F5 测试：spec 新 Scenario 的非法字节布局用例，`it.skipIf(process.platform !== "linux")`（macOS APFS 拒绝非法 UTF-8 文件名）；文件名用 Buffer 路径创建。记录器对 `.native` 与 `openSync` 记录的路径实参可能是 Buffer——既有的路径断言改为对其字节（或 `toString()`，仅用于全 ASCII 的测试路径）比较，断言强度不降。
- [x] F6 证据：F5 的 RED→GREEN 必须在 Linux 上取得（本机 docker 的 `ubuntu:24.04` 容器 + Linux 版 Node 24.13.1 跑该测试文件；RED = 只带 F5 不带 F4）；负对照 N10：去掉 `{ encoding: "buffer" }`（回到字符串）→ F5 用例在 Linux 上失败。macOS 上全量 server 测试、lint、typecheck、anti-drift（179）、size-guard 重跑；E3 smoke 重跑一次。

## Must preserve
- `slash-commands.test.ts`、`session-rest-slash.test.ts`、`rest-commands` 相关测试与 `model-proxy-models-yml.test.ts` 的既有断言不动且全绿（含 FIFO/设备/超大文件跳过、同名折叠、目录不存在得 `[]`）。**两处例外**（它们钉的正是被本 change 取代的旧行为，按 spec delta 改写并在报告里列出）：`slash-commands.test.ts` 主场景里 `linked`（指向 `skills/` 之外目录的符号链接）改为不被列出；「follows a SKILL.md symlinked to a regular file」（目标在 `skills/` 之外）改为断言跳过，并补一条目标在 `skills/` 内部时仍被跟随的用例。指向 `/dev/zero` 的用例断言不变（仍被跳过）。
- 指向 `skills/` **内部**的符号链接条目仍可用。
- `server-startup-order.test.ts`（#210，models.yml 写入门控）与 `listener-shutdown.test.ts`（#227，写入失败 → 启动失败）两条用例的断言不动且全绿。
- `make smoke`（真 omp + 托管 `models.yml`）全绿；omp uid 仍能读 `0640` 的 `models.yml`（同组）——本机 smoke 是同 uid，这一条的证据是 CI `uid-isolation` job 的 sudo 模式 smoke。
- `slash-commands.ts` 行数 ≤ 800（现 224）。

## Required evidence
- E1 RED→GREEN：1.3 的新用例在未改源码时失败（`escape`/`leak` 被列出；300 个全部被读；`models.yml` 链接被写穿、mode 随 umask），改后通过。
- E2 `npm test --workspace server` 全绿（文件数/测试数）。
- E3 `make smoke`（CI wrapper，全新状态）全绿；分离 uid 下的可读性由 PR 的 CI `uid-isolation` job 证明（编排方在 PR 上核对）。
- E4 `make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate agent-dir-host-hardening --strict --no-interactive` exit 0。

## Negative controls
- N1 去掉真实路径包含检查 → `escape`、`leak` 用例失败。
- N2 包含检查用 `startsWith(realSkills)`（不带分隔符边界）→ `skills-evil` 用例失败。
- N3 去掉 256 上限 → open 计数用例失败。
- N4 去掉 `O_NOCTTY` 或 `O_NOFOLLOW` → flags 断言失败。
- N5 `models.yml` 改回 `writeFile` 直写 → 链接用例与 mode 用例失败。
- N6 去掉 `fchmod` → umask `000`（或 `077`）下 mode 断言失败。
- N7 去掉失败时的临时文件清理 → 注入 rename 失败的用例失败（目录里留有临时文件）。
- N8 先对全部 300 个条目 `realpath` 再截断 → 计数用例失败。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| File IO / path safety / overwrite | yes | 符号链接跟随、原子替换、临时文件清理 → 1.3、N1、N2、N5 |
| Resource limits / large input / discovery | yes | 条目数上界 → 1.3、N3 |
| Permissions / isolation boundary | yes | `models.yml` mode 与 omp uid 可读 → 1.3、N6、E3 |
| Public API / CLI / script entry | yes | `GET /api/commands` 的内容来源 → 1.3 inject 用例 |
| 其它 | no | 无 schema、UI、依赖改动 |
