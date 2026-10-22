# Tasks: s1b-workspace-mounts

> 跟踪：Stage 5 在 Epic 下建子 issue，十一个任务组各一个子 issue、各一个 PR（非 `atomic` 的组按宽度门禁再拆首刀）。依赖（真实依赖，不串成线性链）：组 1 依赖「s1d-connectors 组 1」（迁移 048 先于 049）；组 2 依赖 #1647（`server.ts` 的配置与启动阶段写法）与「s1d-connectors 组 2」（`server.ts` 行数与 `mcp_json` 阶段）；组 3 依赖 #1656（布局表的 `session-config` 行与 uid-isolation 的 `read:` / `list:`）与「s1d-connectors 组 2」（布局表的 `mcp.json` 行与托管布局用例）；组 4 依赖 #1641（十八码与 `auth-lifecycle.test.ts` 的 790 行）；组 5 依赖组 1、组 2、组 3 与 #1665（P1–P8 无「需 owner 重新拍板」）；组 6 依赖组 5、#1665 与「s1d-connectors 组 2」（`server.ts` 启停接线）；组 7 依赖组 4、组 5、#1641（`isAdmin`、`forbidden`）与「s1d-connectors 组 5」（归属身份二十九条之上再加）；组 8 依赖组 4 与组 5（manager 的登记与状态查询）；组 9 依赖组 7；组 10 依赖组 9、#1651（拷入层 `select`）与 #1664（拷入层 `switch`，由 `s1d-experts-skills` 组 8 / 组 10 中先合入的一组拷入）；组 11 依赖组 6 与 #1665。
> 通用纪律见 design「通用纪律」：测试先行；每组第一个任务核对 design「Context」的行号与事实，出入先改 design 再继续；凭证（口令、私钥、obscure 串）不进任何响应、审计、日志、argv、子进程环境，夹具用哨兵并断言缺席；测试主机地址、用户名、密钥不进被跟踪文件；产品代码单文件 ≤800 行；不新增 `.css`。
> 文档与验收行随组走（AGENTS.md:169-170）；改变用户可见行为的组在同一 PR 增改验收行并写 `待签`，并跑 `web/test/functional-checklist.test.ts`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 凭证泄露（DB、响应、审计、日志、argv、子进程环境、omp uid 可读） | 是 | 组 1 无凭证列、组 3 uid 证明、组 5 argv / 环境 / 文件模式、组 7 视图与审计的哨兵断言 |
| 子进程治理（rclone 生命周期、孤儿、关停、探测阻塞） | 是 | 组 5 卸载、组 6 探测 / 退避 / 启停 |
| 数据安全（挂载内删除、跨挂载移动、离线残留、快照还原） | 是 | 组 5 `--allow-non-empty` 与残留保留、组 8 拒绝分支 |
| 主机规则（环回、许可名单、重挂时复判） | 是 | 组 5 主机判定、组 7 的 403 与审计 |
| 迁移与 DB 约束 | 是 | 组 1 |
| 权限（非管理员写挂载源、他人空间） | 是 | 组 7 的 401 / 403 / 404 矩阵 |
| 真实 FUSE 行为与假可执行文件的落差 | 是 | #1665 前置、组 11 opt-in 层 |

## 1. 迁移 049 与挂载 store（workspace-mounts「迁移 049 挂载 schema」「挂载取值与主机规则」的键集与取值部分）

- [ ] 1.1 核对 Context：迁移目录（三个 s1d change 合入后最后为 048）、`server/test/core-db-helpers.ts` 与 `TRACKED_MIGRATION_FILENAMES`、workspaces `dir` 的 CHECK 写法（`031_workspaces.sql`）、`store.ts` 的 `temporary` 列。
- [ ] 1.2 测试先行：新 `server/test/mounts-store.test.ts`（`:memory:` + 真实迁移）：「形状约束」「被引用的行不能先删」「表里没有凭证」三个场景；`validate` 的每条取值规则正反例（键集按 `backend` 严格、`password` / `privateKey` 恰一、`uploads` 保留、`host` 字符、`port` 边界与字符串、`remotePath` 与 `smb` 的共享名、控制字符与首尾空白、私钥上限与开头）且 message 不含取值哨兵；挂载源的 `name` / `path` 规则与第 33 个；store 的 `create` / `list`（`created_at, id` 升序）/ `remove` / `countByWorkspace` / 挂载源 CRUD 与 `listBySource`；`MIGRATION_049` 进 `TRACKED_MIGRATION_FILENAMES`。验证：`npm test --workspace server -- mounts-store`。
- [ ] 1.3 `049_workspace_mounts.sql`；新 `server/src/workspaces/mounts/{validate.ts,store.ts}`。验证：1.2 全绿、`make check`。

