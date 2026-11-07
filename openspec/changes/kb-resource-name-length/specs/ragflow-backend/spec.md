## MODIFIED Requirements

### Requirement: 嵌入模型更换与全量重建
嵌入身份 SHALL 为 `(name, baseUrl)`；只改密钥不是身份变化。

`PUT /api/kb/settings` 改变嵌入身份且存在任一知识库时，按次序判定：
1. 已有知识库处于 `rebuilding`：SHALL 409 `kb_rebuilding`，带不带 `confirmRebuild` 都一样，先于 `kb_rebuild_required`。
2. body 未带 `confirmRebuild:true`：SHALL 409 `kb_rebuild_required`，不下发，不保存。
3. body 带了：下发并保存；嵌入代数加一；全部知识库置为 `rebuilding`；`kb_settings.rebuild_actor_id` 记为本次请求的 principal；在同一事务里审计 `kb.settings` 与 `kb.rebuild`（detail `{bases, documents}`）两条；唤醒重建器。

**重建器**在进程内一次处理一个知识库，处理期间持有该库的写锁（见 knowledge-bases「同一知识库的写操作串行」）。取得锁后先重读该库的行：库已被删除或 `state` 不再是 `rebuilding` 即跳过该库。每个库的步骤：
1. 若 `rebuild_dataset_id` 非空，先按 knowledge-bases「知识库端点」的删除次序删掉残留的一代；不存在视为已删除；再把三个 `rebuild_*` 列置空。
2. 以原模板与开关、新嵌入模型，按 knowledge-bases「知识库端点」的建库流程建新一代，名为 `owb-<id 前 16 位>-g<当前代数>`（命名规则见 knowledge-bases「知识库端点」），写回 `rebuild_dataset_id`；开了开关的库另写回 `rebuild_canvas_id`、`rebuild_template_group_id`。模板组与画布 SHALL 新建，不复用旧的。账号缺省缺失时开了开关的库在这一步失败，不发后续请求。
3. 逐份文档，从旧数据集流式下载入库原件，上传到新数据集，再触发这份文档的解析。multipart 长度按本地 `size` 计算。下载结果为 not-found 的文档记为跳过；下载字节数与本地 `size` 不符、或解析未启动时该库失败。
4. 在单事务里完成切换：删除被跳过的文档行；其余行换成新的 RAGFlow 文档 id；`dataset_id`、`canvas_id`、`template_group_id` 设为对应的 `rebuild_*` 值，三个 `rebuild_*` 列置空；`embedding_generation` 设为当前代数；`state` 置为 `ready`；审计 `kb.rebuild`（detail `{id, result:"ok", skipped}`）。
5. 按同一删除次序删除旧一代。数据集删除失败写一行 `{"event":"kb_dataset_leak","datasetId":<id>}`，SHALL NOT 再删它的画布与模板组；画布或模板组删除失败写一行 `{"event":"kb_pipeline_leak","canvasId":<id|null>,"groupId":<id|null>}`，模板组删除失败时画布已删，`canvasId` 为 `null`。都不影响状态。

**下载判别**：not-found 也是 HTTP 200，文件内容可以恰好等于 not-found 正文。下载应答 SHALL 按响应头判定，不解析正文判成败：
- HTTP 200 且带 `Content-Disposition`：文件字节，正文一律不解析，不看 `Content-Type`、`Content-Length` 与文件后缀。
- HTTP 200 且不带 `Content-Disposition`：按 JSON 解析，body `code` 为 404 是 not-found，其余按「RAGFlow 出站请求」的通用行判定。
- 非 200：按通用行判定。

任一步失败 SHALL 置 `rebuild_failed`（`state_message` 为 `重建失败，可在模型设置里重试`），并审计 `kb.rebuild`（detail `{id, result:"failed"}`）。重建器写的审计 actor 为 `kb_settings.rebuild_actor_id`。

**续做与关停**：
- 服务在 `server_started` 之后，不等待地对仍为 `rebuilding` 的库从第一步续做；续做中的失败只改变知识库状态，不输出 failure record，不改变退出码。
- 关停时重建器在关闭 DB 之前停止，在途请求被中止。第 4 步提交之前，该库保持 `rebuilding`，下次启动续做。第 4 步提交之后，库已是 `ready`，第 5 步没删完的旧一代 SHALL NOT 续删，成为孤儿。
- 未配置 `RAGFLOW_BASE_URL` 时重建器不启动，`rebuilding` 的库保持原状，SHALL NOT 改成 `rebuild_failed`；重新配置后，下次启动续做。

**重试**：`POST /api/kb/settings/rebuild`（管理员，bodyless）SHALL 把全部 `rebuild_failed` 置回 `rebuilding`，把 `rebuild_actor_id` 记为本次请求的 principal，审计 `kb.rebuild`（detail `{bases, documents, retry:true}`），唤醒重建器，返回 200 加设置读视图。没有 `rebuild_failed` 的库时返回 200，不写审计。

#### Scenario: 未确认不保存
- **WHEN** 已有一个知识库，管理员 `PUT` 一个新的嵌入名称，不带 `confirmRebuild`
- **THEN** 409 `kb_rebuild_required`；设置不变；假 RAGFlow 没有收到模型下发

#### Scenario: 确认后重建
- **WHEN** 有两个知识库共三份文档，管理员带 `confirmRebuild:true` 换嵌入模型
- **THEN** 假 RAGFlow 依次收到：两次建数据集（名为 `owb-<id 前 16 位>-g1`）、三次下载、三次上传与三次解析触发、两次删除旧数据集；两个知识库最终都是 `ready`，`dataset_id` 为新数据集，文档的 RAGFlow id 为新 id；审计含一条 `kb.settings`、一条 `{bases:2, documents:3}` 与两条 `result:"ok"`，actor 都是该管理员

