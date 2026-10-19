# Spec Delta

## MODIFIED Requirements

### Requirement: 服务启动与装配
系统 SHALL 以 `server/src/app.ts` 装配 Fastify 实例，并以 `server/src/server.ts` 作为唯一 production listen/DB ownership 入口；import该module只暴露pure config seam，不得mkdir/open/listen或注册signal，只有ESM main guard命中的执行路径可启动。唯一配置源为 own environment keys `HOST`、`PORT`、`DB_PATH`、`STATIC_ROOT`、`OMP_BIN`、`OMP_STATE_DIR`、`OMP_IDLE_MS`、`OMP_MAX_PROCESSES`、`OMP_SPAWN_CONCURRENCY`、`SANDBOX_ROOT`、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY`、`MODEL_ID`、`OMP_USER`、`MODEL_REASONING`、`SNAPSHOT_MAX_FILE_BYTES`、`SNAPSHOT_MAX_TOTAL_BYTES`、`SNAPSHOT_MAX_ENTRIES`、`SNAPSHOT_EXCLUDE_NAMES`、`APPROVAL_MAX_MODE`、`MODEL_CATALOG`、`UPLOAD_MAX_BYTES`、`UPLOAD_MAX_FILES`、`BROWSER_BIN`、`MODEL_VISION`，以及下一段列出的十二个预览与文件键（共三十七项）：前二十五项的缺省值分别为 `127.0.0.1`、`3000`、repo-root `var/dev.db`、repo-root `web/dist`、repo-root `var/omp/omp`、repo-root `var/omp-state`、`600000`、`16`、`os.availableParallelism()`、repo-root `var/sandbox`、未配置、未配置、`deepseek-v4.1-flash`、未配置（同uid直接spawn）、`on`、`20971520`、`524288000`、`50000`、`node_modules,.venv,__pycache__`、`yolo`、未配置、`524288000`、`10`、未配置（部署没有浏览器）、`on`；relative DB/static/omp/state/sandbox path SHALL 相对由 entry module identity 推导的repo root，不得随shell/npm workspace cwd分裂。`PORT` SHALL只接受canonical ASCII decimal `1..65535`；HOST missing取默认、empty或whitespace-only非法且不得trim/coerce；exact `localhost` SHALL 规范为 `127.0.0.1` 以保证单一 listener binding，其它nonempty string原样交listen；DB/static/omp/state/sandbox path explicit empty非法。`OMP_IDLE_MS` SHALL只接受canonical ASCII decimal整数1..2147483647（原生计时器上限，用户明确批准超限启动失败）；`OMP_MAX_PROCESSES` SHALL 遵守与 `OMP_IDLE_MS` 相同的解析纪律（canonical ASCII decimal 正整数 1..2147483647，缺省 16，empty/`0`/非 canonical/超限均为启动失败），经 `agent-config.ts` 同一 resolver 解析为 supervisor 的全局活进程上限；`OMP_SPAWN_CONCURRENCY` SHALL 遵守同一解析纪律（缺省 `os.availableParallelism()`），经同一 resolver 解析为 supervisor 的并发 spawn 上限（见 omp-pool「并发 spawn 上限」）；`MODEL_ID` 缺省 `deepseek-v4.1-flash`；显式给出时 SHALL 为 1 到 128 个 UTF-8 字节、不含 U+0000–U+001F 与 U+007F 的字符串（与 model-selection「模型白名单配置」对白名单条目 `id` 的规则相同），取值原样使用、SHALL NOT 去首尾空格（` custom-model ` 是合法取值，首尾空格属于模型名）；empty、含上述任一控制字符、超过 128 个 UTF-8 字节均为启动失败（owner 2026-10-12，#1261）。这项校验与是否配置 `MODEL_CATALOG` 无关（配置了白名单时，违反它的取值本来也不等于任何一项的 `id`，同样点名 `MODEL_ID`）；`MODEL_REASONING` SHALL 只接受 exact `on` 或 `off`（缺省 `on`；empty、大小写不同如 `ON`、`true`/`yes` 及其它任何值均为启动失败），经同一 resolver 解析为布尔并作为托管 models.yml 的 `reasoning` 输入（`on` → true、`off` → false，写出规则归 model-proxy）；`SNAPSHOT_MAX_FILE_BYTES`、`SNAPSHOT_MAX_TOTAL_BYTES`、`SNAPSHOT_MAX_ENTRIES` SHALL 遵守与 `OMP_IDLE_MS` 相同的解析纪律（canonical ASCII decimal 正整数 1..2147483647，empty/`0`/非 canonical/超限均为启动失败），`SNAPSHOT_EXCLUDE_NAMES` SHALL 为逗号分隔的目录名列表（显式 empty 合法，表示不排除任何目录；任一名段为空、含 `/` 或 NUL、为 `.` 或 `..` 均为启动失败），四者经同一 resolver 解析为快照设置（语义归 workspace-snapshots「快照上限与配置」）；`APPROVAL_MAX_MODE` SHALL 只接受 exact `always-ask`、`write` 或 `yolo`（缺省 `yolo`；empty、大小写不同如 `YOLO`、首尾带空白及其它任何值均为启动失败），经同一 resolver 解析为全部会话可用审批档位的上界（session-permission-tier「管理员最高档」）；`MODEL_CATALOG` 缺省未配置，显式给出时 SHALL 按 model-selection「模型白名单配置」解析为模型白名单（JSON 数组；它与 `MODEL_ID`、`MODEL_REASONING` 的关系、全部非法情形及各自点名的键见该条），未配置时白名单是由 `MODEL_ID`、`MODEL_REASONING` 与 `MODEL_VISION` 构成的单模型——托管 models.yml 的输入由此从「一个模型 id 加一个布尔」变为这份白名单，单模型时写出的内容见 model-proxy「托管 models.yml」（与改前只差 `maxTokens` 一行；`MODEL_VISION` 为 `on` 时另有 `input` 三行）；`MODEL_VISION` SHALL 只接受 exact `on` 或 `off`（缺省 `on`；empty、大小写不同及其它任何值均为启动失败，与 `MODEL_CATALOG` 同设亦启动失败），经同一 resolver 解析为单模型项的 `vision`（model-selection「模型白名单配置」，#912）；`BROWSER_BIN` 缺省未配置（部署没有浏览器），显式给出时 SHALL 按 browser-runtime「浏览器可执行文件配置」校验（绝对路径、可执行普通文件），经同一 resolver 解析为 omp 浏览器的可执行文件；白名单同时是模型代理放行的 `model` 取值集合（model-proxy「透传端点与 bearer 鉴权」）；`UPLOAD_MAX_BYTES` 与 `UPLOAD_MAX_FILES` SHALL 遵守与 `OMP_IDLE_MS` 相同的解析纪律（canonical ASCII decimal 正整数 1..2147483647，缺省分别为 `524288000` 即 500 MiB 与 `10`，empty/`0`/非 canonical/超限均为启动失败），经同一 resolver 解析为单个上传文件的字节上限（workspaces「文件上传」）与每条消息可带的附件总数上限（message-attachments「prompt 携带附件」「输入框附件标签」）；非法值的配置错误SHALL命名该键而不含输入值。`MODEL_UPSTREAM_BASE_URL`/`MODEL_UPSTREAM_API_KEY`缺省合法，显式empty非法；`MODEL_UPSTREAM_API_KEY` 显式给出时还 SHALL 是代理所发 `authorization` 头的合法取值——以 Node 的 `http.validateHeaderValue("authorization", "Bearer " + 取值)` 判定，抛错即启动失败（不另写字符集；配置错误 SHALL 命名该键而不含输入值，#909）；未同时配置时代理仍先鉴权（无效bearer401，通过鉴权后502），不得阻止服务启动。OMP_USER及仅sudo模式的安全PATH前置条件 SHALL遵守主omp-uid-isolation规范，不在本切片重定义。全部config SHALL在任何filesystem/database/listen effect前验证。

change s1f-files-page 在上述键之外增加十二个预览与文件键，经同一 pure config seam 解析、同样在任何 filesystem/database/listen effect 前校验，非法值的配置错误 SHALL 命名该键而不含输入值：`PREVIEW_PORT`（canonical ASCII decimal `0..65535`，缺省 `0` 即由系统分配端口；除允许 `0` 之外与 `PORT` 同一解析纪律）；`PREVIEW_ORIGIN`（可选；给出时 SHALL 整体匹配 `^https?://[^/?#\s]+$`——只有协议与 authority，无路径、无结尾斜杠——否则启动失败；显式 empty 非法）；`PREVIEW_CACHE_DIR`（缺省 repo-root `var/preview-cache`，relative 相对 repo root，显式 empty 非法）；`OFFICE_SPOOL_DIR`（可选；给出时 SHALL 为绝对路径，否则启动失败；显式 empty 非法；未配置即办公文档转换关闭；配置解析时不检查该目录是否存在、不创建它——它是部署方建好的、与转换 sidecar 共享的 spool 卷，存在性、属主与 mode 由启动预检判定，见 office-preview「转换 sidecar 的健康与 fail-closed」。change office-convert-sandbox 以它 1:1 替换了原来的 `OFFICE_BIN`：`OFFICE_BIN` 仍被设置时 SHALL 启动失败：stderr 与其它非法配置相同，恰为上文的 generic failure record、`reason` 为 `config`，SHALL NOT 点名该键、不新增 `reason` 取值；`resolveServerConfig` 抛出的 message 为 `OFFICE_BIN is retired; configure OFFICE_SPOOL_DIR`，命名该键而不含输入值）；`OFFICE_CONVERT_TIMEOUT_MS`（缺省 `60000`）、`OFFICE_CONVERT_CONCURRENCY`（缺省 `2`）、`PREVIEW_TEXT_MAX_BYTES`（缺省 `1048576`）、`PREVIEW_IMAGE_MAX_BYTES`（缺省 `20971520`）、`PREVIEW_DOCUMENT_MAX_BYTES`（缺省 `104857600`）、`PREVIEW_NOTEBOOK_MAX_BYTES`（缺省 `10485760`）、`PREVIEW_ARCHIVE_MAX_ENTRIES`（缺省 `1000`）、`TRASH_RETENTION_DAYS`（缺省 `30`）八项 SHALL 遵守与 `OMP_IDLE_MS` 相同的解析纪律（canonical ASCII decimal 正整数 1..2147483647，empty/`0`/非 canonical/超限均为启动失败）；其中 `PREVIEW_ARCHIVE_MAX_ENTRIES` 的上界是 `10000` 而不是 `2147483647`——`10001` 及以上同为启动失败，错误同样只命名该键、不含输入值。这些键的消费方见 preview-origin、office-preview、file-operations 与 workspaces。