Suggested fixture level: expanded - 新迁移（persisted schema），且取值规则是凭证进入系统的唯一闸门。
Minimal mergeable slice: atomic - 迁移没有 store 就没有读者；取值规则是 store 写入的唯一入口，拆开则存在未校验的写入路径。

## 2. 配置键与启动预检（workspace-mounts「挂载配置与启动预检」；http-service-skeleton「服务启动与装配」的挂载键段与「挂载键与启动预检」场景的配置部分）

- [ ] 2.1 核对 Context：`server.ts` 的 `resolveServerConfig` 与配置计数注释（#1647 与「s1d-connectors 组 2」合入后）、`agent-config.ts` 的 `resolveBrowserBin` 与 `resolveOmpUser(env.PATH)`、`server-config*.test.ts` 的写法与「三十七项」断言。
- [ ] 2.2 测试先行：新 `server/test/mounts-config.test.ts`：「缺省与覆盖」「非法值」「预检」三个场景（预检的 `/dev/fuse` 路径、`/etc/fuse.conf` 路径与 `id` 可执行文件经注入；PATH 上第一个可执行 `fusermount3` 的绝对路径；`#user_allow_other` 不算）；`server-startup-failure-reason.test.ts` 加一例 `RCLONE_BIN` 不可执行 → `reason: "config"`；既有「三十七项」断言改四十。验证：`npm test --workspace server -- mounts-config server-startup-failure-reason server-config`。
- [ ] 2.3 新 `server/src/workspaces/mounts/config.ts`（`resolveMountSettings(env, probes)`：三键与预检）；`resolveServerConfig` 展开它（`server.ts` 只加一行）。验证：2.2 全绿、`scripts/size-guard.sh server/src/server.ts`。
- [ ] 2.4 `docs/architecture/system.md` 新节 §9.9「远程挂载」的部署前提段：三个配置键、`fuse3` 与 rclone（最低版本 = 测试主机实测版本）、`/etc/fuse.conf` 的 `user_allow_other`（`OMP_USER` 模式）、容器部署需 `/dev/fuse` 与 `SYS_ADMIN`（参考镜像暂不提供，见 S4b）、macOS 不支持。

Suggested fixture level: expanded - 新增生产配置项并让它们能使启动失败（production config 触发项）。
Minimal mergeable slice: atomic - 三个键与预检是同一个 resolver 的同一组配置用例；只合键不合预检，`RCLONE_BIN` 配了却在第一次挂载时才失败，违背「预检失败即启动失败」的裁定。

## 3. 托管布局 `<state>/mounts` 与隔离证明（omp-runtime「OMP_STATE_DIR 托管布局」；omp-uid-isolation「Linux 隔离证明」）

- [ ] 3.1 核对 Context：`state-layout.ts` 的 `LAYOUT` 与导出（#1656 与「s1d-connectors 组 2」合入后）、`server/test/linux/uid-isolation.test.ts` 的托管布局用例、omp-test-harness 的 `read:` / `list:` / `probe:`。
- [ ] 3.2 测试先行：布局用例加「挂载私有目录属于布局」（冷建、被改宽校正且其下 `rclone.conf` 不动、符号链接抛错），冷布局的精确目录清单加 `mounts`；`server/test/linux/uid-isolation.test.ts` 托管布局用例加「挂载凭证对 omp uid 不可达」（父进程预置 `<state>/mounts/<id>/rclone.conf` 哨兵；`listed=EACCES`、`read=EACCES`、`wrote=EACCES`；字节、模式、属主不变）。验证：`npm test --workspace server -- state-layout`；PR CI `uid-isolation` 绿。
- [ ] 3.3 `state-layout.ts` 的 `LAYOUT` 加 `["mounts", APP_PRIVATE]` 与 `ompMountsDir(stateDir)`。验证：3.2 全绿。
- [ ] 3.4 ADR-0010 布局表加 `<state>/mounts`（`0700`，app 私有：远程挂载的凭证、缓存与日志）。