#### Scenario: 开编译的库重建
- **WHEN** 一个开了两种编译的知识库，管理员带 `confirmRebuild:true` 换嵌入模型
- **THEN** 假 RAGFlow 为新一代依次收到读账号缺省、读内置模板、建模板组、读内置 pipeline、建画布与建数据集（`pipeline_id` 为新画布），都名为 `owb-<id 前 16 位>-g1`；切换之后依次收到删旧数据集、删旧画布、删旧模板组；库行的三个 id 都是新一代，三个 `rebuild_*` 列为 NULL

#### Scenario: 账号缺省缺失时重建失败
- **WHEN** 一个开了 RAPTOR 的知识库重建，假 RAGFlow 的 `GET /api/v1/models/default` 应答 `models` 为空
- **THEN** 该库 `rebuild_failed`，审计 `kb.rebuild {id, result:"failed"}`；假 RAGFlow 没有收到建模板组、建画布与建数据集

#### Scenario: 旧一代删除失败
- **WHEN** 重建切换之后，假 RAGFlow 对删旧数据集应答 HTTP 503；另一次对删旧画布应答 HTTP 503；再一次对删旧模板组应答 HTTP 503
- **THEN** 第一次 stderr 恰一行 `kb_dataset_leak`，没有发出删画布与删模板组；第二次恰一行 `kb_pipeline_leak`，`canvasId` 与 `groupId` 都非空，没有发出删模板组；第三次恰一行 `kb_pipeline_leak`，`canvasId` 为 `null`、`groupId` 非空；三次该库都是 `ready`

#### Scenario: 原件缺失与下载判别
- **WHEN** 一个知识库有三份文档：第一份下载应答 HTTP 200、不带 `Content-Disposition`、`Content-Type` 为 JSON、正文 `{"code":404,"message":"Resource not found"}`；第二份下载应答 HTTP 200、带 `Content-Disposition`，文件内容恰为同一段正文；第三份的下载字节比本地 `size` 少一个字节（在另一次重建里）
- **THEN** 第一次重建 `ready`：第一份的行已删除，`kb.rebuild` 的 `skipped` 恰为它的文档 id，第二份作为文件上传且字节不变，multipart 长度按本地 `size` 计算；另一次重建该库为 `rebuild_failed`

#### Scenario: 不带头的错误应答
- **WHEN** 重建中一份文档的下载应答 HTTP 200、不带 `Content-Disposition`、正文 `{"code":500,"message":"Failed to download document"}`
- **THEN** 该库 `rebuild_failed`；假 RAGFlow 没有收到这份内容的上传

#### Scenario: 中途失败与重试
- **WHEN** 重建第二个知识库时假 RAGFlow 的上传返回 HTTP 500；随后假 RAGFlow 恢复，管理员 `POST /api/kb/settings/rebuild`
- **THEN** 第一个库 `ready`；第二个库 `rebuild_failed`，对它入库得 409 `kb_rebuilding`，移出文档仍可成功；重试返回 200 读视图，第二个库先删残留的新数据集再重建，最终 `ready`

#### Scenario: 重建中改嵌入身份
- **WHEN** 一个知识库处于 `rebuilding`，管理员 `PUT` 新的嵌入名称，不带 `confirmRebuild`；再带 `confirmRebuild:true`；再只换 `apiKey`
- **THEN** 前两次都是 409 `kb_rebuilding`，假 RAGFlow 没有收到下发，设置不变；第三次 200，照常下发

#### Scenario: 没有失败库时重试
- **WHEN** 没有 `rebuild_failed` 的知识库，管理员 `POST /api/kb/settings/rebuild`
- **THEN** 200 读视图；没有 `kb.rebuild` 审计，`rebuild_actor_id` 不变，假 RAGFlow 收到零个请求

#### Scenario: 崩溃后续做
- **WHEN** 一个知识库处于 `rebuilding`、`rebuild_dataset_id` 非空时进程退出，随后重启
- **THEN** 重启后重建器先删除该残留数据集，再从建新数据集开始，最终 `ready`；这一条 `kb.rebuild` 的 actor 为原发起人

#### Scenario: 编译库的残留清理
- **WHEN** 一个开了 RAPTOR 的知识库处于 `rebuilding`，三个 `rebuild_*` 列都非空时进程退出，随后重启
- **THEN** 重启后假 RAGFlow 先依次收到残留一代的删数据集、删画布、删模板组，再收到新一代的建库序列；最终 `ready`

#### Scenario: 关停时在途重建
- **WHEN** 重建器在下载或上传时被挂起，服务收到 SIGTERM；另一次重建器已完成切换，在删旧一代时被挂起，服务收到 SIGTERM
- **THEN** 两次进程都以 0 退出，在途请求被中止，DB 已关闭；第一次该库仍为 `rebuilding`，重启后续做；第二次该库为 `ready`，重启后假 RAGFlow 没有收到旧一代的删除

#### Scenario: 续做失败不影响进程
- **WHEN** 一个知识库处于 `rebuilding`，重启时 RAGFlow 不可达
- **THEN** 启动成功，success record 照常写出，没有 failure record，退出码不变；该库 `rebuild_failed`

#### Scenario: 知识库关闭时不动重建状态
- **WHEN** 一个知识库处于 `rebuilding`，服务以未配置 `RAGFLOW_BASE_URL` 启动，随后以配置了的状态重启
- **THEN** 第一次启动后该库仍为 `rebuilding`，没有 `kb.rebuild` 审计；第二次启动后续做，最终 `ready`
