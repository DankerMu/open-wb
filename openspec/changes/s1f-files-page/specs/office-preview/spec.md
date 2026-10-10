## ADDED Requirements

### Requirement: 转换器调用契约
`createOfficeConverter({officeBin, cacheDir, timeoutMs, concurrency, ompUser?})` SHALL 返回 `{available, convert(absInput, signal?) → Promise<absPdf>, close()}`。`officeBin` 未提供时 `available` 为 `false`，`convert` SHALL 以 `unavailable` 失败且不启动任何进程。每次真实转换 SHALL 使用一个新建的作业目录 `<cacheDir>/work/<随机名>`（`2770`），并以如下 argv 启动一个子进程（`shell:false`，工作目录为作业目录，标准输入输出与错误全部丢弃）：

`<officeBin> --headless --norestore --nolockcheck --nodefault --nofirststartwizard -env:UserInstallation=file://<作业目录>/profile --convert-to pdf --outdir <作业目录>/out <absInput>`

子进程环境 SHALL 精确为 `{PATH, LANG, HOME}`（`LANG` 缺席时不设；`HOME` 为作业目录），不继承 `process.env` 的任何其它键。`ompUser` 存在时 SHALL 在其前加前缀 `sudo -n -u <ompUser> --preserve-env=PATH,LANG,HOME -- /usr/bin/setpriv --pdeathsig KILL --`（与 omp-uid-isolation 的 spawn 前缀同形；`sudo` 进程自身的环境即上述集合），不存在时直接启动 `officeBin`；sudo 立即失败 SHALL 是转换失败，SHALL NOT 回退为同 uid 直接启动。

转换成功当且仅当子进程以退出码 0 结束，且 `<作业目录>/out/<输入文件名去掉最后一个扩展名>.pdf` 是大小大于 0 的普通文件（符号链接不算）。其余情况——启动失败、非 0 退出、被信号终止、没有输出、输出为空——SHALL 以 `failed` 失败。失败的错误对象 SHALL 只带上述种类，不带子进程输出、路径或环境。无论成败，`convert` 落定前 SHALL 对作业目录做一次递归删除；这一步是尽力而为，删除失败不改变结果。`OMP_USER` 模式下它对真实的 LibreOffice 删不全：LibreOffice 在作业目录下建的 `profile` 与 `.cache` 属该用户、只有该用户可进入（design D18「实测」），应用用户删不掉，所以该模式下 `work` 在一次运行期间可以只增不减，由启动时对 `work` 的清空（「转换缓存」）归零。

路径参数只接受绝对路径。构造时 `cacheDir` 不是绝对路径，或提供了 `officeBin` 而它不是绝对路径（裸名、`./` 开头的相对路径）→ `createOfficeConverter` SHALL 直接抛出，不返回转换器、不启动任何进程；抛出的是普通错误而不是上述带种类的失败，message 固定、不含传入的值；`officeBin` 未提供时 `cacheDir` 同样受此检查。`convert` 的 `absInput` 不是绝对路径（它是 argv 的最后一项，例如以 `-` 开头时会被转换器当成选项）→ SHALL 以 `failed` 失败，不启动进程、不建作业目录。`convert` 在建作业目录之前的检查次序 SHALL 为：`officeBin` 未提供 → `unavailable`；已 `close()` 或 `signal` 已中止 → `aborted`；`absInput` 不是绝对路径 → `failed`；`ompUser` 存在时随后才是对 `PATH` 与 `/usr/bin/setpriv` 的前置检查（不过同样是 `failed`，不启动、不回退）。

终止在途转换（超时、调用方的 `signal` 中止、`close()`）的做法按运行模式分两种，SHALL NOT 为此新增任何提权规则。`OMP_USER` 模式所需的 sudoers 规则共两行，都不用于终止：放行上述 spawn 前缀的 `<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> *`，与放行启动时清空 `work` 的 `<app-user> ALL=(<OMP_USER>) NOPASSWD: /usr/bin/find <PREVIEW_CACHE_DIR 的绝对路径>/work -mindepth 1 -delete`（参数逐项固定、没有通配；见「转换缓存」，owner D-24）；两行都只在同时配置了 `OFFICE_BIN` 的部署里用得到——占位符写法与 design D18 一致，`<OMP_USER>`、`<OFFICE_BIN>` 即部署时传给 `ompUser`、`officeBin` 的取值，`<PREVIEW_CACHE_DIR 的绝对路径>` 即传给 `cacheDir` 的取值——见 design D18 与 ADR-0010 增补；不存在放行 `kill` / `pkill` 的规则：

