# Spec Delta

## ADDED Requirements

### Requirement: 浏览器可执行文件配置
服务端 SHALL 接受可选环境变量 `BROWSER_BIN`（owner 2026-10-18，#912 Q7）：它是 omp 浏览器工具使用的 Chromium/Chrome 可执行文件。由 `agent-config.ts` 的同一个 resolver 读取，校验 SHALL 先于任何文件系统写入、数据库或监听动作（http-service-skeleton「服务启动与装配」的配置键之一）：
- 未设置：部署没有浏览器。宿主 overlay 的浏览器块为 `enabled: false`（omp-runtime「宿主 overlay」），spawn 环境不含 `PUPPETEER_EXECUTABLE_PATH`（omp-runtime「子进程 spawn 契约」）。
- 已设置：取值 SHALL 是绝对路径，`stat`（跟随符号链接）为普通文件且当前进程对它有执行权限；空串、相对路径、不存在、目录、无执行权限都使启动失败，错误只点名 `BROWSER_BIN`、不回显取值，走既有配置错误路径（编译入口退出码 1、恰一条通用失败记录、无副作用）。合法时宿主 overlay 的浏览器块为 `enabled: true`，spawn 环境带 `PUPPETEER_EXECUTABLE_PATH=<该取值>`；直连与 `OMP_USER` sudo 两种 spawn 形态、会话进程、fork 临时进程与 regenerate 进程都如此（它们共用同一 spawn 契约；omp-uid-isolation「OMP_USER 配置与 sudo spawn 前缀」）。
宿主 SHALL NOT 自行在 `PATH` 或常见安装位置寻找浏览器，也 SHALL NOT 把父进程环境里的 `PUPPETEER_EXECUTABLE_PATH` 传给 omp。`OMP_USER` 部署里 omp 用户能否执行该文件由部署保证（`docs/architecture/system.md` 写明；参考镜像里是 `0755` 的系统文件），宿主启动校验只以应用用户身份检查。校验之后该文件被删除或替换不在宿主的检查范围内。

#### Scenario: 未设置 BROWSER_BIN
- **WHEN** 以未设置 `BROWSER_BIN`（父进程环境另有 `PUPPETEER_EXECUTABLE_PATH=/opt/x`）解析配置并对一个会话 spawn
- **THEN** 配置的 `browserBin` 缺席；overlay 浏览器块为 `enabled: false`；子进程 env 不含 `PUPPETEER_EXECUTABLE_PATH`

#### Scenario: 合法的 BROWSER_BIN
- **WHEN** `BROWSER_BIN` 为一个 mode `0755` 的普通文件的绝对路径；另一次为指向这样一个文件的符号链接
- **THEN** 两次都解析成功，overlay 浏览器块为 `enabled: true`，子进程 env 的 `PUPPETEER_EXECUTABLE_PATH` 恰为所给取值（符号链接不被解析成目标路径）

#### Scenario: 配置实际抵达每种 spawn
- **WHEN** 以 `BROWSER_BIN=<可执行文件>` 装配应用，经 supervisor / runtime 派发一个已认证会话的 prompt，并对同一会话 fork 一次、regenerate 一次（spawn 被捕获，不起真实 omp）；另一次不设 `BROWSER_BIN`
- **THEN** 前者三次 spawn 的 env 都恰含 `PUPPETEER_EXECUTABLE_PATH=<可执行文件>`；后者三次都不含该键

#### Scenario: 非法的 BROWSER_BIN 使启动失败
- **WHEN** `BROWSER_BIN` 分别为空串、`chromium`（相对）、不存在的绝对路径、一个目录、一个 mode `0644` 的普通文件
- **THEN** 每一个都在任何文件系统写入、数据库或监听动作之前启动失败，错误信息含 `BROWSER_BIN` 而不含所给取值；编译入口对其中两例退出码 1、应用 stdout 为空、stderr 恰一条通用失败记录、没有建出 DB 父目录、沙箱根、状态目录与 `models.yml`、没有监听

