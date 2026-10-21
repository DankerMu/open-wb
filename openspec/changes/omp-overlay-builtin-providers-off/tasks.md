# Tasks — omp-overlay-builtin-providers-off (#1621)

Fixture level: expanded. Risk packs: selected — Config（固定块字节契约）、Security（出网边界）、Public API（托管 provider 与项目 skills 的可见性不变）；not selected — 见 proposal Triage。

Must preserve: overlay 其余键与次序不变；`workbuddy/<id>` 照常可用；能力发现源一个不关（项目 skills、`AGENTS.md` 照常）；spawn env 不变；omp 二进制不变。

- [ ] 1.1 开工核对（按 tag `v18.12.3` 源码复核）：重新生成 design D1 的名单（KDL 条目 id ∪ bundled `models.json` provider id ∪ `llama.cpp`/`apple`，减去 `cursor`、`local`、`web`），与 spec delta 里的 87 项逐项比对；列出全部能力发现源 id 并确认与名单无交集；复核 `model-registry.ts:215-220,2383-2393,2428-2433,2471-2486`。出入先改本 fixture（spec delta 名单、design D1）再继续。复核过程与结果存 `.workplans/1621/evidence/list-derivation.md`（可引用本机只读源码树，但被跟踪文件只引 tag `v18.12.3`）。
- [ ] 1.2 先写官方用例（design D3），在当前四项 overlay 上跑：产品形态应看到 `CONNECT`（红），记录命中主机。
- [ ] 1.3 改 `server/src/sessions/omp/host-overlay.ts`（design D4）：名单常量 + 渲染 + 文件头注释；更新受影响的字节断言测试。
- [ ] 1.4 重跑官方用例：产品 overlay 零 `CONNECT`、`workbuddy/<id>` 与 `skill:x` 在；负对照（四项）≥1 个 `CONNECT` 且含 `catalog.stencil.so:443`。连跑 3 次。
- [ ] 1.5 文档：ADR-0012 在 `disabledProviders` 条目后加「2026-10-21 补充，#1621」（裁定、规则与排除项、实测、残余：marketplace 自动更新、带凭证路径靠升级时重新生成、名单可能不全）；`docs/architecture/system.md` 9.8 的 overlay YAML 块、表格 `disabledProviders` 行与相关实测行同步。
- [ ] 1.6 验证：`WORKBUDDY_OMP_TEST=1 OMP_BIN=$PWD/var/omp/omp npx vitest run --root server --no-file-parallelism test/omp-official-` 全绿；`npx vitest run --root server test/omp-host-overlay test/server-startup-overlay` ×3；`npm test --workspace server`；`make check`；`bash scripts/size-guard.sh`；`git diff --stat` 只含 change 目录、`host-overlay.ts`、受影响测试、ADR-0012、`system.md`。