- **同 uid 模式**（未提供 `ompUser`）：子进程 SHALL 以新的进程组启动（`detached`），终止时向该进程组发 `SIGKILL`。可观察结果：`convert` 落定时被启动的进程及其全部后代都已不存在。
- **`OMP_USER` 模式**（提供了 `ompUser`）：应用用户无权向该用户的进程发信号，终止时 SHALL 向自己启动的 `sudo` 进程发 `SIGKILL`；`sudo` 的直接子进程由 `setpriv --pdeathsig KILL` 随之被内核杀掉。可观察结果：`convert` 落定时 `sudo` 进程已不存在。直接子进程的后代不随之结束：对真实的 LibreOffice，包装脚本再派生的 `soffice.bin` 每次都留下，并把整份转换跑完才自行退出（design D18「实测」：终止 5 次、5 次如此，最长在终止之后 128 秒，长于 60 秒的缺省超时）。这是与 ADR-0010 已登记的「omp 派生的工具子进程可能存活」同类的**已知残余**（owner D-21 维持：不为它新增 `kill` / `pkill` 规则），记入 ADR-0010 增补与运维文档，本契约不承诺它们不存在；残留进程不占用「并发上限与排队」的名额（名额在 `convert` 落定时释放），所以该模式下主机上实际同时运行的转换进程数可以超过 `concurrency`。

超时以 `timeout` 失败，中止以 `aborted` 失败。`close()` SHALL 按上述方式终止全部在途转换并等自己启动的那个进程（同 uid 模式为被启动的进程，`OMP_USER` 模式为 `sudo`）退出，此后的 `convert` 以 `aborted` 失败。

#### Scenario: argv、环境与成功判定
- **WHEN** 以指向记录型假 `soffice` 的 `officeBin` 转换 `<ws>/报告 v2.docx`，父进程环境里另有 `MODEL_UPSTREAM_API_KEY` 等键
- **THEN** 假进程记录到的 argv 自第二项起恰为契约所列（`--outdir` 与 `UserInstallation` 都在同一个新建的作业目录下，最后一项是输入的绝对路径），环境的键恰为 `PATH`、`HOME`（及父进程有 `LANG` 时的 `LANG`），`HOME` 等于作业目录；`convert` 落定为一个内容等于假进程所写 PDF 的文件路径；作业目录已不存在

#### Scenario: sudo 前缀
- **WHEN** 以 `ompUser: "omp"` 构造并转换，`sudo` 被替换为记录型假可执行文件
- **THEN** 启动的命令为 `sudo`，argv 恰以 `-n -u omp --preserve-env=PATH,LANG,HOME -- /usr/bin/setpriv --pdeathsig KILL -- <officeBin> --headless` 开头；未提供 `ompUser` 时启动的命令恰为 `officeBin`

#### Scenario: 各类失败
- **WHEN** 假 `soffice` 分别：以退出码 1 结束；以 0 结束但不写输出；以 0 结束并写出 0 字节的 PDF；把输出写成指向别处的符号链接；`officeBin` 指向不存在的文件
- **THEN** 五例都以 `failed` 失败，作业目录被删除，缓存目录里没有新增文件；错误对象的 message 不含输入路径与作业目录路径

#### Scenario: 超时与中止
- **WHEN** 同 uid 模式（不提供 `ompUser`）下，假 `soffice` 启动一个子进程后睡过 `timeoutMs`（设为 200 毫秒）；另一例在转换进行中中止调用方的 `signal`；另一例在转换进行中调用 `close()`
- **THEN** 三例分别以 `timeout`、`aborted`、`aborted` 失败；假进程及其子进程在有界时间内都已不存在；作业目录被删除；`close()` 之后的 `convert` 立即以 `aborted` 失败

#### Scenario: OMP_USER 模式下终止的是 sudo
- **WHEN** 以 `ompUser: "omp"` 构造，`sudo` 被替换为一个记录自己 pid、随后长时间睡眠的假可执行文件；转换超过 `timeoutMs`；另一例调用 `close()`
- **THEN** 两例分别以 `timeout`、`aborted` 失败；那个假 `sudo` 进程在有界时间内已不存在且是被 `SIGKILL` 结束的；转换器没有执行 `kill`、`pkill` 或第二次 `sudo`（记录型假 `sudo` 恰被启动一次）；该次调用占用的并发名额已释放（随后的一次转换立即启动）

#### Scenario: 输入不是绝对路径
- **WHEN** 分别以 `-env:UserInstallation=file:///x.docx`、`--accept=x.docx`、`ws/a.docx` 作为 `absInput` 调用 `convert`
- **THEN** 三例都以 `failed` 失败，没有子进程被启动，`work` 下没有新建目录；错误对象的 message 不含该输入与缓存目录路径