### Requirement: 浏览器操作的可读描述
服务端 SHALL 有一个无 IO 的纯函数模块（`server/src/sessions/omp/xd-browser.ts`），供 tool-approval「审批请求识别」、chat-stream「纯协议事件归约」与「浏览器调用审计」共用，三处 SHALL NOT 各自另写判定或解析：
- 设备路径判定：一个路径字符串指向浏览器设备，当且仅当它按 omp 执行路径的同一判定指向 `browser`（依赖 omp v18.0.10 的消费代码，升级 omp 时 SHALL 重新核对）：对原串做 omp 的方括号解包（`plan-mode-guard.ts` `unwrapHashlineHeaderPath`：去掉结尾 JS 空白后若形如 `[<内层>]`，且 `<内层>` 为非空的 `P` 或 `P#XXXX`（`XXXX` 恰四个十六进制字符、`P` 不含 `#`），取 `P`，否则取原串），结果匹配 `^[a-z][a-z0-9+.-]*://`（不分大小写，`internal-urls/router.ts:80`），以 WHATWG `new URL()` 解析成功（`internal-urls/parse.ts:59`），且其 `href` 以不分大小写的 `xd://` 开头、其后恰为 `browser`（`xd-protocol.ts:41`；URL 序列化会去掉首尾 C0 控制字符与空格、全部制表符与换行、空端口与空 userinfo，所以 `xd://browser:`、`xd://@browser` 也在内；`xd:` 是非特殊 scheme，主机名不转小写，设备名区分大小写）。判定 SHALL NOT 在解包前去掉首部空白或控制字符：omp 以未去空白的原串判 `canHandle`（`tools/write.ts:1141`），首部带空白或控制字符的路径被当作普通文件写入，判为浏览器会把这次文件写入登记成浏览器步骤、漏掉它的文件变更。
- 解析：参数文本经 `JSON.parse` 得到普通对象时成功；原文不成功、且文本不超过 16384 个 UTF-16 码元时，按 omp 写入前的 hashline 前缀剥离（`tools/write.ts:332-363` `stripWriteContent`，规则取自 `hashline/src/prefixes.ts` 的 `stripHashlinePrefixes`：每个非空内容行（长度不为 0 的行；只含空白的行也算内容行）都匹配行号前缀时，去掉 `[<路径>#XXXX]` 头行与 `read` 的元数据行、逐行去掉行号前缀；没有剥离时，首个非空行为松散头行 `[<路径>#<任意>]` 的，去掉该行后再按同一规则剥离）处理后再解析一次，仍不成功即失败（超过 16384 个码元不做剥离：剥离的逐行正则与重复去前缀在超长输入上是平方级，而宿主进程为所有会话共用；行号前缀正则可改写成匹配集合与匹配终点都相同的线性写法）。宿主不知道 omp 是否处在 hashline 模式，所以两次取先成功者；合法 JSON 对象的首个非空行以 `{` 起头、不会被剥离，原文能解析时两者一致。只读自有属性：`action`、`name`、`url`、`code` 取非空字符串，`all`、`kill` 取布尔，`app` 取普通对象，其中 `path`、`cdp_url` 取非空字符串、`relay` 取布尔、`args` 取全部元素为字符串的非空数组；不符的不取。
- 规范与无法确认：解析得到的对象恰为 omp v18.0.10 浏览器工具参数 schema 的形态（`tools/browser.ts:48-74`）时称为规范——自有键都在 `action`、`name`、`url`、`app`、`viewport`、`wait_until`、`dialogs`、`code`、`timeout`、`all`、`kill`、`i` 之中；`action` 必须出现且恰为 `open`、`close`、`run` 之一，`wait_until` 恰为 `load`、`domcontentloaded`、`networkidle0`、`networkidle2` 之一，`dialogs` 恰为 `accept`、`dismiss` 之一；`name`、`url`、`code` 为字符串，`timeout` 为数，`all`、`kill` 为布尔，`viewport` 为普通对象、自有键都在 `width`、`height`、`scale` 之中且 `width`、`height` 必须出现，三者都为数；`i` 不限（omp 在校验前删掉它）；`app` 出现时为普通对象，其自有键都在 `path`、`cdp_url`、`relay`、`args`、`target` 之中，`path`、`cdp_url`、`target` 为字符串，`relay` 为布尔，`args` 为全部元素为字符串的数组。omp 执行的不是 `JSON.parse` 的结果，而是经 `validateToolArguments`（`ai/src/utils/validation.ts:1930`；`tools/xdev.ts:427,457`）修复后的参数：解开多套一层引号的键、把扁平路径键拼回对象、把 JSON 字符串解析成对象、把 `"yes"`/`"true"`/`1` 等转成布尔、把数转成字符串——不规范的参数可能在 omp 里成为带 `app.path`、`app.cdp_url` 或 `app.relay` 的调用。这些修复只在首轮校验失败后运行（`validation.ts:2019-2042`；夹带 `</arg_key>` 的字符串被拆成兄弟键也在其中），首轮之前的无条件规整（解开多套引号的键、拼回扁平键、去掉可选字段上的 `null` 与 `"null"` 字符串、枚举值去首尾空白、标识符取值去结尾的 CR/LF）对规范的参数至多删去取值为 `"null"` 的可选字段、去掉 `path`、`url` 结尾的 CR/LF，不会新增字段或改动 `action`——规范的参数在首轮校验中或通过、omp 执行的字段是宿主读到的子集，或被整体拒绝（取值为非有限数时，如 `1e999` 解析成的 `Infinity`：omp 的 `number` 要求有限数，且没有修复能改它），两种情形都不会出现宿主没看到的 `app` 字段。宿主不照搬这些修复，而是把下列两种情形判为**无法确认**（失败即关闭，多判只多一行警示与一个审计标记）：解析成功但不规范；解析失败且文本超过 16384 个码元（未做剥离）。依赖 omp v18.0.10 的 schema 与修复逻辑，升级 omp 时 SHALL 重新核对。
- 摘要行（恰一行）：`action` 为 `open` 时，有 `url` 为 `浏览器：打开 <url>`，否则为 `浏览器：打开标签页 <name>`；`run` 为 `浏览器：在标签页 <name> 执行脚本`；`close` 时 `all` 为真为 `浏览器：关闭全部标签页`，否则为 `浏览器：关闭标签页 <name>`，两者在 `kill` 为真时都再接 `并结束外部浏览器`；其它 `action` 为 `浏览器：<action>`。`<name>` 缺席时为 `main`（omp 的缺省标签页名）。解析失败或 `action` 缺席时摘要行为 `浏览器操作`。
- 标志行（零到四行，按此次序，有才写）：`app.path` 存在为 `⚠ 启动外部程序：<path>`，`app.args` 存在时其后再接一个空格与 `参数 <args 的紧凑 JSON>`；`app.cdp_url` 存在为 `⚠ 连接外部浏览器：<cdp_url>`；`app.relay` 为真为 `⚠ 经中继连接用户自己的浏览器`；无法确认时最后为 `⚠ 参数写法不规范，无法确认是否启动外部程序或连接外部浏览器`。
- 审计字段：`{action, url, external}`——`action`、`url` 缺席（含解析失败）为 `null`；`external` 为 `{path, args, cdpUrl, relay, unverified}` 中出现的项组成的对象（`relay` 只在为真时出现，`unverified` 只在无法确认时出现、取 `true`），都没有为 `null`。
插入摘要行与标志行的字符串值（`args` 为其紧凑 JSON）SHALL 先把其中的 C0 控制字符（含 CR、LF）、U+007F–U+009F、U+2028、U+2029 与双向控制字符 U+202A–U+202E、U+2066–U+2069 各换成一个空格，再只保留前 200 个码点（超出时接 `…`），使每一行确实只占一行、显示不被控制字符伪装，且步骤 detail 的 4096 码点截断切不到标志行。