对于non-`:memory:` DB path，入口SHALL recursive创建且只创建missing `dirname(DB_PATH)`，随后依主omp-uid-isolation「自有状态不对组可读」在openDb前准备exact主文件与既有sidecars为0600，再由唯一`openDb`打开exact file；不得创建`STATIC_ROOT`；监听成功后经`ensureOmpStateLayout`建立omp-runtime「OMP_STATE_DIR 托管布局」的目录、经 sandbox-core「沙箱根目录」的 `ensureSandboxRoot` 建立并校正 `SANDBOX_ROOT` 自身（change sandbox-boundary-closure，owner B2/B3/B4），并写托管models.yml与omp-runtime「宿主 overlay」的`host-overlay.yml`（布局建立失败、沙箱根阶段抛出——两种模式下的抛出条件见下文「沙箱根阶段」——与两个文件任一写入失败走同一partial-start failure cleanup）；账号根、工作空间根与`sessions/<ownerId>`仍由首次spawn或workspace创建按需创建，OMP_BIN目录不由启动创建。Exact `:memory:` SHALL保留SQLite特殊identity且不得mkdir。DB parent为existing non-directory、不可创建/写入或DB/migration不合法 SHALL走同一partial-start failure cleanup，不得fallback到默认路径。

`npm run start --workspace server` SHALL在clean checkout先以现有TypeScript compiler构建production-only JS并把tracked `migrations/`完整递归tree逐文件逐字节带入与compiled module相同的runtime位置，再执行compiled唯一入口；`make dev` SHALL只转发到该command，不得形成第二套启动逻辑。成功顺序 SHALL为validated config → DB-parent prepare → private-file preparation → DB open/migrate → 办公文档 sidecar 预检（仅在配置了 `OFFICE_SPOOL_DIR` 时运行；它不是启动阶段、永不使启动失败：预检失败只使办公文档转换器以不可用的形态装配，并在 application stderr 经同一受管 writer 恰写一行 LF-terminated exact JSON `{"event":"office_convert_sidecar_unavailable"}`——只有 `event` 一个键，无原因 / 路径 / 配置值，写失败 SHALL 吞掉；该行位于 `server_started` 之前；预检的内容、5 s 等待与失败后果归 office-preview「转换 sidecar 的健康与 fail-closed」）→ createApp（auth → http guard → model-proxy → sessions → workspaces → accounts，sessions先对账后开放路由；workspace store/facade/audit绑定同一DB与runtime.sandboxRoot）→ listen → 建立托管布局（`ensureOmpStateLayout`；主监听器绑定成功到布局建完之间 SHALL NOT 有 `await` 或其它让出事件循环的步骤，使主监听器受理的第一个请求到达时布局已在——owner 2026-10-13 裁决，#1337）→ 建立并校正沙箱根（`ensureSandboxRoot`，见下文「沙箱根阶段」；同一无 `await` 约束延伸到它返回为止，使主监听器受理的第一个请求处理时沙箱根已在——change sandbox-boundary-closure，owner B4）→ 预览监听器 listen（`PREVIEW_PORT`，与主监听器同一 `HOST`，后于主监听器，见「预览监听器的装配与关停」）→ 以实际绑定地址推导可连接proxyBaseUrl并写`<OMP_STATE_DIR>/home/.omp/agent/models.yml` → 建立预览缓存目录并启动回收目录与转换缓存的周期清理（「预览监听器的装配与关停」）→ application-owned stdout一行LF-terminated exact JSON `{"event":"server_started","host":"<actual>","port":<integer>,"modules":["core/db","auth","http","model-proxy","sessions","workspaces","accounts"]}`，不得有extra key或在listen前/应用stderr出现。Package-manager command banner不属于application record。