#### Scenario: 构造参数不是绝对路径
- **WHEN** 分别以 `cacheDir: "var/preview-cache"`（提供与不提供 `officeBin` 各一例）、`officeBin: "soffice"`、`officeBin: "./soffice"`（后两例的 `cacheDir` 是绝对路径）构造
- **THEN** 四例的 `createOfficeConverter` 都抛出 message 恰为 `cacheDir and officeBin must be absolute paths` 的普通错误（不含传入的值），没有子进程被启动

#### Scenario: 未配置
- **WHEN** 不提供 `officeBin` 构造并调用 `convert`
- **THEN** `available` 为 `false`，调用以 `unavailable` 失败，没有子进程被启动，`work` 下没有新建目录

### Requirement: 并发上限与排队
同一时刻运行中的转换子进程数 SHALL 不超过 `concurrency`（`OFFICE_CONVERT_CONCURRENCY`，缺省 2）；这里计的是由转换器启动、其 `convert` 尚未落定的转换，`OMP_USER` 模式下被终止的转换留下的后代进程不在此数之内（「转换器调用契约」的已知残余）。超出的调用 SHALL 排队，按到达次序在有空位时启动；排队中的调用数达到 8 时，新到的调用 SHALL 立即以 `busy` 失败、不入队。同一个缓存键（见「转换缓存」）的并发调用 SHALL 共用同一次转换与同一个结果，只占一个运行或排队位置。排队中的调用被其 `signal` 中止时 SHALL 出队并以 `aborted` 失败，不启动进程；共用同一次转换的多个调用里只有全部都中止时才杀掉该进程。

#### Scenario: 不超过上限并按序启动
- **WHEN** `concurrency` 为 2，假 `soffice` 在收到放行信号前不退出，对五个不同的输入同时调用 `convert`
- **THEN** 任一时刻运行中的假进程至多 2 个；放行一个之后恰有下一个启动；五个最终都成功，启动次序等于到达次序

#### Scenario: 队满
- **WHEN** `concurrency` 为 1，一个转换在运行、八个在排队时再调用第十个
- **THEN** 第十个立即以 `busy` 失败，没有为它启动进程或建作业目录；先前九个不受影响

#### Scenario: 同一输入只转一次
- **WHEN** 对同一个未缓存的输入同时调用 `convert` 三次
- **THEN** 假进程恰被启动一次，三次调用落定为同一个路径；其中一个调用中止时另外两个照常成功

### Requirement: 转换缓存
转换结果 SHALL 缓存在 `<cacheDir>/pdf/<key>.pdf`，`key` 为 `sha256(<absInput 的 UTF-8> 0x00 <mtimeMs 的十进制> 0x00 <size 的十进制>)` 的小写十六进制，`mtimeMs` 与 `size` 取自调用时对输入的 `lstat`。命中（该文件存在且为大小大于 0 的普通文件）时 SHALL 把它的修改时间更新为当前时刻并直接返回，不启动进程。未命中时在转换成功后 SHALL 把输出**复制**为一个由本进程创建的新文件（先写同目录的临时名，再改名为 `<key>.pdf`），SHALL NOT 把作业目录里的输出直接改名进缓存——缓存里的每个文件都由应用用户创建并持有。`<cacheDir>`、`work`、`pdf` 的 mode 分别为 `2750`、`2770`、`0700`（由 http-service-skeleton「预览监听器的装配与关停」在启动时建立）。失败的转换 SHALL NOT 写缓存。

周期清理 SHALL 在启动时与此后每 24 小时各运行一次：删除 `pdf` 下修改时间早于「当前时刻 − 7 天」的普通文件；`work` 下的全部条目在启动时删除。清理中的任何错误 SHALL 被吞掉，留待下一轮，不影响请求与退出码。缓存没有总量上限。

