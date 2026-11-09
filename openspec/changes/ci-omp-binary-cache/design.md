# Design: ci-omp-binary-cache

Change surface：
- `.github/workflows/ci.yml`（smoke、ui-walk、uid-isolation、browser-image 四个 job）
- `scripts/fixtures/ci-contract/ci.yml.fixture`（ci.yml 的逐字副本）
- `scripts/test-ci-harness.sh`（source-derived oracle 与变异）
- `scripts/inspect-ci-workflow.js`（`ALLOWED` / `WANT` 加 cache，见 D4）
- `deploy/app/Dockerfile`
- `.github/scripts/ci-browser-image.sh`
- `docs/architecture/system.md`、`IMPLEMENTATION_PLAN.md`
- 本 change 的 spec delta

Must preserve：
- `scripts/omp-fetch.sh`、Makefile 的 `omp-fetch` 目标、`constraints.yaml`、`AGENTS.md` 一字不改。验证：`git diff --exit-code origin/master -- scripts/omp-fetch.sh Makefile constraints.yaml AGENTS.md` 退出 0。
- 四个 job 除新增步骤外，原有步骤、次序、`with`、env、timeout、runs-on 都不变。其余八个 job 与 `all-checks-passed` 不变。
- 部署方的默认构建方式 `docker build -f deploy/app/Dockerfile .`、`docker compose … up --build`、`buildx --platform linux/amd64` 行为不变：`omp-seed` 为空时，构建阶段照常下载。`Dockerfile.dockerignore` 不改，仍排除 `var/`，所以 Mac 开发机上的 darwin 版 `var/omp/omp` 不会进入构建上下文。
- `ci-browser-image.sh` 现有的字面钉住行（`set -euo pipefail`、`docker run -d …` 那一行、禁用词表）不变。

Must add/change：
- D1 缓存步骤：四个 job 各在 `run: make omp-fetch` 前紧邻插入以下内容，逐字一致：
  ```yaml
        - uses: actions/cache@v6
          with:
            path: var/omp/omp
            key: omp-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/omp-fetch.sh') }}
  ```
  - 用 v6：最新 major（v6.1.0，2026-06），`action.yml` 声明 `runs.using: node24`、`post-if: success()`，满足「第三方 CI action 使用 Node 24 runtime」。
  - 不设 `restore-keys`：前缀回退可能恢复旧版本的二进制，`omp-fetch.sh` 遇到校验不过的已有文件会 `exit 1`，job 就会永久变红。只用精确 key，脚本任何改动都让缓存整体失效，属于保守取向。
  - 缓存内容不受信任：命中后 `make omp-fetch` 仍照常运行，由脚本的已有分支做 SHA256 校验，通过后打印 `omp-fetch: skip download`；不通过就非零退出。
  - 只在 job 成功后保存（`post-if: success()`），所以写入缓存的恒为该 job 已校验并实际用过的文件。
  - 冷缓存时四个 job 并发各下载一次（与现状相同），保存时谁先谁后无所谓；其余 job 的保存失败只记为 warning，不让 job 失败。
- D2 browser-image 步骤：checkout → setup-node → `npm ci` → D1 缓存 → `run: make omp-fetch` → `run: docker build --build-context omp-seed=var/omp -t workbuddy-app:ci -f deploy/app/Dockerfile .` → `run: bash .github/scripts/ci-browser-image.sh`。
  - runner 是 Linux x86_64，取到的 `omp-linux-x64` 与镜像（`linux/amd64`）的资产相同，SHA 也相同。
- D3 Dockerfile 种子阶段：
  - 在 build 阶段之前加 `FROM scratch AS omp-seed`（上方一行注释说明用途与 `--build-context` 用法）。
  - build 阶段在 `COPY . .` 之后、`RUN npm ci …` 之前加 `COPY --from=omp-seed / var/omp/`。
  - 文件头第 2 行附近补一句：CI 以 `--build-context omp-seed=var/omp` 带入已校验的二进制。
  - 2026-11-09 已在本机 BuildKit（buildx v0.30.1）实测：不带 `--build-context` 时 `var/omp/` 为空目录；带上时其中恰为种子文件。
  - 种子里的 `omp` 不符合 linux-x64 的 SHA 时构建失败（fail closed），只有显式传参才会走到这条路径。
  - 种子文件的权限位由 `omp-fetch.sh` 的跳过分支 `chmod 755` 修正。