#### Scenario: 设备路径判定
- **WHEN** 判定 `xd://browser`、`XD://browser`、`[xd://browser]`、`[xd://browser#0a1B]`、`xd://browser `（尾部空格）、`xd://Browser`、`xd://browser2`、`[xd://browser#XYZ1]`、`notes/xd://browser`、`xd://browser/x`
- **THEN** 前五个为真，后五个为假
- **WHEN** 判定 `xd://bro\twser`、`xd://browser\n`、`[xd://brow\rser]`、`xd://browser\u0001`、`[xd://browser\u001f]`（`\t`、`\n`、`\r`、`\uXXXX` 为真实控制字符）
- **THEN** 五个都为真
- **WHEN** 判定 ` xd://browser`、`\txd://browser`、`\u0000xd://browser`、` [xd://browser]`、`xd://browser\u00a0`
- **THEN** 五个都为假（omp 把前四个当普通文件写入或拒绝，第五个报没有该设备）
- **WHEN** 判定 `xd://browser:`、`xd://@browser`、`xd://:@browser`、`[xd://browser:]`；另判 `xd://browser/`、`xd://browser:80`
- **THEN** 前四个为真（`new URL()` 的 `href` 为 `xd://browser`）；后两个为假（`href` 分别为 `xd://browser/` 与 `xd://browser:80`）