启动时对 `work` 的清空 SHALL 先于转换器受理第一次转换，并分两种情况（owner D-24）。`ompUser` 与 `officeBin` 没有同时提供时（同 uid 模式；或提供了 `ompUser` 而没有 `officeBin`——没有转换器，`work` 下不会有属该用户的东西）：由本进程递归删除 `work` 下的全部条目，SHALL NOT 启动 `sudo`。两者都提供时：SHALL 先启动恰一次子进程 `sudo -n -u <ompUser> -- /usr/bin/find <cacheDir 的绝对路径>/work -mindepth 1 -delete` 并等它结束（argv 逐项固定，其中的路径是 `join(cacheDir, "work")` 的结果；`shell:false`，不经 `setpriv`，工作目录为 `/`——GNU `find` 退出前要回到初始目录，omp 用户进不去服务端的工作目录时它会在删除完成后仍以非 0 退出；标准输入输出与错误全部丢弃，环境只有 `PATH` 与存在时的 `LANG`；启动之前对 `PATH` 做与 spawn 前缀相同的安全检查，检查不过即按该命令失败处理、不启动），再由本进程照前一种情况递归删除余下的条目——本进程自己的递归删除在每一种情况下都执行。该命令失败（前置检查不过、启动失败、非 0 退出、被信号终止）SHALL 在 application stderr 记恰一行 `{"event":"preview_work_clear_failed"}`（没有其它键，不含路径、用户名与子进程输出），SHALL NOT 使启动失败，本进程自己的删除照常进行。这条命令在一次进程生命周期里只在启动时执行一次：周期清理与单次转换之后都不执行它，单次转换后对作业目录的删除仍是「转换器调用契约」的尽力而为。

#### Scenario: 命中、失效与复制
- **WHEN** 转换 `a.docx` 两次；随后改写 `a.docx`（大小或修改时间变化）再转换一次
- **THEN** 假进程恰被启动两次（第一次与改写后）；第二次调用返回与第一次相同的路径且该文件的修改时间被更新；第三次返回不同的路径；缓存里的文件属于本进程的 uid、不是作业目录里那个 inode（改写作业目录里的输出不影响缓存内容，且作业目录本就已删除）

#### Scenario: 失败不入缓存
- **WHEN** 一次转换以 `failed`、`timeout` 或 `aborted` 结束后，以正常的假 `soffice` 对同一输入再转换
- **THEN** `pdf` 下在失败之后没有该 `key` 的文件；再次转换启动了进程并成功

#### Scenario: 周期清理
- **WHEN** `pdf` 下有修改时间为 8 天前与 6 天前的两个文件，`work` 下有一个遗留的作业目录，运行一次启动时清理
- **THEN** 8 天前的文件被删除，6 天前的保留，`work` 为空；把 `pdf` 目录换成不可读之后再运行一次清理，没有抛出错误

#### Scenario: OMP_USER 模式下启动时清空 work
- **WHEN** `work` 下有一个遗留的作业目录，`sudo` 被替换为记录型假可执行文件，以 `ompUser: "omp"` 与一个 `officeBin` 运行一次启动时清理；另一例假 `sudo` 以退出码 1 结束；另一例不提供 `ompUser`；另一例提供 `ompUser: "omp"` 而不提供 `officeBin`
- **THEN** 第一例假 `sudo` 恰被启动一次，argv 恰为 `-n -u omp -- /usr/bin/find <cacheDir>/work -mindepth 1 -delete`，其环境的键只有 `PATH`（及父进程有 `LANG` 时的 `LANG`），它结束之后本进程才开始自己的删除，清理结束时 `work` 为空；第二例 application stderr 恰多一行 `{"event":"preview_work_clear_failed"}`，清理没有抛出，`work` 下本进程可删的条目照常被删除；第三例与第四例都没有启动 `sudo`，`work` 为空，stderr 没有新增行

### Requirement: 办公文档预览路由
预览监听器的 `GET /o/<token>/<path>` SHALL 以与 preview-origin「预览监听器」`/w/` 相同的次序校验令牌、空间根与路径（`resolve(op=read)`，越界 403 + 审计，不存在或非普通文件 404），随后：扩展名（小写）不是 `docx`、`xlsx`、`pptx` → 415；文件大小超过 `PREVIEW_DOCUMENT_MAX_BYTES` → 413（不启动转换）；转换器 `available` 为 `false` → 503；否则调用 `convert`，以请求连接的关闭作为其 `signal`。成功时 SHALL 以 `Content-Type: application/pdf`、preview-origin「预览响应头与内容类型」对 PDF 规定的头返回缓存文件的完整字节，并支持单段 `Range`。`PREVIEW_DOCUMENT_MAX_BYTES` 在服务端只由本路由执行：`/w/<token>/<path>` 对任何文件（含 `pdf`）都没有大小上限——它还要提供 HTML 页面引用的任意相对资源，持有令牌本就可以经它读到该空间的任何文件，按扩展名单独拦 `pdf` 不减少暴露面；PDF 的预览上限因此只是浏览器侧的呈现门槛，由页面按令牌响应的 `documentMaxBytes` 判定是否建 iframe（file-previewers「PDF 与办公文档」）。

失败 SHALL 为 `text/plain; charset=utf-8` 的固定文案，带 `nosniff`、`no-store`、`Referrer-Policy: no-referrer`：

