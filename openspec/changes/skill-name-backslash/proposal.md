# skill-name-backslash — skill 名字规则补上反斜杠，与 omp v18.12.3 对齐（#1587）

## Why

宿主读 skill 时以 `SKILL_NAME = /^[^\s/]+$/`（`server/src/sessions/slash-commands.ts:89-90`）过滤 frontmatter `name`（缺省取目录名），注释与 chat-sessions「Slash 命令白名单与命令目录」都写「omp 不校验名字」。这在 v18.0.10 时代成立；钉住版本翻到 v18.12.3 后，omp 的 `scanSkillsFromDir` 跳过含 `/` 或 `\` 的名字（`packages/coding-agent/src/discovery/helpers.ts:491-499`，tag `v18.12.3`；v18.0.10 没有这条）。宿主已拒 `/` 与空白，差异只剩 `\`：`name: a\b` 的 skill 宿主列进 `GET /api/commands`、`classifyPrompt` 把 `/skill:a\b …` 判为 skill 原样发给 omp，而 omp 根本不加载它。

## What

- `slash-commands.ts`：`SKILL_NAME` 改为 `/^[^\s/\\]+$/`；注释改为「omp v18.12.3 跳过含 `/` 或 `\` 的名字（`discovery/helpers.ts:494-499`），空白是宿主规则（`/skill:<name>` 的名字止于第一个 U+0020）」。平台目录与项目目录共用 `readSkill`（`:410-411`），一处改动两处生效。
- 测试：`server/test/slash-commands.test.ts` 的 listSkills 用例（chat-sessions 场景「Skills are read from the platform directory under omp's rules」）加 `back/SKILL.md`（`name: a\b`，`description: w`）与 `c\d/SKILL.md`（目录名含 `\`、不写 `name`），期望列表不变；同一用例断言 `classifyPrompt("/skill:a\\b x", list)` 为 `{kind:"text"}`；项目目录加同例一行（`listProjectSkills`）。
- 规格：chat-sessions「Slash 命令白名单与命令目录」的名字规则句与该场景同步。
- 不做：反方向差异（omp 对 `name` 先 `trim()`、全空白回落目录名，而宿主对带引号的 `" x "` 判含空白跳过）——spec 已作为 accepted residual 记下；穷举 omp 其它跳过规则。

`design.md` 省略：compact 级，一个正则字符 + 注释、规格句与一行测试。

## Triage

```text
Issue type: bugfix
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; S, p3)
Level rationale: compact — a one-character tightening of an existing host-side name filter; no format, schema or entrypoint change (the reader keeps its shape, it only rejects one more character omp already rejects).
Blast radius: the skill list (`GET /api/commands`, `classifyPrompt`, regenerate / fork skill alignment); a wrong regex either still lists `a\b` (new case red) or drops valid names (existing listSkills / project-skill cases red)
Selected risk packs: Public API / CLI / script entry (`GET /api/commands` contents and the prompt route's skill classification shrink by names omp never loads; no valid name changes); not selected — Config, File IO / path safety (the directory walk and link rules are untouched), Schema, Auth / secrets, Concurrency, Resource limits, Error handling, Release / packaging
Evidence floor: `npx vitest run --root server test/slash-commands` green incl. the new rows (red before for `back`); `npm test --workspace server`; typecheck; `make check`
```