Runtime config/DB/app/listen/托管布局/沙箱根/预览监听器 listen/models.yml/预览缓存目录/success-record任一步失败 SHALL不输出success record，以nonzero退出，并在stderr sink可写时由application-owned stderr输出一行LF-terminated exact generic JSON `{"event":"server_start_failed","reason":"<stage>"}`（恰这两个键，无其它key/原始error/路径/config；`reason` 是封闭枚举里的一个源码字面量，只取决于失败发生在哪个启动阶段、不取自error对象：`config`（解析配置）、`db`（建DB父目录、收紧DB文件权限、打开并迁移DB）、`app`（装配应用）、`listen`（监听）、`state_layout`（建托管布局）、`sandbox_root`（建沙箱根并校正其权限位，见上文「沙箱根阶段」）、`models_yml`（写托管models.yml）、`host_overlay`（写宿主overlay）、`publish`（其余：核对bound address与写success record）；本change新增的两步各有自己的取值：`preview_cache`（建预览缓存目录）、`preview_listen`（预览监听器listen）；#1203）；若stderr sink自身不可写，该行物理不可达，系统仍SHALL nonzero、释放资源且不得产生unhandled stream stack。Node `node:sqlite` ExperimentalWarning MAY作为平台warning另出stderr。任意success/failure stream均不得dump environment或包含cookie/password/session值、MODEL_UPSTREAM_API_KEY值或会话bearer。Application stdout/stderr record SHALL经受管writer处理sync throw、write callback与stream error，settle exact一次且不得泄漏raw EPIPE。受管writer SHALL 在每个 stream 上至多挂一个 `error` 监听、由该 stream 的全部在途记录共用（一次 stream `error` 事件使当时全部在途记录各自以该 error settle 一次）：在途记录数不设上限，同一 tick 内写任意多条都 SHALL NOT 使 Node 向 stderr 打印 `MaxListenersExceededWarning`（那是一行非 JSON 输出）；SHALL NOT 以 `setMaxListeners`/`defaultMaxListeners` 调高上限来达成。最后一条在途记录 settle 之后经过一轮 `setImmediate` 该监听才摘除（write callback 之后、`setImmediate` 之前到达的 EPIPE `error` 事件仍被消费，不成为未处理异常）；其间有新记录进入则继续沿用同一个监听。监听成功后，生产入口 SHALL 把 sessions 模块的 `log` 端口接到同一受管 writer：每条握手超时记录（见 omp-runtime「握手超时可观测」）在 application stderr 恰写一行 LF-terminated exact JSON `{"event":"omp_handshake_timeout","sessionId":"<id>","reason":"handshake timeout","elapsedMs":<integer>}`，无 extra key、无原始 error/路径/凭据；会话 id 是已出现在 API URL 中的公开标识，不属于上文禁止的 session 凭据值；写失败 SHALL 吞掉，不影响请求结果与进程退出码。同一 `log` 端口 SHALL 以同样的写法承接 upstream-failure「上游失败日志」的记录：每条恰写一行 LF-terminated exact JSON `{"event":"upstream_failed","sessionId":"<id>","reason":"<reason>","status":<integer|null>}`，无 extra key、无上游正文/路径/凭据（#909）。生产入口 SHALL 同样提供 sessions 模块的 `onError`：supervisor 每通知一次保留的基础设施故障，在 application stderr 经同一受管 writer 恰写一行 LF-terminated exact JSON `{"event":"session_fault"}`，无 extra key、无原始 error message/stack/路径/凭据；该 sink SHALL 同步返回 `undefined`（不返回 thenable），写失败 SHALL 吞掉——不产生未处理 rejection、不再次触发 `onError`、不影响请求结果与进程退出码。同一个 `onError` 也接收会话删除清理会话文件失败时的报告（session-metadata「会话删除」的错误通道），这类报告同样写一行 `session_fault`，但不进入 supervisor 的保留故障、不在关停时暴露——该记录的行数因此不等于关停时暴露的故障数。关停时暴露保留故障的既有行为不变。

