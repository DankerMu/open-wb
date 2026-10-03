# Proposal: agent-dir-host-hardening（#706 第一刀，owner 决议「两刀都做」）

## Why
`<OMP_STATE_DIR>/agent` 今天对 omp uid 组可写（第二刀改布局）。宿主以 app uid 读写其中的文件时有四个跟随/无界点：
1. `listSkills` 跟随 omp uid 放置的符号链接，`skills/` 之外的文件内容（frontmatter 的 `name`/`description`）经 `GET /api/commands` 返回给任一已登录账号；
2. `readdir` 的条目数无上界，每个请求对每个条目做一次 open/fstat/read；
3. 打开 `SKILL.md` 未带 `O_NOCTTY`：服务进程若是无控制终端的 session leader，被链到 pty 的 `SKILL.md` 可让它取得控制终端；
4. `models.yml` 用 `writeFile` 直写既有路径：跟随符号链接、mode 取决于 umask（`007` 下为组可写的 `0660`）、非原子。

## What Changes
- `server/src/sessions/slash-commands.ts`：`listSkills` 只保留前 256 个条目；`SKILL.md` 的真实路径必须落在 `skills/` 的真实路径之内，再以 `O_NOFOLLOW | O_NONBLOCK | O_NOCTTY` 打开解析后的路径。
- `server/src/model-proxy/models-yml.ts`：临时文件（独占创建）+ 显式 `0640` + rename。
- 测试：`server/test/slash-commands.test.ts`（或新文件）、`server/test/model-proxy-models-yml.test.ts`。
- 规格：chat-sessions MODIFIED「Slash 命令白名单与命令目录」；model-proxy MODIFIED「托管 models.yml」。

## 与 omp 的不一致（如实）
omp 自己仍跟随任意符号链接的 skill 目录：指向 `skills/` 之外的 skill，omp 会加载、宿主不列出，因此它的 `/skill:<name>` 被宿主判为普通文本并转义——但 omp 的 skill 分派先 `trimStart()`，仍会执行（既有残余，`slash-commands.ts` 文件头已记）。第二刀之后 `skills/` 对 omp uid 不可写，这类链接只能由运维放置。

## 残余
realpath 与 open 之间的 TOCTOU：`skills/` 仍对 omp uid 可写时，中间目录分量可在两步之间被换成符号链接。由第二刀（托管目录对 omp 只读）关闭，本刀不追。

`skills` 自身被换成符号链接：包含判断以 `realpath(<agentDir>/skills)` 为基准，omp uid 今天能把 `skills` 整个换成指向别处的链接，基准随之移动。同样由第二刀关闭。

排序饿死：omp uid 建 256 个排序靠前的条目，合法 skill 就全部不被列出。它今天本来也能改名或删除条目，没有新增能力；第二刀关闭。

条目数上界只管每个条目的 I/O：`readdir` 与排序仍随目录大小线性增长。

## Non-goals
- 目录归属与权限位、spawn 契约（第二刀）。
- 不改 omp；不改 skill frontmatter 的解析规则。