#### Scenario: 各类操作的摘要
- **WHEN** 依次描述 `{"action":"open","url":"https://example.com"}`、`{"action":"open","name":"b"}`、`{"action":"open","url":""}`、`{"action":"run","code":"1"}`、`{"action":"close","name":"b","kill":true}`、`{"action":"close","all":true}`、`{"action":"help"}`、`{"action":""}`、`[1]`、`not json`
- **THEN** 摘要行依次为 `浏览器：打开 https://example.com`、`浏览器：打开标签页 b`、`浏览器：打开标签页 main`、`浏览器：在标签页 main 执行脚本`、`浏览器：关闭标签页 b并结束外部浏览器`、`浏览器：关闭全部标签页`、`浏览器：help`、`浏览器操作`、`浏览器操作`、`浏览器操作`；第七、八例（`action` 不在 `open`/`close`/`run` 之中）各恰一行标志行 `⚠ 参数写法不规范，无法确认是否启动外部程序或连接外部浏览器`、审计 `external` 为 `{unverified:true}`，其余都没有标志行；第三例的审计字段为 `{action:"open",url:null,external:null}`，第八例为 `{action:null,url:null,external:{unverified:true}}`，最后两例为三个 `null`

#### Scenario: 带 hashline 行号前缀的参数
- **WHEN** 描述 `1:{"action":"open","url":"https://a","app":{"path":"/bin/sh"}}`；另一次为两行 `1:{"action":"run",` 与 `2:"code":"1"}`；另一次为三行 `[a.json#0A1B]`、`1:{"action":"open",`、`2:"url":"https://a"}`；另一次为三行 `[a.json#zz]`（不是四位十六进制的松散头行）、`1:{"action":"open",`、`2:"url":"https://a"}`；另一次为两行 `1:{"action":"open",` 与 `"url":"https://a"}`（第二行没有前缀）
- **THEN** 第一次摘要行为 `浏览器：打开 https://a`、恰一行标志行 `⚠ 启动外部程序：/bin/sh`，审计字段 `external` 为 `{path:"/bin/sh"}`；第二次摘要行为 `浏览器：在标签页 main 执行脚本`；第三次与第四次摘要行都为 `浏览器：打开 https://a`（第四次经松散头行回退：去掉头行后再剥离）；第五次不剥离、解析失败，摘要行为 `浏览器操作`

#### Scenario: 越界形态的标志行
- **WHEN** 描述 `{"action":"open","url":"https://a","app":{"path":"/bin/sh","args":["-c","id"],"cdp_url":"http://10.0.0.5:9222","relay":true}}`；另一次 `app` 为 `{"path":"","relay":"yes","args":[1]}`；另一次 `url` 含换行 `https://a\nb`
- **THEN** 第一次在摘要行后恰为三行 `⚠ 启动外部程序：/bin/sh 参数 ["-c","id"]`、`⚠ 连接外部浏览器：http://10.0.0.5:9222`、`⚠ 经中继连接用户自己的浏览器`，审计字段 `external` 为 `{path:"/bin/sh",args:["-c","id"],cdpUrl:"http://10.0.0.5:9222",relay:true}`；第二次（`relay` 不是布尔、`args` 含数）恰一行 `⚠ 参数写法不规范，无法确认是否启动外部程序或连接外部浏览器`、`external` 为 `{unverified:true}`；第三次摘要行为 `浏览器：打开 https://a b`
- **WHEN** 描述 `{"action":"open","url":"https://a/<5000 个 x>","app":{"path":"/bin/sh"}}`；另一次 `url` 为 `https://a\u202Eb`（含真实的 U+202E）
- **THEN** 第一次摘要行为 `浏览器：打开 ` 接 `https://a/<x…>` 的前 200 个码点再接 `…`，其后仍恰一行 `⚠ 启动外部程序：/bin/sh`，审计 `url` 为完整原值；第二次摘要行为 `浏览器：打开 https://a b`