失败清理 SHALL关闭当前入口已拥有的app、预览监听器与DB；每个entry SHALL把AbortSignal传给Fastify listen（两个监听器各自的在途绑定各用一个，见「预览监听器的装配与关停」），SIGINT/SIGTERM只对pending bind执行abort；已绑定时SHALL经共享幂等shutdown先完成所有runtime原生退出及store回收，再停止主listener，最后关闭唯一DB handle（预览监听器在这一串之前关闭，次序见「预览监听器的装配与关停」）。不得让同一AbortSignal的Node原生close绕过runtime先行归属；重复/混合signal不得在清理期间重新abort已绑定listener。干净取消正常退出；已确定真实失败保持nonzero，不得被signal抹去failure record或降为0。Signal落在listen invoke与实际bind之间时不得后到绑定、不得输出success/failure record，port/DB须可由successor立即复用。Signal 落在办公文档 sidecar 预检的有界等待期间（change office-convert-sandbox；此时入口只拥有 DB）时，等待不被中断，等待结束后入口 SHALL 先核对信号再做任何后续步骤：已收到 → 释放已拥有的 DB、以 0 退出，不输出 success / failure record，也不输出 `office_convert_sidecar_unavailable` 行；主 listen 之后无 `await` 的不变量不因预检改变（预检在 createApp 之前）。`.gitignore` SHALL排除default `var/` runtime output，knip SHALL把`src/server.ts`识别为entry。

