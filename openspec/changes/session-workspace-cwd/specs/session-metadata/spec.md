## Purpose
定义会话元数据的服务端契约：创建时可选绑定工作空间与场景（`POST /api/sessions` body）、绑定不可改且决定 omp 工作目录、单一 `PATCH /api/sessions/:id` 修改标题/场景/置顶、同步 `DELETE /api/sessions/:id`（先停止、再退役进程、级联删行、删当前会话文件）、`session.bind`/`session.delete` 审计，以及 fork 对元数据的继承规则。本 change 在 change A（`s1c-turn-control-governance`）之后实施，停止、控制占用与 fork 流程沿用 A 的定义。

## ADDED Requirements

### Requirement: 绑定不可改与工作目录
会话的 `workspace_id` 只在创建时（或 fork 继承时）写入，此后 SHALL NOT 被任何 REST 修改。会话的 omp 工作目录 SHALL 为：绑定时该空间根（经工作空间 store 以会话 `owner_id` 为 principal 的 `rootOf` 取得，落在 `<SANDBOX_ROOT>/<ownerId>/` 之下），未绑定时沿用所有者根 `<SANDBOX_ROOT>/<ownerId>`；该会话每一次 generation spawn（首次、闲置回收后、崩溃恢复、regenerate 重新获取）与以其为源的 fork 临时进程 SHALL 以此为 `--cwd`（chat-sessions「Supervisor dispatch and generation binding」）。绑定会话的 `rootOf` 返回 null 时 SHALL 以通用失败结束该次获取，不回退所有者根。`rootOf` 返回的空间根在获取时不是已存在的目录（被外部删除或改名），或 `rootOf` 因该根存在但不是普通目录（被同名文件占据、含 symlink）而拒绝解析时，宿主 SHALL NOT 创建该目录（不对空间根做 mkdir）、SHALL NOT spawn、SHALL NOT 回退所有者根，该次获取按 `agent_unavailable` 失败（prompt → 502 并走既有受理对补偿；regenerate 按其既有 502 规则）。omp `--resume` 以会话文件头记录的 cwd 为准，故同一会话各 generation 的 cwd SHALL 一致。空间目录丢失后的修复不在本契约内。

#### Scenario: 绑定会话的进程工作目录
- **WHEN** owner 在绑定 W 的会话与一个未绑定会话上各发 prompt，fake-omp probe 报告 `cwd=`
- **THEN** 前者 `cwd` 为 W 的根，后者为 `<SANDBOX_ROOT>/<ownerId>`；闲置回收后再发 prompt，新 generation 报告的 `cwd` 与前一次相同

#### Scenario: 空间目录缺失不回退不创建
- **WHEN** 绑定 W 的会话在下一次 prompt 之前，W 的根目录被应用之外的操作删除
- **THEN** prompt 返回 502 `agent_unavailable`，受理对被补偿、会话状态复原；无子进程 spawn；W 的根目录仍不存在；未以所有者根 spawn