| 情况 | 状态 | 正文 |
|---|---|---|
| 扩展名不是三种之一 | 415 | `该类型不支持转换` |
| 超过文档上限 | 413 | `文件超过预览上限，请下载后查看` |
| 转换器不可用（`unavailable`） | 503 | `服务器未启用文档转换，请下载后查看` |
| 排队已满（`busy`） | 503 | `文档转换繁忙，请稍后重试` |
| 转换失败（`failed`） | 502 | `文档转换失败，请下载后查看` |
| 超时（`timeout`） | 504 | `文档转换超时，请下载后查看` |

客户端在转换完成前断开时 SHALL 中止该次调用（`aborted`），不写任何响应。本路由 SHALL NOT 写审计（越界拒绝除外），SHALL NOT 在响应里出现输入路径、作业目录或子进程输出。主站的错误信封与 http-service-skeleton「统一错误信封」的 definition map 不因办公文档预览增加任何成员。

#### Scenario: 成功与缓存
- **WHEN** 注入一个记录调用的转换器替身，对 `/o/<T>/报告.docx` 请求两次，再带 `Range: bytes=0-9` 请求一次
- **THEN** 三次都得到 PDF：前两次 200、`Content-Type: application/pdf`、CSP 恰为 `frame-ancestors <E>`（不含 `sandbox`）、带 `nosniff`、`no-store`；第三次 206 且正文为前 10 字节；传给替身的输入是该文件在工作空间内的绝对路径

#### Scenario: 拒绝在转换之前
- **WHEN** 请求 `/o/<T>/readme.md`、`/o/<T>/doc.pdf`、超过文档上限的 `/o/<T>/huge.xlsx`、不存在的 `/o/<T>/gone.docx`、`/o/<T>/%2e%2e/x.docx`、未知令牌的 `/o/<x>/a.docx`；另以 `available:false` 的替身请求 `/o/<T>/a.docx`
- **THEN** 依次为 415、415、413、404、403（写一条 `sandbox.reject`）、404、503（`服务器未启用文档转换，请下载后查看`）；替身的 `convert` 一次都没有被调用

#### Scenario: 转换结果到状态码
- **WHEN** 替身的 `convert` 分别以 `failed`、`timeout`、`busy` 失败
- **THEN** 响应依次为 502 `文档转换失败，请下载后查看`、504 `文档转换超时，请下载后查看`、503 `文档转换繁忙，请稍后重试`，都是 `text/plain; charset=utf-8`，正文不含文件名与路径

#### Scenario: 客户端断开即中止
- **WHEN** 替身的 `convert` 挂起期间客户端关闭连接
- **THEN** 传给 `convert` 的 `signal` 被中止；服务端没有为该请求写出任何响应字节，也没有未处理的拒绝

### Requirement: 真实转换的人工验证
CI 与单元测试 SHALL NOT 依赖 LibreOffice：转换器的全部自动化测试以仓库内的假 `soffice` 可执行脚本与注入的转换器替身完成。真实转换 SHALL 作为一次人工验证在装有 LibreOffice 的 Linux 主机上进行，并把结果记入 ADR-0014：`docx`、`xlsx`、`pptx` 各一份经 `/o/` 得到可在浏览器内置查看器里翻页的 PDF；`OMP_USER` 模式下转换进程的 `Uid` 为该用户、缓存文件属应用用户；一次被超时终止的转换之后，主机上以该作业目录为参数的残留进程（「转换器调用契约」登记的已知残余；design D18「实测」里对直接执行的转换每次都出现）在经 `/o/` 的整条链路上是否同样出现——如实记录出现与否及进程名，不因此改变终止的做法。ADR-0014 的运维一节 SHALL 写明 `OMP_USER` 模式下怎样查到并结束被终止的转换留下的进程，以及 `work` 在一次运行期间会增长、重启时归零。

#### Scenario: 自动化测试不需要 LibreOffice
- **WHEN** 在没有安装 LibreOffice 的环境里运行 `make check`
- **THEN** 办公文档相关的全部测试通过；测试没有尝试执行名为 `soffice` 或 `libreoffice` 的系统命令

#### Scenario: 人工验证记录
- **WHEN** 评审本 change 的收尾 PR
- **THEN** ADR-0014 里有一节记录三种格式的真实转换结果、`OMP_USER` 模式下的进程 uid 与缓存文件属主、超时后残留进程是否出现（出现时的进程名），以及所用 LibreOffice 的版本；同样的结论写进 ADR-0010 增补；ADR-0014 的运维一节有查到并结束残留转换进程的步骤，ADR-0010 增补列出两行 sudoers 规则