**沙箱根阶段（change sandbox-boundary-closure，owner B2/B3/B4）。** 在上文成功顺序里「建立并校正沙箱根」那一步，入口 SHALL 同步调用 sandbox-core「沙箱根目录」的 `ensureSandboxRoot(SANDBOX_ROOT, {strict: OMP_USER 已配置})`。它抛出时该步的 `reason` 为 `sandbox_root`，失败行同上不带路径与原始错误；`OMP_USER` 未配置且它返回 `outcome: "unchanged"`（失败原因见 sandbox-core「沙箱根目录」第 4 步）时，入口 SHALL 经同一受管 stderr writer 恰写一行 LF-terminated exact JSON `{"event":"sandbox_root_unchanged"}`（只有 `event` 一个键，无路径、无 errno、无 mode），启动继续、不改变退出码、不再纠正（已落下的权限位不回滚，见 sandbox-core「沙箱根目录」），该行写失败按 `session_fault` 的规则吞掉。配置阶段失败时 SHALL 仍不创建沙箱根；`db`、`app`、`listen`、`state_layout` 任一失败时同样不创建它。惰性创建点（Shared agent module assembly 的 `ensureSharedDir`、工作空间 store、spawn 前的账号根）不因此改变，仍只对新建的分量施加 `2770`，启动之后它们再也建不到根这一级。

#### Scenario: 干净启动与一致命令面
- **WHEN** 从repo root执行`make dev`或`npm run start --workspace server`，或build后从foreign cwd直接执行absolute `dist/server.js`，且未设置三十七项应用配置
- **THEN** 三种启动形状消费同一entry/config identity，监听`127.0.0.1:3000`，supervisor 的活进程上限为 16、并发 spawn 上限为 `os.availableParallelism()`，托管models.yml恰一个模型条目并按 `MODEL_REASONING=on` 声明 reasoning；审批档位上界为 `yolo`、上传上限为 524288000 字节与 10 个；只在repo-root recursive创建`var/`并使`var/dev.db`完成tracked migrations；创建`var/omp-state/home/.omp/agent/models.yml`且baseUrl为实际端口的可连接回环地址；建出 repo-root `var/sandbox` 为 `0o3770` 且其下无条目（change sandbox-boundary-closure，owner B4）；不创建missing `web/dist`/bin；`GET /api/healthz`返回exact200；application stdout只在listen成功后出现上述exact startup record；SIGTERM后端口与DB均可立即由后继进程重用

#### Scenario: override、非法配置与部分启动失败
- **WHEN** 以可用custom host/port、absolute或relative DB/static/omp/state/sandbox路径、`OMP_MAX_PROCESSES`、`OMP_SPAWN_CONCURRENCY`、`MODEL_REASONING=off` 及模型配置启动
- **THEN** override逐项原样生效（含两个上限值；`MODEL_REASONING=off` 时models.yml模型条目不含 reasoning 声明），relative path仍绑定repo root；只创建non-memory DB的exact parent、OMP_STATE_DIR托管布局与 override 的 `SANDBOX_ROOT`（建为 `0o3770`、其下无条目）、绝不创建STATIC_ROOT或误建default DB；HOST=0.0.0.0时models.yml的baseUrl为http://127.0.0.1:<实际端口>/v1，IPv6通配绑定使用http://[::1]:<实际端口>/v1；build output中的完整migration tree与tracked source inventory/bytes一致，health/info/auth/static合同保持
- **WHEN** `PORT`为empty/whitespace/sign/fraction/exponent/zero/out-of-range，HOST为empty/whitespace-only，DB/static/omp/state/sandbox path为explicit empty，OMP_IDLE_MS为empty/0/abc/负数/小数/非canonical或大于2147483647的整数，OMP_MAX_PROCESSES为empty/0/abc/负数/小数/非canonical（如`016`、`+8`）或大于2147483647的整数，OMP_SPAWN_CONCURRENCY为同一组非法值，`SNAPSHOT_MAX_FILE_BYTES`/`SNAPSHOT_MAX_TOTAL_BYTES`/`SNAPSHOT_MAX_ENTRIES`为同一组非法值，`SNAPSHOT_EXCLUDE_NAMES`为`a/b`、`..`或含空名段（如`a,,b`），`MODEL_REASONING`为empty/`ON`/`true`/`yes`，`MODEL_ID`为empty、含换行（U+000A）、含 U+007F 或长 129 个 UTF-8 字节，上游变量为explicit empty，或import `server.ts`但不命中main guard
- **THEN** main-path非法config在任何filesystem/database/listen副作用前nonzero，application stderr恰一行上述generic failure record且无success；import-without-main保持silent且无filesystem/database/listen/signal副作用
- **WHEN** DB parent为file/不可创建、DB file创建/chmod失败、DB open/migration失败、HOST由listen拒绝、port已占用、models.yml不可写或post-listen stdout sink失败
- **THEN** 进程nonzero且stderr可写时只有generic failure record；stdout EPIPE不得输出raw stack；关闭所有已拥有的app/DB，不遗留可监听server、活跃omp原生子进程或active SQLite handle，parent/static/default路径无额外副作用；stderr同时不可写时允许无record但同样nonzero/cleanup
- **WHEN** SIGINT/SIGTERM 落在listen invoke后、实际bind前，或成功后重复/混合到达
- **THEN** pending bind由该次在途绑定所用的AbortSignal取消且无startup record，或已绑定listener幂等关闭；两种情况下均完成已拥有runtime原生退出后释放port、最后关DB；干净取消正常退出，successor可立即复用exact port/DB
- **WHEN** 配置了 `OFFICE_SPOOL_DIR`、spool 根合格但没有 `heartbeat`，SIGTERM 落在启动开始后约 1 s（预检等待期间）
- **THEN** 进程在 SIGTERM 后 5 s 内以 0 退出；stdout 与 stderr 没有任何 application record（无 success、无 failure、无 `office_convert_sidecar_unavailable`）；DB 已关闭，port 与 DB 可由 successor 立即复用