#### Scenario: 不规范的参数无法确认
- **WHEN** 依次描述 `{"action":"open","url":"https://a","app":"{\"path\":\"/bin/sh\"}"}`（`app` 为 JSON 字符串）、`{"action":"open","url":"https://a","app":{"relay":"yes"}}`、`{"action":"open","url":"https://a","app":{"path":123}}`、`{"action":"open","url":"https://a","\"app\"":{"path":"/bin/sh"}}`（键多套一层引号）、`{"action":"open","url":"https://a","app.path":"/bin/sh"}`、`{"\"action\"":"open","app":{"path":"/bin/sh"}}`
- **THEN** 前五个摘要行为 `浏览器：打开 https://a`、第六个为 `浏览器操作`；六个的标志行最后都恰为一行 `⚠ 参数写法不规范，无法确认是否启动外部程序或连接外部浏览器`（第六个在它之前另有 `⚠ 启动外部程序：/bin/sh`）；审计 `external` 前五个为 `{unverified:true}`、第六个为 `{path:"/bin/sh",unverified:true}`
- **WHEN** 依次描述 `{"action":"open","url":"https://a","dialogs":"accept</arg_key><arg_key>app</arg_key><arg_value>{\"path\":\"/bin/sh\"}"}`（枚举字段夹带标签）、`{"url":"https://a</arg_key><arg_key>action</arg_key><arg_value>open"}`（缺 `action`）、`{"action":"run   ","code":"x"}`（枚举值带空白）、`{"action":"open","wait_until":"soon"}`、`{"action":"open","viewport":{"width":800}}`
- **THEN** 五个的标志行最后都恰为一行 `⚠ 参数写法不规范，无法确认是否启动外部程序或连接外部浏览器`，审计 `external` 都为 `{unverified:true}`；第二个摘要行为 `浏览器操作`
- **WHEN** 描述 `{"action":"open","url":"https://a","viewport":{"width":800,"height":600},"wait_until":"load","dialogs":"accept","timeout":5,"i":"x"}`；另描述 `{"action":"open"}`、换行、再接 20000 个空格与 `x` 的文本（原文不是 JSON、超过 16384 个码元）
- **THEN** 前者规范：恰为摘要行 `浏览器：打开 https://a`、没有标志行、`external` 为 `null`；后者在 1 秒内返回，摘要行为 `浏览器操作`、恰一行 `⚠ 参数写法不规范，无法确认是否启动外部程序或连接外部浏览器`、审计字段为 `{action:null, url:null, external:{unverified:true}}`

### Requirement: 浏览器调用审计
每个登记名为 `browser` 的工具步骤 SHALL 有一条审计：supervisor 落库该步骤 `step.start` 时（`server/src/sessions/turn-control.ts` 的 step.start 分支经 `store.startStep`），在插入步骤行的同一 SQLite 事务内经 audit-core 的 `emit` 写入 `kind="session.browser"`、`actorId` 为会话 `owner_id`、`title="浏览器操作"`、`detail={sessionId, messageId, action, url, external}`，其中 `action`、`url`、`external` 取归约器为该 step.start 给出的 `browser` 字段（chat-stream「纯协议事件归约」；由完整、未截断的参数算出，「浏览器操作的可读描述」的审计字段）。三个档位都写（`yolo` 档没有审批，这是唯一的痕迹）；审批照旧另写 `session.approval`。`detail` SHALL NOT 含 `code` 或其它参数原文。审计写入失败、或 store 未配置 `emit` 时，该步骤不落库、不发布（与审批结算缺 `emit` 时一样 fail closed），沿既有 owned error-sink 路径处理。

