## MODIFIED Requirements
### Requirement: 服务启动与装配
系统 SHALL 以 `server/src/app.ts` 装配 Fastify 实例，并以 `server/src/server.ts` 作为唯一 production listen/DB ownership 入口；import该module只暴露pure config seam，不得mkdir/open/listen或注册signal，只有ESM main guard命中的执行路径可启动。唯一配置源为 own environment keys `HOST`、`PORT`、`DB_PATH`、`STATIC_ROOT`、`OMP_BIN`、`OMP_STATE_DIR`、`OMP_IDLE_MS`、`SANDBOX_ROOT`、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY`、`MODEL_ID`：缺省值分别为 `127.0.0.1`、`3000`、repo-root `var/dev.db`、repo-root `web/dist`、repo-root `var/omp/omp`、repo-root `var/omp-state`、`600000`、repo-root `var/sandbox`、未配置、未配置、`deepseek-v4.1-flash`；relative DB/static/omp/state/sandbox path SHALL 相对由 entry module identity 推导的repo root，不得随shell/npm workspace cwd分裂。`PORT` SHALL只接受canonical ASCII decimal `1..65535`；HOST missing取默认、empty或whitespace-only非法且不得trim/coerce，其它nonempty string原样交listen；DB/static/omp/state/sandbox path explicit empty非法。`OMP_IDLE_MS` SHALL只接受canonical ASCII decimal整数1..2147483647（原生计时器上限，用户明确批准超限启动失败）；非法值的配置错误SHALL命名该键而不含输入值。`MODEL_UPSTREAM_BASE_URL`/`MODEL_UPSTREAM_API_KEY`缺省合法，显式empty非法；未同时配置时代理仍先鉴权（无效bearer401，通过鉴权后502），不得阻止服务启动。全部config SHALL在任何filesystem/database/listen effect前验证。

对于non-`:memory:` DB path，入口SHALL recursive创建且只创建missing `dirname(DB_PATH)`，随后由唯一`openDb`创建/打开exact file；不得创建`STATIC_ROOT`；监听成功后只额外创建`<OMP_STATE_DIR>/agent`并写托管models.yml，sandbox/bin/session子目录仍由首次spawn按需创建。Exact `:memory:` SHALL保留SQLite特殊identity且不得mkdir。DB parent为existing non-directory、不可创建/写入或DB/migration不合法 SHALL走同一partial-start failure cleanup，不得fallback到默认路径。

`npm run start --workspace server` SHALL在clean checkout先以现有TypeScript compiler构建production-only JS并把tracked `migrations/`完整递归tree逐文件逐字节带入与compiled module相同的runtime位置，再执行compiled唯一入口；`make dev` SHALL只转发到该command，不得形成第二套启动逻辑。成功顺序 SHALL为validated config → DB-parent prepare → DB open/migrate → createApp（auth → http guard → model-proxy → sessions，sessions先对账后开放路由）→ listen → 以实际绑定地址推导可连接proxyBaseUrl并写`<OMP_STATE_DIR>/agent/models.yml` → application-owned stdout一行LF-terminated exact JSON `{"event":"server_started","host":"<actual>","port":<integer>,"modules":["core/db","auth","http","model-proxy","sessions"]}`，不得有extra key或在listen前/应用stderr出现。Package-manager command banner不属于application record。

Runtime config/DB/app/listen/models.yml/success-record任一步失败 SHALL不输出success record，以nonzero退出，并在stderr sink可写时由application-owned stderr输出一行LF-terminated exact generic JSON `{"event":"server_start_failed"}`（无extra key/原始error/config）；若stderr sink自身不可写，该行物理不可达，系统仍SHALL nonzero、释放资源且不得产生unhandled stream stack。Node `node:sqlite` ExperimentalWarning MAY作为平台warning另出stderr。任意success/failure stream均不得dump environment或包含cookie/password/session值、MODEL_UPSTREAM_API_KEY值或会话bearer。Application stdout/stderr record SHALL经受管writer处理sync throw、write callback与stream error，settle exact一次且不得泄漏raw EPIPE。

失败清理 SHALL关闭当前入口已拥有的app/DB；每个entry SHALL把同一AbortSignal传给Fastify listen，SIGINT/SIGTERM只对pending bind执行abort；已绑定时SHALL经共享幂等shutdown先完成所有runtime原生退出及store回收，再停止listener，最后关闭唯一DB handle。不得让同一AbortSignal的Node原生close绕过runtime先行归属；重复/混合signal不得在清理期间重新abort已绑定listener。干净取消正常退出；已确定真实失败保持nonzero，不得被signal抹去failure record或降为0。Signal落在listen invoke与实际bind之间时不得后到绑定、不得输出success/failure record，port/DB须可由successor立即复用。`.gitignore` SHALL排除default `var/` runtime output，knip SHALL把`src/server.ts`识别为entry。

#### Scenario: 干净启动与一致命令面
- WHEN 从repo root执行`make dev`或`npm run start --workspace server`，或build后从foreign cwd直接执行absolute `dist/server.js`，且未设置十一项配置
- THEN 三种启动形状消费同一entry/config identity，监听`127.0.0.1:3000`；只在repo-root recursive创建`var/`并使`var/dev.db`完成tracked migrations；创建`var/omp-state/agent/models.yml`且baseUrl为实际端口的可连接回环地址；不创建missing `web/dist`/sandbox/bin；`GET /api/healthz`返回exact200；application stdout只在listen成功后出现上述exact startup record；SIGTERM后端口与DB均可立即由后继进程重用

#### Scenario: override、非法配置与部分启动失败
- WHEN以可用custom host/port、absolute或relative DB/static/omp/state/sandbox路径及模型配置启动
- THENoverride逐项原样生效，relative path仍绑定repo root；只创建non-memory DB的exact parent与托管agent目录、绝不创建STATIC_ROOT或误建default DB；HOST=0.0.0.0时models.yml的baseUrl为http://127.0.0.1:<实际端口>/v1，IPv6通配绑定使用http://[::1]:<实际端口>/v1；build output中的完整migration tree与tracked source inventory/bytes一致，health/info/auth/static合同保持
- WHEN`PORT`为empty/whitespace/sign/fraction/exponent/zero/out-of-range，HOST为empty/whitespace-only，DB/static/omp/state/sandbox path为explicit empty，OMP_IDLE_MS为empty/0/abc/负数/小数/非canonical或大于2147483647的整数，上游变量为explicit empty，或import `server.ts`但不命中main guard
- THENmain-path非法config在任何filesystem/database/listen副作用前nonzero，application stderr恰一行上述generic failure record且无success；import-without-main保持silent且无filesystem/database/listen/signal副作用
- WHENDB parent为file/不可创建、DB open/migration失败、HOST由listen拒绝、port已占用、models.yml不可写或post-listen stdout sink失败
- THEN进程nonzero且stderr可写时只有generic failure record；stdout EPIPE不得输出raw stack；关闭所有已拥有的app/DB，不遗留可监听server、活跃omp原生子进程或active SQLite handle，parent/static/default路径无额外副作用；stderr同时不可写时允许无record但同样nonzero/cleanup
- WHEN SIGINT/SIGTERM 落在listen invoke后、实际bind前，或成功后重复/混合到达
- THEN pending bind由同一AbortSignal取消且无startup record，或已绑定listener幂等关闭；两种情况下均完成已拥有runtime原生退出后释放port、最后关DB；干净取消正常退出，successor可立即复用exact port/DB

#### Scenario: Signal during managed model publication
- WHEN a clean signal arrives while the post-listen model write is pending
- THEN owned IO is settled without a startup/shutdown await cycle; no late success/failure record is emitted solely because of cancellation, no cleared app handle is dereferenced, and no resource is abandoned; a genuine writer failure remains a truthful nonzero generic failure

#### Scenario: Full proxy turn keeps both credentials out of output
- WHEN the actual production entry uses a unique64-character upstream key and fake-omp call-proxy reads the generated models.yml, authenticates with its actual runtime bearer, and completes a real local upstream streamed turn before SIGTERM
- THEN the persisted assistant content equals the upstream deltas and the turn is done; complete application stdout/stderr contains neither the upstream sentinel nor that bearer; models.yml contains only the WORKBUDDY_MODEL_TOKEN variable name, never either credential value

### Requirement: Shared agent module assembly
createApp SHALL always register model-proxy then sessions after auth and the HTTP guard, before catch-all/static routes, using one shared TokenRegistry. Sessions SHALL reconcile before accepting requests. App close SHALL reuse the existing module preClose cleanup without closing caller-owned DB. No startup process or agent directories SHALL be created by merely configuring/registering modules; lazy runtime spawn retains directory ownership. The five-module startup record SHALL correspond to the actual composition, not only a hardcoded list. Post-listen model publication and active-runtime signal cleanup belong to the production entry lifecycle above; merely constructing the injectable app SHALL remain free of these startup effects. SSE remains outside this requirement (issue #103).
#### Scenario: Authenticated session and bearer proxy coexist
- WHEN a real createApp is created with caller DB and injected trusted runtime/registry settings
- THEN session routes use cookie/owner guards, proxy uses the same runtime-issued bearer rather than cookie auth, health/info/static behavior remains unchanged and app.close leaves DB usable
#### Scenario: Missing upstream remains an available app
- WHEN either upstream setting is absent
- THEN startup and authenticated session CRUD remain available; invalid bearer receives401 before parser/config work, a registered live bearer receives502 and the secret value is absent from startup/failure output
#### Scenario: Pure source and compiled configuration identity
- WHEN the existing pure resolver receives defaults/overrides for all eleven keys at source and compiled entry URLs from unrelated cwd
- THEN each of the seven added defaults and overrides is observed unchanged, path identity remains rooted at the entry's repository and unknown environment keys are ignored without filesystem/listen/signal side effects