#### Scenario: 启动失败记录带失败阶段
- **WHEN** 编译入口分别遇到：非法config；DB父目录位置是一个文件；监听端口已被占用；托管布局里 `home/.omp` 被一个文件占位；`SANDBOX_ROOT` 的位置是一个普通文件；`host-overlay.yml` 的位置是一个目录；listen之后stdout sink写失败
- **THEN** 每次进程nonzero，application stderr恰一行，依次整行等于 `{"event":"server_start_failed","reason":"config"}`、`…"reason":"db"}`、`…"reason":"listen"}`、`…"reason":"state_layout"}`、`…"reason":"sandbox_root"}`、`…"reason":"host_overlay"}`、`…"reason":"publish"}`；该行的键集合恰为 `event` 与 `reason`；`sandbox_root` 一例的 stdout 与 stderr 都不含 `SANDBOX_ROOT` 的路径，占位的普通文件字节不变，托管布局已建出，主端口在进程退出后可重新绑定
- **WHEN** 托管布局校验失败，且状态目录的路径里含一个哨兵字符串、环境里的 `MODEL_UPSTREAM_API_KEY` 是另一个哨兵值
- **THEN** stdout与stderr的任何位置都不出现这两个哨兵（失败记录不带原始error文本、路径与配置值）

#### Scenario: 同 uid 模式下沙箱根的 chmod 被拒
- **WHEN** `OMP_USER` 未配置，`SANDBOX_ROOT` 已预先建出且为 `0o755`，对它真实路径（realpath）的 `chmodSync` 被钩子以 `EPERM` 拒绝
- **THEN** 启动成功、success record 照常写出，application stderr 恰多一行 `{"event":"sandbox_root_unchanged"}`（整行、只有 `event` 一个键），根的 mode 仍为 `0o755`、属主不变
- **WHEN** 同样的钩子下配置了 `OMP_USER`（setpriv 以同一钩子伪装存在）
- **THEN** 进程nonzero，stderr 恰一行 `{"event":"server_start_failed","reason":"sandbox_root"}`，不含根路径（根属别的 uid 的一支没有非特权的编译入口造法，由 sandbox-core「沙箱根目录」的「属主不符或 chmod 被拒」在单元层覆盖）

#### Scenario: Signal during managed model publication
- **WHEN** a clean signal arrives while the post-listen model write is pending
- **THEN** owned IO is settled without a startup/shutdown await cycle; no late success/failure record is emitted solely because of cancellation, no cleared app handle is dereferenced, and no resource is abandoned; a genuine writer failure remains a truthful nonzero generic failure

#### Scenario: Full proxy turn keeps both credentials out of output
- **WHEN** the actual production entry uses a unique64-character upstream key and fake-omp call-proxy reads the generated models.yml, authenticates with its actual runtime bearer, and completes a real local upstream streamed turn before SIGTERM
- **THEN** the persisted assistant content equals the upstream deltas and the turn is done; complete application stdout/stderr contains neither the upstream sentinel nor that bearer; models.yml contains only the WORKBUDDY_MODEL_TOKEN variable name, never either credential value