#### Scenario: 每次浏览器调用一条审计
- **WHEN** 档位 `yolo` 的绑定会话一个回合里有两个浏览器步骤（`open` 带 `url`；`run` 带长度超过 4096 码点的 `code` 与 `app.cdp_url`）和一个 bash 步骤
- **THEN** 审计恰多两条 `session.browser`，`actorId` 为会话所有者；第一条 `detail` 为 `{sessionId, messageId, action:"open", url:<url>, external:null}`，第二条为 `{…, action:"run", url:null, external:{cdpUrl:<cdp_url>}}`（不因 detail 截断而丢失），两条都不含 `code` 原文；bash 步骤没有 `session.browser`
- **WHEN** 同一档位的另一回合里一个浏览器步骤的 `content` 为 `{"action":"open","url":"https://a","app":"{\"path\":\"/bin/sh\"}"}`
- **THEN** 它的 `session.browser` 的 `detail.external` 为 `{unverified:true}`

#### Scenario: 审计失败时步骤不落库
- **WHEN** 浏览器步骤 `step.start` 的审计写入失败；另一次 store 未配置 `emit`
- **THEN** 两次该步骤行都不存在、`step.start` 不发布、ring 序号不推进，失败沿 owned error-sink 路径处理；非浏览器步骤在未配置 `emit` 时照常落库

### Requirement: 参考部署镜像
仓库 SHALL 在 `deploy/app/` 提供部署方自建、不发布的 app 参考镜像（owner 2026-10-18，#912 Q1/Q6/Q10）：
- `Dockerfile`：构建阶段以 `node:24.13.1-bookworm` 运行 `npm ci`、构建 web 与 server、经 `scripts/omp-fetch.sh` 取得官方 omp v18.0.10（SHA256 校验）；运行阶段以 `node:24.13.1-bookworm-slim` 为底，装 Debian 包 `chromium`、`fonts-noto-cjk`、`fonts-dejavu-core`、`sudo`、`ca-certificates`（`--no-install-recommends`），只拷入运行所需的编译产物、生产依赖与 omp 二进制。
- 身份（ADR-0010）：应用用户 `workbuddy` 与 omp 用户 `omp` 两个 uid，同属组 `workbuddy`；`/etc/sudoers.d/workbuddy-omp` 恰含 `workbuddy ALL=(omp) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <镜像内 OMP_BIN> *` 与 `Defaults>omp umask=0007` 两条规则，构建时经 `visudo -c` 校验；容器以 `workbuddy` 运行，入口脚本先 `umask 007` 再 `exec` 编译版服务。
- 镜像内固定 `OMP_USER=omp`、`OMP_BIN`、`BROWSER_BIN=/usr/bin/chromium`、`SANDBOX_ROOT`、`OMP_STATE_DIR`、`DB_PATH`、`STATIC_ROOT` 与 `PREVIEW_CACHE_DIR`（在 app 私有数据目录之下）——服务启动时创建或写入的每个路径 SHALL 落在三个可写挂载或 `/tmp` 之下，使只读根文件系统下启动成功；上游地址、密钥与认证配置 SHALL NOT 进入镜像，由部署方在运行时给出。
- `compose.yml`：根文件系统只读、`/tmp` 为 tmpfs、`shm_size` 不小于 `1g`、三个可写 bind mount（沙箱根、omp 状态目录、app 私有数据目录）、`cap_drop: [ALL]` 再只加回 sudo 降权实测所需的最小集合、不 `privileged`。可写范围即这三个挂载与 `/tmp`（owner Q5：写范围由挂载决定，omp 内不另限）。三个挂载点的宿主目录 SHALL 属应用用户：app 私有数据目录 `0700`（ADR-0010：app 自有状态不对 omp 用户开放）；沙箱根与 omp 状态目录属组 `workbuddy`，权限位由服务启动时按 sandbox-core「沙箱根目录」与 omp-runtime「OMP_STATE_DIR 托管布局」校正。`compose.yml` 的注释与 `docs/architecture/system.md` 写明这三项。
仓库 SHALL NOT 发布该镜像或引用镜像仓库。

#### Scenario: 镜像可构建且身份正确
- **WHEN** 在任一 Docker 主机上（CI 由「CI browser-image job」执行）`docker build -f deploy/app/Dockerfile .`，再在该镜像的容器内检查
- **THEN** 构建成功；以 compose 的安全标志（只读根、三个挂载、`/tmp` tmpfs）运行时服务启动成功、`GET /api/healthz` 为 200；`id -u workbuddy` 与 `id -u omp` 不同且两者都在组 `workbuddy`；`visudo -c` 通过且 `/etc/sudoers.d/workbuddy-omp` 恰为上述两条规则；`/usr/bin/chromium` 可执行；`/usr/share/fonts/opentype/noto/` 下有 Noto CJK 字体文件；`docker image inspect` 的环境变量与镜像文件系统里都没有 `MODEL_UPSTREAM_API_KEY` 的取值

