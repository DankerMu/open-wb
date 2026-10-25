# MCP 连接器凭证存在托管 `mcp.json` 里，对 omp uid 可读

管理员登记的 MCP 连接器（change `s1d-connectors`，规格 connectors）带凭证：stdio 连接器的 `env` 值、http 连接器的 `headers` 值。
拉起 stdio server、向 http server 发请求的是 omp，所以凭证必须交给 omp。这与模型网关密钥不同：ADR-0008 让 omp 环境零网关凭证，
真密钥只在 app-server 的模型代理里；连接器没有对应的代理层，omp 只认 `mcp.json` 里的字面值。

决定（owner 2026-10-21 grill 定方向，起草者按事实细化，design D4、D11）：

1. **DB 为事实源，宿主生成托管 `mcp.json`。** 启用的连接器写成 `<OMP_STATE_DIR>/home/.omp/agent/mcp.json`（`0640`，app uid 持有，
   omp uid 经共享组只读——ADR-0010 2026-10-03 补充的布局），omp 每次 spawn 作为用户级 MCP 配置读取。启动阶段 `mcp_json` 写一次，
   此后每次连接器写入在同一请求里重写。
2. **凭证只进 `env` / `headers`，不进 `args`；值不回传。** 登记仅管理员；`GET /api/connectors` 只回键名；审计 detail、日志、
   探活摘要、错误 message 都不含值。写进文件的每个字符串都拦住 omp 会改写的取值（`!` 开头、含 `${`、`env` / `headers` 值恰为
   `OMP_CHILD_ENV_NAMES` 里的名称），见 design D3。

## Consequences

- **每个登录成员都能拿到全部启用连接器的凭证。** agent 读 `~/.omp/agent/mcp.json` 属于读档、不需审批，任何会话都能读出整个文件。
  所以只登记所有成员都可以持有的凭证（例如全员共用的只读服务账号）；不能给全员的凭证不要登记。按账号登记的私有连接器不在本决定内
  （要改 ADR-0010 的共享 HOME 布局）。
- **stdio server 继承 omp 的环境与会话 cwd**（读代码推出：omp 以 `{...Bun.env, ...config.env}` 拉起它，cwd 缺省为会话目录）：
  其中有本 generation 的模型代理令牌 `WORKBUDDY_MODEL_TOKEN`，以及 omp 启动时从项目 `.env` 补进来的变量（如 `NODE_OPTIONS`、
  `LD_PRELOAD`，omp `utils/src/env.ts:240-247`）。会话属主因此能经项目 `.env` 影响 stdio server 进程，这与 ADR-0012 登记的
  「项目内工具」残余同类：omp 以独立 uid 运行（ADR-0010），所能触及的范围以该 uid 为界。
- **已接受残余：只在 `.env` 里定义的名称、PAM 补进来的名称。** `env` / `headers` 的值恰为某个环境变量名时 omp 会替换成该变量的值。
  宿主只拦 `OMP_CHILD_ENV_NAMES`（宿主自己设、sudo 注入、omp 自设的名称）。只在项目 / agent / home `.env` 里定义的名称不在集合里：
  要利用它，攻击者得知道管理员登记的字面值，而 `.env` 由会话属主控制、只影响其本人会话。`OMP_USER` 模式下 PAM 从主机配置补进来的名称
  （如 `/etc/environment`，开放集合）同样不拦：替换出来的是部署者自己的主机配置，且只有管理员能登记取值。
- **既有残余，只报告、不在本决定里修：项目 `.env` 的 `CLAUDE_CONFIG_DIR`。** 项目 `.env` 可以设 `CLAUDE_CONFIG_DIR`（omp 启动时补进环境），
  omp 的 `claude` provider 据此改读 `<CLAUDE_CONFIG_DIR>/.claude.json` 作为**用户级** MCP 配置（omp `config/claude-paths.ts:11-17`、
  `discovery/claude.ts:63`）。宿主 overlay 的 `mcp.enableProjectConfig: false` 只丢 project 级条目，挡不住这一条；它不由连接器引入。
- **CONTEXT.md 不变量 #4 不涵盖连接器凭证。** 该条只管 kb-service 凭证与模型网关密钥不得出现在 omp 子进程可读环境；连接器凭证按本决定
  对 omp uid 可读，不是对它的违反。
- **验证**：CI `uid-isolation` 的托管布局用例证明 omp uid 能读 `mcp.json`、覆写 `EACCES`、字节与 `0640` 不变，且任何帧都不含其中的
  哨兵 `env` 值（`server/test/linux/uid-isolation.test.ts`）；以 `0600` 写出的负对照使 `read=ok` 的断言失败。
- **回滚**：回退代码时连同删除 `<OMP_STATE_DIR>/home/.omp/agent/mcp.json`，否则 omp 仍会读它（`docs/architecture/system.md` 9.11）。

## Considered Options

- **凭证放进 omp 的进程环境，`mcp.json` 只写变量名**——omp 的 bash 工具同样读得到环境（ADR-0008 2026-10-03 补充），暴露面不变；
  而且依赖的正是 omp 把「值恰为变量名」替换成变量值的规则，D3 要拦住的就是这条。弃。
- **`mcp.json` 设为 `0600`、omp uid 不可读**——omp 读不到文件，连接器不生效。弃（即 uid-isolation 的负对照）。