#### Scenario: 完整装配路由与惰性根
- **WHEN** actual compiled entry starts using configured SANDBOX_ROOT before any session spawn or workspace creation
- **THEN** startup reports the exact seven modules in actual registration order; authenticated GET /api/workspaces and GET /api/audit return200 with their real shapes/no-store, anonymous requests return401; SANDBOX_ROOT exists as a directory owned by the process uid with `mode & 0o7777 === 0o3770` and holds no entry, so SANDBOX_ROOT/u1 does not exist
- **WHEN** the same entry starts with SANDBOX_ROOT pre-created as `0o2770` (or `0o755`) and owned by the process uid
- **THEN** after the success record SANDBOX_ROOT is `0o3770`, its group is unchanged, and the process umask is unchanged

#### Scenario: HOST=localhost 单一 binding
- **WHEN** 以 HOST=localhost 启动编译入口
- **THEN** 服务只在 127.0.0.1:<port> 可连接、[::1]:<port> 连接失败，startup record 的 host 为 127.0.0.1，models.yml baseUrl 为 http://127.0.0.1:<port>/v1，主监听器与预览监听器都只绑定在 127.0.0.1（各自一个 binding，`[::1]` 上两个端口都连接失败），都受既有有界关停约束；大小写或写法不同的 `LOCALHOST` 等其它值仍原样交 listen

#### Scenario: 保留故障在运行期留下 generic 记录
- **WHEN** 以生产入口的 assembly（不另传 `onError`）装配，一次回合的持久化事务失败使 supervisor 保留一条基础设施故障
- **THEN** application stderr 恰多一行 `{"event":"session_fault"}`，其中没有原始错误消息、stack、路径或凭据；sink 的返回值不是 thenable；关停时该故障照常暴露
- **WHEN** 写该行时 stderr sink 不可用（写入被拒绝或同步抛出）
- **THEN** 没有未处理 rejection、`onError` 不被再次调用、supervisor 不因此多保留一条 sink 契约故障

#### Scenario: 同 tick 多条记录不触发监听上限警告
- **WHEN** 在同一 tick 内对真实 `process.stderr`（子进程里运行，stderr 为管道）调用受管 writer 16 次
- **THEN** 子进程 stderr 恰为 16 行对应的记录，不含 `MaxListenersExceededWarning`；全部 settle 并过一轮 `setImmediate` 后，该 stream 上由 writer 挂的 `error` 监听数为 0
- **WHEN** 一个 EventEmitter sink 上有三条在途记录
- **THEN** 该 sink 的 `error` 监听数恰为 1，`getMaxListeners()` 与写入前相同
- **WHEN** 此时发出一次 `error` 事件
- **THEN** 三条各自以该 error reject 恰一次；其后迟到的 write callback 不再改变结果；过一轮 `setImmediate` 后监听数为 0
- **WHEN** 一条记录的 write callback 成功之后、`setImmediate` 之前 sink 发出 `error`
- **THEN** 该记录保持 resolved，进程没有未处理的 `error` 事件

#### Scenario: 同一 stream 上监听的复用与重挂
- **WHEN** 记录 A settle 之后、其 `setImmediate` 触发之前写入记录 B，且该 `setImmediate` 触发时 B 仍在途
- **THEN** 监听没有被摘除（监听数仍为 1）；随后 sink 发出 `error` 时 B 以该 error reject，没有未处理的 `error` 事件
- **WHEN** 全部记录 settle、监听已摘除（监听数 0）之后再对同一 sink 写入记录 C，并在 C 在途时发出 `error`
- **THEN** 写入 C 时监听数回到 1，C 以该 error reject，没有未处理的 `error` 事件
- **WHEN** 两个不同的 sink 各有一条在途记录，其中一个发出 `error`
- **THEN** 只有该 sink 的记录 reject，另一个 sink 的记录按自己的 write callback settle

#### Scenario: 四个新配置键的取值与非法值
- **WHEN** 以 `APPROVAL_MAX_MODE=write`、`UPLOAD_MAX_BYTES=1048576`、`UPLOAD_MAX_FILES=3` 与一个合法的三模型 `MODEL_CATALOG` 启动编译入口
- **THEN** 启动成功；`GET /api/composer/options` 报告 `approvalModes` 为 `["always-ask","write"]`、`upload` 为 `{maxBytes:1048576, maxFiles:3}`、`models` 恰为那三项；托管 models.yml 含三个模型条目
- **WHEN** `APPROVAL_MAX_MODE` 为 empty、`YOLO`、` write`、`ask`；`UPLOAD_MAX_BYTES` 或 `UPLOAD_MAX_FILES` 为 empty、`0`、`abc`、`-1`、`1.5`、`010`、`2147483648`；`MODEL_CATALOG` 为 empty 或 `not json`
- **THEN** 每一种都在任何 filesystem/database/listen 副作用前 nonzero 退出，application stderr 恰一行 generic failure record 且无 success record；配置层的错误信息命名该键而不含输入值