Suggested fixture level: expanded - 改托管布局的权限位（security boundary：凭证目录对 omp uid 不可达由 CI 两 uid 证明）。
Minimal mergeable slice: atomic - 布局行与它的 uid 证明同 PR；只合布局行，`0700` 的不可达性没有被真实两 uid 证明过就被组 5 用来存凭证。

## 4. 七个挂载错误码（http-service-skeleton「统一错误信封」的码表部分与「七个挂载码」场景）

- [ ] 4.1 核对 Context：`core/errors/index.ts` 码表（#1641 合入后十八码）、`http/errors.ts` 状态表、三处计数守卫 `http-typed-errors.test.ts`、`http-parser-owners.test.ts`、`auth-lifecycle.test.ts`（790 行）的 `codes` 表。
- [ ] 4.2 测试先行：三处「恰十八码」改二十五；`auth-lifecycle.test.ts` 的 `codes` 表补七条（`satisfies` 穷尽守卫要求，+7 行 → 797，超过 800 即把该表移进新文件 `server/test/support/http-error-codes.ts`）；新 `server/test/http-typed-errors-mounts.test.ts`：「七个挂载码」场景（状态、文案、no-store、与同状态既有码互异、伪造对象仍 5xx）。验证：`npm test --workspace server -- http-typed-errors auth-lifecycle http-parser-owners`、`scripts/size-guard.sh`。
- [ ] 4.3 `core/errors/index.ts` 加七码与文案；`http/errors.ts` 状态表加七行。验证：4.2 全绿。

Suggested fixture level: compact - 纯枚举扩展，三处计数守卫直接钉住，无 IO、无权限面变化（消费者在组 7、组 8）。
Minimal mergeable slice: atomic - 码表、状态表与三处计数守卫必须同 PR，否则守卫红。

## 5. mount-manager：凭证文件、挂载与卸载（workspace-mounts「挂载凭证文件」「挂载进程与挂载点」「挂载取值与主机规则」的主机规则部分、「临时空间与删除前卸载」的按空间卸载）

- [ ] 5.1 核对 Context：#1665 的 ADR-0003 补充（P1–P8 结论，尤其 `local` 一栏与 Open Questions 列出的加测选项）、`fake-soffice.mjs` 的真实 spawn 写法、`ensureSharedDir` / `ensureOwnedDir`、`temp-dir-remove-fuse.test.ts` 的 mountinfo 解析。P1–P8 有「需 owner 重新拍板」时停在这里。
- [ ] 5.2 测试先行：新假 rclone `server/test/fixtures/fake-rclone.mjs`（`obscure -`：读标准输入、输出可预测的 obscure 串；`mount`：按标记成功 / 失败 / 挂起，成功时向测试给的假 mountinfo 文件追加挂载点行并前台等待 SIGTERM；每次调用把 argv、环境与标准输入落成记录文件）与假 `fusermount3`（`-uz <路径>` 从假 mountinfo 删行并记录）；新 `server/test/mounts-manager.test.ts`：「文件形状与权限」「凭证不外泄」（argv / 环境 / 标准输入部分）「卸载删除私有目录」「argv 与环境」「就绪失败不留痕」「惰性卸载与残留」「环回一律拒绝」「许可名单」（manager 层，解析器注入）、按空间卸载、同一空间的建出与卸载串行、mountinfo 八进制转义（含空格的挂载点）。验证：`npm test --workspace server -- mounts-manager`。
- [ ] 5.3 新 `server/src/workspaces/mounts/{host-policy.ts,rclone-conf.ts,mountinfo.ts,manager.ts}`（`attach`、`detach`、`detachWorkspace`、`statusOf`；`mountinfo` 路径、解析器、bins、omp uid 可注入）。验证：5.2 全绿、`make check`。
- [ ] 5.4 文档：ADR-0003「2026-10 补充」产品化一节（rclone 三后端、凭证文件与 obscure、argv 与环境、`--allow-non-empty`、惰性卸载、主机规则、功能开关；证据引 #1665 的 P1–P8）；ADR-0010 补充（挂载选项 `--allow-other --default-permissions --uid <omp> --gid <共享组> --umask 007` 与 `fuse.conf`）；`system.md` §9.9 加「凭证与日志在哪里」，§3 按 design D19 销掉 `deriveWhitelist`「S1b 未来项」、:35 / :109 的「rclone/sshfs」改 rclone、:173 改写；`IMPLEMENTATION_PLAN.md:199` 的「rclone/sshfs」改 rclone 并指向本 change。

