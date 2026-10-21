# omp-runtime Spec Delta

## MODIFIED Requirements

### Requirement: overlay 固定块 advisor / ida 钉的真实 omp 回归
宿主 overlay 固定块里的 `advisor.enabled: false` 与 `ida.enabled: false` 两段（「宿主 overlay」）SHALL 各有一条以钉住的官方 omp 二进制跑的回归用例与一条负对照（`server/test/omp-official-overlay-pins.test.ts`，`WORKBUDDY_OMP_TEST=1` 门下），负对照以去掉对应段的 overlay 变体经 `--config` 与 `PI_CONFIG_FILES` 两路换入，证明观测面可达；观测面以 v18.12.3 为基线：`ida` 是 discoverable 工具、不进 `get_state.dumpTools`，只在项目层 `ida.enabled: true` 且 `ida.installDir` 指向含平台命名库文件（darwin `libidalib.dylib`、linux `libidalib.so`、win32 `idalib.dll`）的目录时以 `xd://ida` 设备出现在 `get_state.systemPrompt`；`advisor` 没有 RPC 读回，只能按行为读——项目层 `advisor.enabled: true` 且 `modelRoles.advisor` 指向白名单模型时，一个 bash 回合的上游请求数与是否出现 `advisor_yielded` 帧。两条回归用例在当前固定块上先绿（对已有钉的特征断言），删去对应段时 SHALL 变红（变异核对记入实现 PR）。用例旁听子进程 stdout 的 tee SHALL 对坏行容错：解析失败或解析结果不是对象（`null`、数组、标量）的行跳过并计数，不抛异常，空白行跳过不计数，同一 chunk 里坏行之后的合法帧与跨 chunk 的半行（含跨 chunk 的多字节 UTF-8 字符）照常按序回调；该 tee 是 `server/test/support/omp-official.ts` 的导出 helper，只挂 `data` 监听、不改变流的读取方式，官方测试的全部 stdout tee（overlay-pins、rpc-ui 的 UI 请求 tee、`support/omp-official-proxied.ts`）复用它，坏行计数随 `[overlay-pins]` 读数一起打印。

#### Scenario: advisor / ida 钉的回归与负对照
- **WHEN** 官方 omp v18.12.3 以产品 overlay 启动，cwd 的 `.omp/config.yml` 写 `ida.enabled: true`、`ida.installDir: <cwd>/fake-ida`（目录内有一个空的平台命名库文件），并读取 `get_state`
- **THEN** `systemPrompt` 的 `xd://` 设备列表含 `ast_edit`、不含 `ida`（`dumpTools` 不含 `ida` 恒成立——discoverable 工具——不作证据）
- **WHEN** 同一配置，但 overlay 变体去掉了 `ida:\n  enabled: false` 两行
- **THEN** 设备列表含 `ida`
- **WHEN** 官方 omp v18.12.3 以产品 overlay 在 `write` 档启动，cwd 的 `.omp/config.yml` 写 `advisor.enabled: true`、`modelRoles.advisor: workbuddy/deepseek-v4.1-flash`，跑一个含 bash 调用的回合并放行审批，回合 `agent_end` 后每 500 ms 读一次假上游的请求数，计数保持不变满 2 s 视为稳定（30 s 内未稳定即失败）
- **THEN** 请求数恰为 2，子进程 stdout 的全部帧（读到稳定为止）里没有 `advisor_yielded`
- **WHEN** 同一配置，但 overlay 变体去掉了 `advisor:\n  enabled: false` 两行
- **THEN** 请求数大于 2，且 stdout 帧里出现 `advisor_yielded`

#### Scenario: stdout tee 容错非 JSON 行
- **WHEN** tee 收到一个 chunk `{"type":"a"}\nnot json\n{"type":"b"}\n`
- **THEN** 回调恰收到 `a`、`b` 两帧按序，坏行计数为 1，没有异常抛出
- **WHEN** 随后收到两个 chunk `{"ty` 与 `pe":"c"}\n`
- **THEN** 拼成一帧 `c` 回调，坏行计数不变
- **WHEN** 随后收到 `{"type":"d"\n{"type":"e"}\n`
- **THEN** 截断行跳过、计数为 2，`e` 照常回调
- **WHEN** 随后收到 `null\n`
- **THEN** 计数为 3，没有回调；空白行不计数
- **WHEN** 一帧 `{"type":"中"}\n` 的字节在多字节字符中间切成两个 chunk
- **THEN** 拼成一帧、`type` 为 `中`，计数不变