#### Scenario: 预览与文件键的缺省与覆盖
- **WHEN** 未设置十二个预览与文件键启动编译入口；另一例以 `PREVIEW_PORT=<空闲端口>`、`PREVIEW_ORIGIN=https://preview.example.test`、relative `PREVIEW_CACHE_DIR`、绝对路径的 `OFFICE_SPOOL_DIR` 与八个数值键的非缺省值启动
- **THEN** 前者解析出的配置为 `previewPort 0`、无 `previewOrigin`、`previewCacheDir` 为 repo-root `var/preview-cache`、无 `officeSpoolDir`、八个数值依次为 `60000`、`2`、`1048576`、`20971520`、`104857600`、`10485760`、`1000`、`30`，预览监听器绑定在一个非 0 的端口上且与主监听器不同；后者逐项原样生效，relative 缓存目录绑定 repo root，预览监听器恰绑定在给定端口；两例的 `server_started` 记录都只有 `event`、`host`、`port`、`modules` 四个键，`port` 是主监听器的端口

#### Scenario: 预览与文件键的非法值
- **WHEN** `PREVIEW_PORT` 为 empty/`abc`/`-1`/`65536`/`01`/`1.5`；`PREVIEW_ORIGIN` 为 empty、`preview.example.test`（无协议）、`https://a.test/`（结尾斜杠）、`https://a.test/x`、`ftp://a.test`；`PREVIEW_CACHE_DIR` 为 empty；`OFFICE_SPOOL_DIR` 为 empty 或相对路径 `spool`；`OFFICE_BIN` 为任意值（含绝对路径 `/usr/bin/soffice`）；八个数值键之一为 empty/`0`/`abc`/`-1`/`1.5`/`016`/`2147483648`；`PREVIEW_ARCHIVE_MAX_ENTRIES` 另为 `10001`
- **THEN** 每一例都在任何 filesystem/database/listen 副作用之前以 nonzero 退出，application stderr 恰一行 generic failure record，无 success record；`resolveServerConfig` 抛出的错误 message 含该键名而不含输入值（message 只由键与规则决定、与输入无关；规则文本自带的数字如 `1..10000` 不算回显输入）；`OFFICE_BIN` 一例的 stderr 同样恰为 `{"event":"server_start_failed","reason":"config"}`、不含 `OFFICE_BIN` 字样，键名只在抛出的 message 里（owner 2026-10-17 B8 细节）

#### Scenario: MODEL_ID 的取值规则
- **WHEN** 未设 `MODEL_CATALOG`，分别以 `MODEL_ID` 为 ` custom-model `（首尾各一个空格）与一个恰 128 个 UTF-8 字节的值解析配置并启动
- **THEN** 两例都启动成功；白名单唯一一项的 `id` 与 `name` 逐字节等于所给的值（首尾空格仍在），`GET /api/composer/options` 的 `models[0].id` 与 `defaults.modelId` 同为该值
- **WHEN** `MODEL_ID` 分别为 empty、`a\nb`（含 U+000A）、含 U+007F 的值、长 129 个 UTF-8 字节的值；另一组在配置了合法 `MODEL_CATALOG` 时重复这四个取值
- **THEN** 每一例都在任何 filesystem/database/listen 副作用之前以 nonzero 退出，application stderr 恰一行 `{"event":"server_start_failed","reason":"config"}`，无 success record；`resolveServerConfig` 抛出的错误 message 含 `MODEL_ID` 而不含输入值

#### Scenario: 非法上游密钥拒绝启动
- **WHEN** 编译入口分别以含 U+000A、含非 Latin-1 字符（如 `密钥`）且各自带一个哨兵子串的 `MODEL_UPSTREAM_API_KEY` 启动（含 U+0000 的取值经不了进程环境——`spawn` 拒绝含 NUL 的环境变量——只在 `resolveServerConfig` 层验证；含 U+007F 的取值同样被拒，制表符照常可用）；另以 `abc def`（中间有空格）启动
- **THEN** 前两例都在任何 filesystem/database/listen 副作用之前以 nonzero 退出，application stderr 恰一行 `{"event":"server_start_failed","reason":"config"}`，stdout 与 stderr 都不含哨兵；`resolveServerConfig` 对同样的输入抛出的错误 message 含 `MODEL_UPSTREAM_API_KEY` 而不含哨兵；最后一例正常启动

#### Scenario: 上游失败记录
- **WHEN** 生产装配下一个会话的回合因上游 401 失败，另一个回合因 omp 进程异常退出失败
- **THEN** application stderr 恰多一行 `{"event":"upstream_failed","sessionId":"<该会话 id>","reason":"auth_failed","status":401}`；进程异常退出的回合不产生 `upstream_failed` 行；任何一行都不含配置的上游密钥
