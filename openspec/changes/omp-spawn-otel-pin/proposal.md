# omp-spawn-otel-pin — omp spawn 环境恒钉 `OTEL_SDK_DISABLED=true`（#1575）

## Why

omp 的 OTLP 遥测导出只看环境变量：只要 `OTEL_EXPORTER_OTLP_ENDPOINT`（或分信号端点）非空就注册 trace / log / metric 三路导出，`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` 还能打开消息内容采集。omp 以会话目录为 cwd 启动，并在模块加载时读 `<cwd>/.env`，对每个键只在环境里没有非空值时写入（`spawn-env.ts:26-27,35-37` 已记下这一点）。宿主的 spawn 环境是封闭白名单，不含任何 `OTEL_*`，所以工作目录里一个 `.env`（模型写入、上传或解压的项目文件、克隆的仓库）就能让 omp 把遥测从服务器发到任意地址，卡片与审计都看不到。

issue 写于钉住版本还是 v18.0.10 时：那一版没有 `telemetry.otlpExportEnabled` 设置键，`.env` 注入端点即导出。#1563 / #1570 已把钉住版本翻到 v18.12.3，`initTelemetryExport` 在 `!exportEnabled || OTEL_SDK_DISABLED=true` 时返回（`packages/coding-agent/src/telemetry-export.ts:82`，tag `v18.12.3`），宿主 overlay 的 `telemetry.otlpExportEnabled: false`（`host-overlay.ts:24-25,76-77`，#1564）现在挡得住。剩下的价值是纵深防御：不再只依赖一个设置键在以后的 omp 版本里继续存在、继续被尊重；`OTEL_SDK_DISABLED` 是 OpenTelemetry 的通用开关，v18.0.10（`:71`）与 v18.12.3（`:82`）都认。

## What

- `server/src/sessions/omp/spawn-env.ts`：`ompSpawnEnv` 恒写 `OTEL_SDK_DISABLED: "true"`（与是否配置 `BROWSER_BIN` 无关），`SUDO_PRESERVE_ENV` 在 `PUPPETEER_PROXY_IGNORE_CERT_ERRORS` 之后、`PUPPETEER_EXECUTABLE_PATH` 之前加 `OTEL_SDK_DISABLED`——与 #1529 的 `PI_BROWSER_RELAY: "0"` 同一做法。宿主今天不传任何 `OTEL_*`，已有部署无行为变化。
- 单测：`omp-spawn-dotenv-pins.test.ts`（键集合、取值、sudo 前缀，按规格写死不从源码推导）、`omp-process*.test.ts` / `session-supervisor-helpers.ts` 中写死白名单与 preserve 串的断言同步；`server/test/linux/uid-isolation.test.ts` 的必到键表加 `OTEL_SDK_DISABLED`（CI `uid-isolation` 在 sudo 形态下证明它到达 omp）。
- 真实 omp v18.12.3 用例：工作目录 `.env` 写本地监听器端点、内容采集开关与 `OTEL_SDK_DISABLED=false`，三种配置（产品 overlay；去掉 `telemetry:` 块的 overlay；两者都去掉作为入库负向对照）——前两种监听器零请求，负向对照收到请求。优先放进现有 `omp-official-overlay-pins.test.ts`（已在 CI 的三处硬编码清单里）；若另建文件，三处清单（`.github/scripts/ci-uid-isolation.sh:292`、`scripts/test-ci-harness.sh:92`、`:849`）同步并跑 `make test-guardrails`。
- 规格：omp-runtime「子进程 spawn 契约」（白名单集合、钉值说明、环境白名单 WHEN/THEN、新 Scenario「工作目录 .env 不能打开 OTLP 导出（真实 omp）」）；omp-uid-isolation「OMP_USER 配置与 sudo spawn 前缀」（preserve 串、sudo 进程 env、六个键）。
- 文档（编排方）：`docs/adr/0012-omp-project-config-host-overlay.md` 在 `:138` 的 telemetry 条目后加带日期的补充；`docs/architecture/system.md` 9.8 的 overlay 固定块表（`:533`）与 `:452`「spawn 环境恒钉…」段补上这一环境钉。
- 不做：overlay 的 `telemetry.otlpExportEnabled` 钉（保留，两道关并存）；穷举 `.env` 能注入的其它非 `PI_*` / `OMP_*` 变量（另起）；剥掉父进程 `OTEL_*`（本来就不传）。

## Triage

```text
Issue type: security hardening (bugfix)
Fixture level: expanded
Upstream suggested level: absent (issue-scribe filed; S, p2)
Level rationale: expanded — Auth / permissions / secrets trigger (data exfiltration from the server via an injected env) and the shared spawn entrypoint (`process.ts` is the only omp spawn path; sudo preserve list is a deployment contract); the code change itself is two lines.
Blast radius: every omp spawn, both uid modes; a wrong pin either leaves export open (real-omp case red in configuration 2), or breaks the sudo preserve string (uid-isolation / dotenv-pins red), or changes the whitelist shape other tests pin
Selected risk packs: Auth / permissions / secrets (exfiltration closed by two independent switches, proven against the real binary with an in-repo negative control); Public API / CLI / script entry (the sudo `--preserve-env=` string is matched by deployers' sudoers `SETENV`; order and membership are pinned in spec); Config / project setup (overlay telemetry block stays; env pin is not configurable); not selected — File IO / path safety (no file written), Schema, Concurrency, Resource limits, Error handling (no new failure path), Release / packaging (no binary change)
Evidence floor: unit tests pinning key set / value / preserve string; real-omp v18.12.3 three-configuration case incl. the negative control receiving a request; `npm test --workspace server`; official suite `WORKBUDDY_OMP_TEST=1 … test/omp-official-`; `make check`; `make test-guardrails` (only if a CI list changes); CI `uid-isolation` green
```