### Requirement: CI browser-image job
`.github/workflows/ci.yml` SHALL 有 job `browser-image`（`runs-on: ubuntu-24.04`、`timeout-minutes: 20`）：checkout → setup-node（与其它 node job 相同 `with`）→ `npm ci` → `docker build -t workbuddy-app:ci -f deploy/app/Dockerfile .` → `bash .github/scripts/ci-browser-image.sh`。脚本 SHALL：
1. 对构建出的镜像执行「参考部署镜像」场景的全部容器内检查。
2. 建三个挂载目录，属主为容器内 `workbuddy` 的数值 uid:gid（`ensureOwnedDir` 要求目录属于服务进程的 uid；app 私有数据目录 `0700`，另两个的权限位交给服务启动校正），并准备一个只读挂载进容器、不在容器 `PATH` 上的浏览器包装脚本（每次被执行时在 `/tmp` 留一个标记文件，再 `exec /usr/bin/chromium "$@"`），以 `BROWSER_BIN=<包装脚本>` 覆盖镜像缺省值——Linux 上 omp 在没有 `PUPPETEER_EXECUTABLE_PATH` 时会在 `PATH` 上找到 `/usr/bin/chromium`，只有经包装脚本才能证明 `BROWSER_BIN` 真的抵达了 omp。
3. 以与 `deploy/app/compose.yml` 逐项相同的安全标志 `docker run` 该镜像（网络用 `--network host` 以访问回环上的假上游），`MODEL_CATALOG` 与 `MODEL_VISION` 不设（单模型、看图缺省 `on`）。
4. 运行驱动 `.github/scripts/ci-browser-e2e.mjs`：它以进程内 `start({toolRoundScope:"turn"})` 起受控假上游（omp-test-harness；同一会话的第二个回合需要按回合判定工具轮），对容器里的服务走一遍：登录 → 建工作空间并上传 `index.html` → 建绑定该空间、档位 `write` 的会话 → 发 `WORKBUDDY_BROWSER_OPEN:file://<空间根>/index.html` 并允许审批、等回合结束 → 在同一会话发 `WORKBUDDY_BROWSER_SHOT` 并允许审批、等回合结束（`run` 要求上一回合打开的标签页仍在同一 omp 进程里；两个回合之间不得触发进程退役）。
job SHALL 进入 `all-checks-passed.needs`；`scripts/test-ci-harness.sh` 与 `AGENTS.md` Enforcement Index 同步（verification-harness「CI 接线与控制面同步」；`constraints.yaml` 不需改，其 `ci.matrix` 已含 `ubuntu-24.04`）。任何断言失败、超时或容器异常退出时 job 非零，且日志不泄漏会话 token。

#### Scenario: 真实浏览器打开工作空间页面并截图
- **WHEN** PR CI 运行 `browser-image`
- **THEN** 镜像检查全部通过；两次审批的 `tool` 都为 `browser`，`title` 首行分别为 `浏览器：打开 file://<空间根>/index.html` 与 `浏览器：在标签页 main 执行脚本`；两个步骤名都为 `browser`、`status` 为 `done`，detail 首行同上；第二个步骤的 `changes` 恰一项，`path` 匹配 `^screenshots/screenshot-[^/]+\.png$`、`kind` 为 `write`，该文件在空间根下存在且以 PNG 签名开头；第二个回合里假上游收到的请求中至少一条的 `messages` 含 `image_url` 部分（截图送到了能看图的模型）；审计恰有两条 `session.browser`；容器 `/tmp` 下有包装脚本的标记文件；`<OMP_STATE_DIR>/xdg/cache/omp/puppeteer/chrome` 不存在（omp 每次无头启动都会建 `puppeteer/` 并写一个 `package.json`，下载的浏览器才在 `chrome/` 下），`<OMP_STATE_DIR>/xdg/state/omp/logs/` 下的日志不含 `Downloading Chromium for puppeteer`
- **WHEN** 该 job 失败、被取消或被跳过
- **THEN** `all-checks-passed` 非零