- D4 oracle（`scripts/test-ci-harness.sh`）：
  - `harness_clean` 里 `if "actions/cache" in blob: raise ValueError` 那条规则改为：smoke、ui-walk、uid-isolation 区段内的 cache 必须恰为 D1 那一步，且紧邻 `make omp-fetch` 之前。
  - `parse_job`（`:126` 内嵌）现在只在 `env_open` 时接受第 10 列缩进的行，块式 `with:` 下的 `path:`、`key:` 会让它 `raise`。必须让它像收集 `env` 子项那样收集 `with` 子项：键重复即拒绝，未知缩进照旧拒绝。D1 不得改用 flow 写法绕开，spec 要求的是块式逐字内容。
  - smoke、ui、uid、browser 四个精确步骤元组加入 D1（携带 `uses` 与 `with` 子项元组，`path`、`key` 逐字，多出任何键即不等），browser 元组改为 D2 的步骤序列。
  - `scripts/inspect-ci-workflow.js`：`ALLOWED` 加 `"actions/cache": "v6"`，`WANT` 加 `"actions/cache@v6": 4`，于是其它 job 里出现 cache 或旧 major 都会被计数与 major 规则拦下。现有以 `actions/cache@v4` 作「非目标 action」诱饵的用例（`:330` 的 unrelated-job 正对照，`:464`、`:473`、`:500-507` 的 ast cand* 用例）把诱饵换成不在 `ALLOWED` 里的 `actions/upload-artifact@v4`，期望值不变；`:411` 的 "action replaced checkout" 用 `actions/cache@v4` 替换 checkout，换后仍应被拒，保持或同样换诱饵均可，结论写进 PR。
  - `contract()`（`:94`）新增字面钉住：`deploy/app/Dockerfile` 恰含 `FROM scratch AS omp-seed` 与 `COPY --from=omp-seed / var/omp/` 各一行（`ccopy` 同时复制 Dockerfile 进 scratch 契约副本）；加两条分别删除它们的变异。
  - `ci-browser-image.sh` 新增一条字面钉住：哨兵构建行含 `--build-context omp-seed="$root/var/omp"`。
  - `:692` 的 `s.count("make omp-fetch")==3` 改为 4。
  - `:224` 的「browser image tag drift」锚点改为新的 `docker build` 命令行。
  - `:323` 的「smoke drop omp-fetch」「ui drop omp-fetch」两个变异的锚点是「上一步紧接 `- run: make omp-fetch`」，插入缓存步骤后锚点不存在，改为以缓存步骤为上下文的锚点；其余以 `- run: make omp-fetch\n      - name: …` 为锚点的变异（`:201`、`:322-323`）在缓存步骤紧邻其前时不受影响，逐个确认。
  - `:322` 的「smoke cache action」「ui cache action」两个变异改写为新规则下的拒绝用例，例如插入第二个 cache 步骤、或 `actions/cache@v4`，不能直接删掉。
  - 新增变异，每条都必须被拒：
    - 四个 job 各删 D1 一次。
    - 把 D1 移到 `make omp-fetch` 之后。
    - D1 的 `@v6` 改为 `@v5`。
    - 改 `path`；改 `key`（例如去掉 `runner.arch`，或把 `hashFiles` 的参数换成别的文件）。
    - 加 `restore-keys`。
    - browser-image 删 `make omp-fetch`；`docker build` 去掉 `--build-context omp-seed=var/omp`。
    - 哨兵构建去掉 `--build-context`。
    - 在 sast 或 secret-scan 里加一个 `actions/cache@v6`（WANT 计数）；四个 job 之一改用 `actions/cache@v4`（旧 major）。
    - 删 Dockerfile 种子阶段任一行。
  - `ci.yml.fixture` 刷新为新的 ci.yml（逐字一致，验证：`diff -u .github/workflows/ci.yml scripts/fixtures/ci-contract/ci.yml.fixture` 退出 0）。