Suggested fixture level: expanded - 凭证落盘（credentials at rest）与以 app uid 拉起长驻外部进程（process spawn），且是 Critical Path「挂载凭证存取」。
Minimal mergeable slice: `host-policy.ts` 与 `rclone-conf.ts`（主机判定与凭证文件写出，含 obscure 子进程）——两者无调用方也能以各自单测保绿；`mountinfo.ts` 与 `manager.ts` 的挂载 / 卸载在后继 PR 接上。

## 6. mount-manager：在线状态、退避重挂与服务启停（workspace-mounts「在线状态与重挂」「服务启停与挂载」；http-service-skeleton「服务启动与装配」的恢复与关停部分）

- [ ] 6.1 核对 Context：组 5 合入后的 `manager.ts`、`server.ts` 的 `publishStarted` 与 `releaseOwned`（「s1d-connectors 组 2」合入后的行数）、`trash.sweep` 的不等待写法、app 关闭钩子。
- [ ] 6.2 测试先行：`mounts-manager.test.ts` 加「崩溃即离线并退避重挂」「探测超时」「退避封顶」（注入时钟、假 `stat` 子进程可设为挂起）、卸载取消在途探测与待定重挂、重挂时主机规则复判；`mounts-manager.test.ts` 加「启动恢复与残留挂载」「关停卸载」的 manager 部分；新 `server/test/server-startup-mounts.test.ts`（编译入口 + 假 rclone + 假 `fusermount3`，`/dev/fuse` 不存在时明示跳过）：「挂载键与启动预检」的启动成功与 SIGTERM 两例（假 rclone 在 DB 关闭之前已退出、挂载行仍在）、恢复失败不影响 success record 与退出码。验证：`npm test --workspace server -- mounts-manager server-startup-mounts`。
- [ ] 6.3 `manager.ts` 加探测（子进程 `stat`、每挂载至多一个在途）、退避定时器、`restoreAll`、`closeAll`；`server.ts` 在 `server_started` 之后 `void restoreAll()`（一行），`closeAll` 挂在 app 关闭钩子（`app.ts`）；`server.ts` 超过 795 行即把这两处接线并进 `startup-registry.ts`。验证：6.2 全绿、`scripts/size-guard.sh`。
- [ ] 6.4 `system.md` §9.9 加在线判据、30 s 探测、退避 5 s → 300 s、启动恢复、关停只卸载不删行、回滚（撤 `RCLONE_BIN`、旧版本下先卸载）。

Suggested fixture level: expanded - 改服务启停（startup / shutdown）并新增后台子进程监管（Critical Path「进程治理」）。
Minimal mergeable slice: `manager.ts` 的探测、退避与 `restoreAll` / `closeAll`（模块用例保绿，不接入口）；`server.ts` 与 `app.ts` 的接线与编译入口用例在后继 PR。

## 7. 挂载与挂载源端点（workspace-mounts「挂载端点」「挂载源端点」「临时空间与删除前卸载」的拒绝部分、「凭证不外泄」的 HTTP 部分；http-service-skeleton「统一错误信封」的归属身份与「挂载的归属路由」场景）

- [ ] 7.1 核对 Context：`workspaces/rest.ts` 的 `requireOwnedBeforeParse` 与 `move` 的 preParsing 写法、`http/errors.ts` 归属集与 `http-parser-owners.test.ts` 身份清单（「s1d-connectors 组 5」合入后二十九条）、`core/roles` 的 `isAdmin`（#1641）、审计 `emit` 的事务写法。
- [ ] 7.2 测试先行：新 `server/test/mounts-rest.test.ts`（整体挂载 `createApp`，注入以假 rclone / 假 `fusermount3` 装配的真实 manager）：「建出、列举与卸载」「次序与拒绝」「插行失败先卸载」「并发建出受上限约束」「转正之后可以挂载」、建出时环回 403 与 `mount.reject`、就绪失败 502 与 `mount.reject`、全部响应与审计无凭证哨兵、`enabled` false 时 `GET` 与 `DELETE` 可用而 `POST` 503；新 `server/test/mount-sources-rest.test.ts`：「两种视图」「拒绝的路径」「删除连带卸载」、普通用户 403 先于 body 与 id；`http-parser-owners.test.ts` 身份清单 → 三十一条，加「挂载的归属路由」场景。验证：`npm test --workspace server -- mounts-rest mount-sources-rest http-parser-owners`。
- [ ] 7.3 新 `server/src/workspaces/mounts/rest.ts`（两组路由，由 `registerWorkspaces` 注册）；归属集加两条身份。验证：7.2 全绿、启动记录的模块数仍为十一。
- [ ] 7.4 `system.md` §9.9 加端点、视图、审计 kind（`mount.attach` / `mount.detach` / `mount.reject` / `mount.source.create` / `mount.source.delete`）与「挂载源删除连带卸载」。

