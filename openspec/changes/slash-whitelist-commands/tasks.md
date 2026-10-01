# Tasks: slash-whitelist-commands（#551）

## 10. Slash 命令 — 白名单模块与命令目录（父 tasks 10.4a 原文）

- [ ] 10.4a `server/src/sessions/slash-commands.ts`（新：`BUILTIN_COMMANDS` 两条中文常量按序 `compact`/`todo`、`listSkills(agentDir)` 同步枚举 `<agentDir>/skills/<dir>/SKILL.md`（跳过点开头目录）frontmatter `name`（缺省目录名，须匹配 `^[^\s/]+$`）/`description`（缺失或空 → 跳过）/`enabled`（`false` → 跳过），按名排序不缓存、`classifyPrompt(text, skills)`（skill 名只按 U+0020 切）、`toWireText(text, skills)`）+ `server/src/sessions/rest-commands.ts`（新：`GET /api/commands` cookie 守卫、no-store、无 body/query（有则 400）、200 `{commands:[{name,label,description,hint,source}]}` 内建在前 skills 在后）+ `server/src/sessions/omp/process.ts` 导出 `ompAgentDir(stateDir)`（现有 `join(stateDir,"agent")` 改为调用它）+ `sessions/index.ts` 选项 `agentDir`（注册 `rest-commands`、透传给 `registerSessionRoutes`，本刀路由暂不消费）+ `app.ts` 传 `ompAgentDir(stateDir)`。验证：新建 `server/test/slash-commands.test.ts`（分类/转义十三例含 `/retry` 与换行截断的 skill 名 + 临时目录 `listSkills` 七例含 `nodesc`/`off`/`.hidden`/无目录/不缓存；chat-sessions「Whitelist classification and wire form」「Skills are read from the platform directory under omp's rules」）、`server/test/commands-rest.test.ts`（经 `createApp`、skill 写进 `<stateDir>/agent/skills`：401；两 skill 时恰四条五键且顺序；带 query/body 400；无目录恰两条；`ompAgentDir(stateDir)` 等于既有 `omp-process.test.ts` 断言的 `PI_CODING_AGENT_DIR`；「Command directory」）；`app.test.ts`（790）只改期望值不增长；`bash scripts/size-guard.sh` 退出 0，knip 零新增

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 新路由 401/400/200、五键、顺序 → 证据 4–7 |
| Auth / permissions / secrets | yes | cookie 守卫；白名单误判即安全边界失守 → 证据 1、2、4 |
| File IO / path safety / overwrite | yes | 同步枚举、缺失/不可读/点目录/普通文件 → 证据 3、7 |
| Config / project setup | yes | `agentDir` 与 `PI_CODING_AGENT_DIR` 同源 → 证据 8 |
| Legacy compatibility / examples | yes | spawn env、装配次序、既有路由不变 → 既有测试全绿、证据 9 |
| Concurrency / shared state / ordering | no | 无状态纯函数与只读路由 |
| Error handling / rollback / partial outputs | no | 读失败即跳过，无写入 |
| Schema / columns / units / field names | no | 不涉库 |
| Resource limits / large input / discovery | no | 平台安装的少量 SKILL.md（残余已记） |
| Release / packaging / dependency compatibility | no | 不引 YAML 库 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进两个新文件；既有测试只改期望值，夹具只补 `agentDir` 键（在 PR 列出）。
- [ ] RED 集合以 design「Required evidence」为准：先实现前跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate slash-whitelist-commands --strict --no-interactive` 通过。