- D5 文档：
  - `docs/architecture/system.md` 参考镜像「构建」小节补一条：CI 以 `--build-context omp-seed=var/omp` 带入已校验的二进制；默认不带时照常下载，需要访问 GitHub release。旧构建器那条说明改为「本 Dockerfile 需要 BuildKit」（忽略清单、`--chmod`、`--build-context` 与空 scratch 阶段都依赖它）。
  - `IMPLEMENTATION_PLAN.md:522` 那句「#1932（…待 owner 决定）」改为已交付，指向本 change。#1935 已关闭，一并更新为已交付。

Governing invariant：
- CI 里实际运行的 omp 恒为 SHA256 与 `scripts/omp-fetch.sh` 常量一致的 v18.12.3 官方资产，无论它来自缓存、种子还是下载。
- 默认构建路径与本地开发的 `make omp-fetch` 行为不变。

Sibling surfaces：
- office-sidecar job 构建的是 converter 镜像，不涉及 omp，不改。
- Makefile 不改。
- `scripts/test-omp-fetch.sh` 已覆盖「已存在且校验通过则跳过」与「校验不过则删除并非零」，不改。
- 没有其它地方会拉 omp：`git grep -n "omp-fetch" -- .github deploy scripts Makefile` 逐个核对，结论写进 PR。

Seams under test：
- oracle 的 scratch workflow 变异，经 `make test-guardrails`。
- 本 PR 自身的 CI：先冷后热两次运行。

Required evidence：
- `make test-guardrails` 退出 0：guardrail self-test 与 ci-harness oracle 全 PASS，新增变异的名称与数量写进 PR。
- 先红：先改 oracle、inspect 与 fixture，不动 ci.yml、Dockerfile 和 `ci-browser-image.sh`，跑 `make test-guardrails`。应当红的是：`:127` 的「workflow helper wiring」（步骤元组与现行 ci.yml 不符）、`:692` 的 fetch 计数检查、inspect 的 cache 计数，以及 Dockerfile 和哨兵构建行的字面钉住。贴出这些 FAIL 行。
- `make check` 退出 0。
- `make lint` 与 `make anti-drift` 退出 0；`npx openspec validate ci-omp-binary-cache --strict --no-interactive` 退出 0。
- CI：
  - 第一次运行全绿；冷缓存时日志里有下载，post 步骤保存了缓存。
  - 随后 `gh run rerun <run-id>` 整体重跑，attempt 2 全绿。smoke、ui-walk、uid-isolation 的 `make omp-fetch` 步骤日志都含 `omp-fetch: skip download`；browser-image 主构建的 `docker build` 步骤日志含该行；哨兵构建以 oracle 钉住的 `--build-context` 参数加上构建成功作为证据。
  - 证据由编排方从 job 日志取得并贴进 PR。
  - 本机 BuildKit 两种构建（默认路径、带 `--build-context`）的实际日志：`var/omp/` 是否为空、种子文件的权限位。
- 本机 BuildKit 的种子阶段实测（D3）写进 PR。

Risk notes：
- GitHub cache 在 7 天无访问后逐出，仓库总量上限 10 GB。omp 约 190 MB，npm 缓存另算，量级可接受。
- 缓存按分支作用域隔离：PR 能读 master 的缓存，master push 的 CI 写入后各 PR 都能命中。fork PR 不能写 master 作用域。
- `hashFiles` 在 job 开始时按 checkout 后的文件计算，与 `make omp-fetch` 实际执行的脚本是同一份。
- 坏缓存条目（概率极低，只有 job 成功后才保存）会让 `omp-fetch.sh` 删文件并非零退出；失败的 job 仍会访问它，它就不会被逐出。处置：`gh cache delete <key> --repo DankerMu/open-wb` 后重跑。