Suggested fixture level: expanded - 用户凭证经 HTTP 进入系统、管理员写路径（credentials + auth 触发项）。
Minimal mergeable slice: 挂载源端点（`GET` / `POST` / `DELETE /api/mount-sources`、一条归属身份、两种视图与 403 矩阵）——它只依赖 store 与 manager 的 `detach`，能以自己的整体挂载用例保绿；挂载端点在后继 PR。

## 8. 挂载目录内的文件端点（workspace-mounts「挂载目录内的文件端点」；file-operations「删除到回收目录」「重命名与移动」；workspaces「目录树、新建目录与隔离」）

- [ ] 8.1 核对 Context：`rest.ts` 的 tree / dirs / file 与 `rest-archive.ts`、`rest-entries.ts` 的 download / delete / move（`sandbox.resolve` 之后、存在性检查之前的插入点）、组 5 的 `statusOf`。
- [ ] 8.2 测试先行：新 `server/test/mounts-file-endpoints.test.ts`（整体挂载，manager 以假 rclone 建出在线、离线、只读挂载）：「删除与跨挂载移动」「离线与只读」「越界先于挂载判定」、file-operations 的「挂载内不能删除」「跨挂载边界」、workspaces 的「离线与只读挂载」；拒绝时 `.trash` 无新批次、无 `file.delete` / `file.move` / `dir.create` 审计、文件系统未被访问（离线挂载点上放一个哨兵文件，断言不被列出或读取）；名字以挂载名开头的普通目录不受影响。验证：`npm test --workspace server -- mounts-file-endpoints`。
- [ ] 8.3 新 `server/src/workspaces/mounts/path-rule.ts`（第一段判定 + 七个端点的规则）；`rest.ts`、`rest-archive.ts`、`rest-entries.ts` 在插入点各调用一次。验证：8.2 全绿、既有 file-operations 与 workspaces 用例不变。
- [ ] 8.4 `system.md` §9.9 加「挂载内的文件操作」一段（删除与跨挂载移动拒绝、离线与只读的码、`uploads` 保留）。

Suggested fixture level: compact - 只新增拒绝分支、不新增写路径；判定只读内存登记，由一条整体挂载用例钉住。
Minimal mergeable slice: atomic - 一个判定函数与它在七个端点的调用点共用一个用例文件；只接一部分端点会让挂载内删除仍走到 `EXDEV` 的 generic 500。

## 9. 前端：挂载根行与卸载（workspace-mounts「挂载根行」；files-web「工作空间页」的空根部分与「有挂载时的菜单与空根」场景的空根部分）

- [ ] 9.1 核对 Context：`workspace-browser.tsx`（783 行）的根行渲染与 `刷新`、`tree.tsx` 的行组件与放下目标判定、`dialogs.tsx` 的 `位置` 下拉、`web/src/lib/api-files.ts` 的解析写法、拷入层 `alert-dialog`。
- [ ] 9.2 测试先行：新 `web/test/api-mounts.test.ts`（`MountView` / `SourceView` 严格解析、`mountId` 编码）；新 `web/test/files-mount-roots.test.tsx`（假 `ApiClient`）：「在线、只读与离线」「卸载」「两处同一份实现」（侧边栏渲染）、空间根列表去掉挂载点、挂载根行无 `更多操作`、不可拖、不是放下目标、`位置` 下拉排除只读与离线挂载、`GET …/mounts` 失败的 `role="alert"`、`刷新` 重取；`files-web` 的空根用例：有挂载时显示 `空目录` 而不是 `该工作空间暂无目录`。验证：`npm test --workspace web -- api-mounts files-mount-roots`。
- [ ] 9.3 新 `web/src/lib/api-mounts.ts` + `api.ts` 导出；新 `web/src/features/files/mount-roots.tsx`（挂载根行与卸载确认）；`workspace-browser.tsx` 只加接线（≤798 行）。验证：9.2 全绿、`scripts/size-guard.sh`、typecheck。
- [ ] 9.4 验收清单文件节新增 FL 行（以合入时末号续编）：SFTP 挂载在线时在树里可展开、可新建文件夹、会话里助手能读写挂载内的文件；只读挂载显示 `只读` 且新建被拒；停掉远端后刷新显示 `离线` 且不可展开、恢复后自动回到 `在线`；卸载后挂载根行消失、助手再访问该目录失败；挂载内删除被拒的文案；结论 `待签`。验证：`web/test/functional-checklist.test.ts`。

