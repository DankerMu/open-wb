# omp-spawn-no-proxy — omp spawn 环境恒钉 `no_proxy=*` 与 `NO_PROXY=*`（#1615）

## Why

宿主的模型端点是明文回环（`server/src/model-proxy/models-yml.ts:7`，`http://127.0.0.1:<port>/v1`），每个请求带 `Authorization: Bearer <WORKBUDDY_MODEL_TOKEN>`。omp 的推理请求走 Bun 原生 `fetch`（`can1357/oh-my-pi` tag `v18.12.3`，`packages/ai/src/utils/transport-fetch.ts:25-47`）：它从环境读 `HTTP_PROXY` / `http_proxy` / `ALL_PROXY`，对回环目标同样走代理，除非 `no_proxy` / `NO_PROXY` 覆盖；omp 自己的回环豁免只在设了 `PI_PROXY` 时生效（`proxy.ts:24-66,245-268`）。omp 在启动时读 `<cwd>/.env`，只填环境里未设或为空的键（`packages/utils/src/env.ts:291,300-302`）。宿主的 spawn 环境是封闭白名单，没有任何代理变量，也没有 `no_proxy`。

所以工作目录里一个 `.env`（模型写入——write 档写文件不需审批；或上传、解压、克隆的项目文件）只要有一行 `HTTP_PROXY=`、`http_proxy=` 或 `ALL_PROXY=`，下一次 spawn 起每个模型请求都以明文转经该地址：代理看到全部对话与会话令牌，它的回复被 omp 当作模型输出（可伪造回复与工具调用），确认卡与审计都看不到。issue 在钉住的 v18.12.3 二进制上实测成立（11 种情形，见 issue）。

## What

- `server/src/sessions/omp/spawn-env.ts`：`ompSpawnEnv` 恒写 `no_proxy: "*"` 与 `NO_PROXY: "*"`（与是否配置 `BROWSER_BIN` 无关）；`SUDO_PRESERVE_ENV` 在 `OTEL_SDK_DISABLED` 之后、`PUPPETEER_EXECUTABLE_PATH` 之前加 `no_proxy,NO_PROXY`（design D3）。与 #1529 的 `PUPPETEER_PROXY=direct://`、#1575 的 `OTEL_SDK_DISABLED=true` 同一做法。
- 单测：`omp-spawn-dotenv-pins.test.ts` 新 WHEN/THEN（父进程带 `HTTP_PROXY` / `ALL_PROXY` / 不匹配的 `no_proxy` / `NO_PROXY`）；写死白名单与 preserve 串的兄弟测试同步（design「Sibling surfaces」）；`linux/uid-isolation.test.ts` 必到键表加两个键（CI `uid-isolation` 在 sudo 形态下证明它们到达 omp）。
- 真实 omp v18.12.3 用例：五种 `.env` 情形（`HTTP_PROXY`、`http_proxy`、`ALL_PROXY`、`HTTP_PROXY` + 不匹配的小写 `no_proxy`、`HTTP_PROXY` + 不匹配的大写 `NO_PROXY`）回合正常、代理零命中；入库负向对照（spawn 包装删掉两个钉）代理收到指向假上游的绝对 URI 请求。放进现有 `omp-official-overlay-pins.test.ts`（已在 CI 三处清单里）。
- 规格：omp-runtime「子进程 spawn 契约」（白名单集合、钉值与副作用说明、环境白名单 WHEN/THEN、新 Scenario「工作目录 .env 不能让模型请求走代理（真实 omp）」）；omp-uid-isolation「OMP_USER 配置与 sudo spawn 前缀」（preserve 串、sudo 进程 env、八个键）。delta 以 #1575 归档后的主 spec 为底（含 `OTEL_SDK_DISABLED`）。
- 文档（编排方）：`docs/architecture/system.md` 9.8「spawn 环境恒钉…」段补这一钉与副作用；ADR-0012 在 `.env` 入口一节（#1529 条目附近）加带日期的补充。
- 不做：钉代理变量本身（Bun 无直连取值、空串钉不住）；`PI_PROXY`（omp 对回环放行，不在模型请求路径上）；`NODE_EXTRA_CA_CERTS` / `NODE_TLS_REJECT_UNAUTHORIZED`（只影响 https 出站，模型端点是 http；需要时另起）；浏览器代理（#1529 已钉）；向上游提需求。

## Triage

```text
Issue type: security hardening (bugfix)
Fixture level: expanded
Upstream suggested level: absent (issue-scribe filed; S, p1)
Level rationale: expanded — Auth / permissions / secrets trigger (conversation and session token exfiltration plus reply forgery from a workspace file, no approval) and the shared spawn entrypoint (sudo preserve list is a deployment contract); the code change is two keys plus the preserve string.
Blast radius: every omp spawn, both uid modes, and child shells (they inherit the exemption); a wrong pin either leaves the proxy path open (real-omp case red), breaks the sudo preserve string (uid-isolation / dotenv-pins red), or changes the whitelist shape other tests pin
Selected risk packs: Auth / permissions / secrets (proxy path closed by a non-empty exemption in both cases, proven against the real binary with an in-repo negative control); Public API / CLI / script entry (the sudo `--preserve-env=` string is matched by deployers' sudoers `SETENV`; order and membership pinned in spec); not selected — Config (nothing configurable), File IO / path safety (no file written), Schema, Concurrency, Resource limits, Error handling (no new failure path), Release / packaging (no binary change)
Evidence floor: unit tests pinning key set / values / preserve string (red first); real-omp v18.12.3 five-case run with proxy zero hits plus the negative control hitting the proxy; `npm test --workspace server`; official suite `WORKBUDDY_OMP_TEST=1 … test/omp-official-`; `make check`; CI `uid-isolation` green
```
