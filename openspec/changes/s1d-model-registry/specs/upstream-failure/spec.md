# upstream-failure Spec Delta

> s1d-model-registry：密钥集的来源从环境变量的单一上游改为注册表此刻全部已登记上游（design D18），净化时现取。只改「上游原文净化」密钥集那一段的四句（来源、无上游时、现取、代理）并加一个场景，其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 上游原文净化
服务端 SHALL 只有一个净化函数，输入文本与一组密钥串，按以下次序处理：
1. CRLF、单独的 CR、U+2028、U+2029 归一为 LF；U+0000–U+0008、U+000B–U+001F 与 U+007F 被删除；
2. 以 `raw-http-request=` 或 `raw-http-request-save-failed=` 开头的行被整行删除；
3. 每个非空密钥串（先经第 1 步同样的归一）的每次逐字出现被替换为 `[已移除]`（不论长短，较长的串先替换）；
4. `Bearer` 后接空白再接一段非空白（不分大小写）被替换为 `Bearer [已移除]`；`sk-` 后接至少 16 个 `[A-Za-z0-9_-]` 的串被替换为 `[已移除]`；
5. 末尾空白被去掉；
6. 结果超过 2000 个码点时保留前 1994 个码点并接 `…（已截断）`，结果恒不超过 2000 个码点且不拆代理对。

控制字符在去密钥之前删除，使被控制字符劈开的密钥不能躲过替换后被拼回；去密钥在截断之前，使密钥不会因被截成半截而漏网。

**密钥集**由同一模块的一个纯函数导出，输入是注册表此刻全部已登记上游的 `{apiKey, baseUrl}` 列表（model-registry「注册表快照是白名单的唯一来源」的 `secrets()` 所据；change s1d-model-registry 起不再从环境变量读）与两组路径，SHALL 对每个已登记上游包含：其 apiKey；其 base URL 原串；其 userinfo 原串与其中的密码段（存在时）；其 pathname 整串（不为空、不为 `/` 时）以及其中长度不小于 8 的每个路径段；其查询串（去掉 `?`，非空时）；此外OMP 状态目录与沙箱根各四种写法——配置原值、`normalize()` 后的形式、去掉尾部 `/` 的形式（根目录 `/` 除外）、净化时现取的 `realpathSync.native`（取不到时略去）——去重后列入（#909 PR 4 / PR 5 实施补入）。没有任何已登记上游时只有两组路径。密钥集 SHALL 在每次净化时现取（注册表写入后的下一次净化即用新集合；sessions 的净化闭包不缓存上游）。模型代理对 ≥500 正文节选 SHALL 使用 `models.secrets()` 加本请求所用 route 自己的 apiKey 与 base URL 各部分（在途期间该模型被删或换密钥时旧值仍在集合里）；sessions 对每个 `detail`——含 `agent_failed` 的运行时文本（prompt 失败应答、进程异常退出等）——SHALL 使用完整的密钥集。sessions 模块 SHALL NOT 持有密钥值本身：装配方把绑定了密钥集的净化闭包交给它。展示 `detail` 的界面 SHALL 把它当纯文本。

#### Scenario: 去密钥与去路径
- **WHEN** 配置的密钥为 `k-123`，净化 `401 bad key k-123\nAuthorization: Bearer abc.def\nuse sk-AAAAAAAAAAAAAAAAAAAA\nraw-http-request=/srv/state/xdg/state/omp/logs/http-400-requests/1.json\r\nend\u0007`
- **THEN** 结果恰为 `401 bad key [已移除]\nAuthorization: Bearer [已移除]\nuse [已移除]\nend`

#### Scenario: 被控制字符劈开的密钥
- **WHEN** 配置的密钥为 `k-123`，净化 `x k-\u0000123 y\nraw-\u0000http-request=/srv/a.json`
- **THEN** 结果恰为 `x [已移除] y`

#### Scenario: 上游地址与服务器路径
- **WHEN** 配置的密钥为 `k-123`、base URL 为 `https://u:p4ss-secret@gw.example/tenant-0123456789/v1?org=acme-0001`，OMP 状态目录为 `/srv/wb/state`（realpath `/data/wb/state`），沙箱根为 `/srv/wb/sandbox`，净化 `GET https://u:p4ss-secret@gw.example/tenant-0123456789/v1?org=acme-0001 failed; POST /tenant-0123456789/v1/chat/completions; p4ss-secret; tenant-0123456789; org=acme-0001; /srv/wb/state/omp/a.json; /data/wb/state/b; /srv/wb/sandbox/ws/c.txt; gw.example v1`
- **THEN** 结果恰为 `GET [已移除] failed; POST [已移除]/chat/completions; [已移除]; [已移除]; [已移除]; [已移除]/omp/a.json; [已移除]/b; [已移除]/ws/c.txt; gw.example v1`（主机名与短于 8 个字符的路径段 `v1` 保留）
- **WHEN** 一个回合以 `runtime` 来源失败，运行时文本为 `spawn failed: /srv/wb/state/home/.omp/agent/models.yml unreadable`
- **THEN** 落库、发布与快照里的 `detail` 为 `spawn failed: [已移除]/home/.omp/agent/models.yml unreadable`

#### Scenario: 截断上限
- **WHEN** 净化一个 2000 码点的文本、一个 2001 码点的文本，以及一个第 1994、1995 个码点为同一个星位字符两半的文本
- **THEN** 第一个原样返回；第二个为前 1994 个码点加 `…（已截断）`、共 2000 个码点；第三个不出现孤立代理项

#### Scenario: 注册表登记的密钥不进会话
- **WHEN** 管理员经 `POST /api/models` 登记模型 `m2`，上游为一个期望密钥为哨兵（不以 `sk-` 开头）的假上游实例，环境里没有 `MODEL_UPSTREAM_*`；一个成员账号的会话以 `m2` 发含 `WORKBUDDY_FAKE_STATUS=401 WORKBUDDY_FAKE_BODY=secret` 标记的 prompt（夹具正文回显其期望密钥）；另一例管理员 `PUT` 把 `m2` 换到第二个假上游实例（期望密钥为第二个哨兵）后再发一次
- **THEN** 两例的回合都以 `failed` 结束，`chat_messages` 行、会话视图、SSE 帧与应用 stdout/stderr 都不含任一哨兵，`detail` 里对应位置是 `[已移除]`