Suggested fixture level: compact - 列表与卸载按钮，服务端契约由组 7、组 8 钉住。
Minimal mergeable slice: atomic - API 客户端、根行与卸载确认是同一可见行为的一条组件用例路径；只合客户端没有调用方。

## 10. 前端：挂载对话框与走查（workspace-mounts「挂载对话框」；files-web「工作空间页」的 `新建` 菜单）

- [ ] 10.1 核对 Context：组 9 合入后的 `api-mounts.ts` 与 `mount-roots.tsx`、`columns.tsx` 的 `新建` 菜单、拷入层 `select`（#1651）与 `switch`（#1664）、`web/e2e/ui-walk-files.ts`。
- [ ] 10.2 测试先行：新 `web/test/files-mount-dialog.test.tsx`（假 `ApiClient`）：「入口随开关」「提交与失败就地显示」「本地校验与服务器目录」、`aria-modal` 与初始焦点、请求中禁用与 `取消` 中止、关闭后凭证字段清空、地址与 Web Storage 无私钥哨兵、无 Toast；files-web 的「有挂载时的菜单与空根」菜单部分。验证：`npm test --workspace web -- files-mount-dialog`。
- [ ] 10.3 新 `web/src/features/files/mount-dialog.tsx`；`columns.tsx` 加可选 `挂载目录` 项；`api-mounts.ts` 加 `createMount` 与 `listMountSources`。验证：10.2 全绿、typecheck、size-guard。
- [ ] 10.4 `make ui-walk` 文件页一步（`web/e2e/ui-walk-files.ts`）：`enabled` 为 false 时 `新建` 菜单没有 `挂载目录`；为 true 时打开对话框、以主机 `localhost` 提交、对话框内出现 `该主机不允许挂载`、取消后没有新增挂载根行——两种都不需要远端。验证：`make ui-walk` 对一个已运行的服务绿。
- [ ] 10.5 验收清单文件节新增 FL 行：经对话框挂载 SFTP（密码与私钥各一）、SMB、管理员登记的服务器目录；错误凭证就地显示 `挂载失败，请检查主机、路径与凭证`；结论 `待签`。验证：`web/test/functional-checklist.test.ts`。

Suggested fixture level: expanded - 用户录入凭证的表单（credentials 触发项），尽管服务端契约已由组 7 钉住。
Minimal mergeable slice: atomic - 菜单项、对话框与提交是同一条组件用例路径；菜单项没有对话框就是占位。

## 11. 真实挂载验证层（workspace-mounts「真实挂载验证层」）

- [ ] 11.1 核对 Context：`temp-dir-remove-fuse.test.ts` 的 opt-in 与 `requirePrerequisites` 写法、#1665 的容器搭法（不入库的部分只留在测试主机）。
- [ ] 11.2 新 `server/test/linux/mounts-fuse.test.ts`：「非 opt-in 明示跳过」「opt-in 缺前提即失败」「local 后端的生命周期」与可选的 `sftp` 读写例（`WORKBUDDY_FUSE_SFTP_*` 只给一部分即失败）；每例先卸载、确认 mountinfo 无挂载点，再以 `fs/promises` 的 `rm` 清理。验证：本机与 CI 报告 skipped；测试主机一次性容器里 `WORKBUDDY_FUSE_TEST=1` 全绿三次。
- [ ] 11.3 ADR-0003「2026-10 补充」追加本层在测试主机的运行结果表（容器形态、rclone / fusermount3 版本、每例结果；不含主机地址与凭证）。

Suggested fixture level: compact - 只加 opt-in 测试与 ADR 记录，不改产品代码、不进 CI。
Minimal mergeable slice: atomic - 一个测试文件与它的实测记录，没有可独立合并的更小子集。
