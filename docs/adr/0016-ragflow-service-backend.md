# 知识库以运行中的 RAGFlow 服务为后端，取代 ADR-0002

[ADR-0002](0002-absorb-ragflow-into-kb-service.md)（2026-08-29）定的是吸收 RAGFlow v0.27.1 的 Python 线进本仓 `kbservice/`，S2a 先做 spike；
不整机部署的理由是 RAGFlow 的多租户、前端与 API 层同 app-server 职责重叠。2026-10-28 grill 由 owner 逐分支重议了这条路
（change `s2a-kb-ragflow` design「Grill 结论」第 1、5、6、10、11 行；逐条理由在该 change 的 D1–D5、D7、D16）。

决定（owner，2026-10-28）：

1. **知识库以运行中的 RAGFlow 服务为后端，取代 ADR-0002。** RAGFlow 作为外部服务部署，解析、切片、嵌入、检索与切片存储都在它里面；
   本仓不吸收其源码。吸收 spike 随之作废，换成该 change 组 1 对 rc2 接口的实测。
2. **app-server 的 `kb` 模块直连 RAGFlow 的 HTTP API，`kbservice/` 退役。** 租户、可见范围与审计仍全在 app-server（`PLAN.md` §2 决策 3）；
   知识库的阶段交付见 `PLAN.md` §4 P2。agentic 环放 app-server 还是用 RAGFlow 自带能力由 S2b 定，本 ADR 不定（2026-11-07 已定：由 omp 模型驱动，见 ADR-0017）。

理由：

- **v1.0 的 Go 重写与资源占用。** ADR-0002 评估时 Go 线还是开发中的重写（`resource/backend-research.md` §1）；v1.0 起服务端已是 Go，Python `api/` 层不复存在，
  吸收 v0.27.1 的 Python 线等于停在上游服务端已经离开的代码上。资源占用大幅下降是 grill 时的判断，本仓没有测量，部署门槛不据此定（见后果）。
- **rc2 的 arm64 镜像。** `infiniflow/ragflow:v1.0.0-rc2` 是多架构镜像，rc1 与 v0.27.x 只有 amd64；arm64 开发机能跑 RAGFlow 原生镜像，不必为知识库另起 x86 环境。Infinity 不在此列：2026-11-01 部署实测 `v0.7.4-arm64`、`v0.7.3-arm64`、`nightly-arm64` 三个 tag 都因二进制要 glibc 2.38 而底座是 Ubuntu 22.04 无法启动，开发机上它走 `linux/amd64` 模拟（`v0.7.4-x64-v2`），生产按 x86 部署不受影响。
- **多租户留在 app-server。** ADR-0002 否决整机部署的根本理由是多租户必须自研。把 RAGFlow 当作只有一个服务账号的后端，这一条不再挡路：
  它的多租户与前端不启用，职责重叠不需要靠吸收源码来回避。

上述 rc2 事实来自 2026-10-28 读 `v1.0.0-rc2` tag 源码与 HTTP 参考文档；对运行实例的逐条复核是该 change 组 1 的产物。

## Consequences

- **单一服务账号；密钥文件。** 整个服务只用一个 RAGFlow 账号的 API key，知识库与 RAGFlow 数据集、文档的映射存 SQLite，所有权与可见性只在 app-server 判定。
  key 经 `RAGFLOW_API_KEY_FILE` 从属主为本进程 uid、mode `0600` 的普通文件读入，只留在 `kb` 模块的闭包里，不写日志、审计、响应，不进任何子进程环境；
  密钥值因此不进 `/proc/<pid>/environ`。文件路径仍在环境里：同 uid 部署（`OMP_USER` 未配置）时 omp 能读到路径并以同 uid 读文件，这与 S0b 已登记的同 uid 风险是同一项，
  按 ADR-0010 的专用 uid 部署关闭。`CONTEXT.md` 不变量 4 相应改为「RAGFlow API 密钥与模型网关密钥不得出现在 omp 子进程可读环境」。
- **RAGFlow 持有嵌入与知识库对话模型的上游密钥（与 ADR-0008 的区别）。** 知识库嵌入模型全局唯一，存在 `kb_settings`、不进 `models` 表；知识库对话模型引用 `models` 的一行。
  两者都由 app-server 下发到服务账号，上游密钥因此也存在 RAGFlow 的库里，RAGFlow 的数据目录与备份要按密钥对待。这与 ADR-0008 不冲突：0008 约束的是 omp 环境零网关凭证，
  RAGFlow 不是 omp；但「真密钥只在 app-server」对这两类模型不成立，RAGFlow 的调用也不经模型代理。轮换经联动同步：知识库开启期间，改被指定的对话模型的上游或密钥时先重新下发，下发失败则该次修改失败；该模型也不能删、不能清空上游（409 `kb_model_in_use`），
  引用判定、重新下发与 `models` 的写入在同一次设置锁内。知识库关闭期间不联动，已下发的副本不撤销，重新开启后管理员保存一次知识库模型设置即覆盖。
  取消指定知识库对话模型同样不撤销：只改本地，账号缺省仍指向已下发的配置，上游密钥留在 RAGFlow 里，直到下一次下发覆盖或运维清理；取消指定之后再删除那一行 `models` 也不同步。清空账号缺省会让全栈唯一的入库进程崩溃循环，所以 app-server 不做这一步。
- **RAGFlow 不对用户网络暴露。** 这个 key 能读写全部账号的知识库，部署时 RAGFlow 留在服务侧内网，不对用户网络开放。omp 的 bash 能直连本机端口，但没有 key 就调不动鉴权接口；
  `/system/version` 无鉴权，暴露的只有版本串。
- **S4b 带 RAGFlow 全栈。** 单机部署包带 RAGFlow 全栈，部署主机要有 Docker，内存门槛以 RAGFlow 官方要求为准，本 ADR 不写定数字；文档存储用 Infinity，经 `DOC_ENGINE` 配置（ADR-0005 2026-11-01 补充）。
  Apache-2.0 / NOTICE 义务随部署包：发行物含 RAGFlow 镜像时附其 LICENSE 与 NOTICE（`ATTRIBUTION.md` §3）。栈的打包与运维脚本属 S4b；此前本仓不提交任何 RAGFlow 栈定义，
  开发期只复用共用栈，不 up、不 down、不改配置，CI 打假 RAGFlow（design D16、D17）。
- **版本钉住 `v1.0.0-rc2`。** rc2 是预发行版。`GET /api/kb/status` 比对版本串，不符时知识库显示为不可用；升级 RAGFlow 是一次代码变更，要重跑接口实测与真实端点冒烟，与 omp 钉版同一纪律（ADR-0001）。
- **回滚。** 去掉 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY_FILE` 即关闭知识库，RAGFlow 里的 `owb-` 数据集由运维按需清理；`kbservice/` 的删除不能由配置回退，需要时从 git 历史恢复。

## Considered Options

- **吸收源码（ADR-0002 原方案）**——要背 Python 3.13 依赖面、重写 `api.db` 耦合层、做 deepdoc 模型本地化，还要自己跟进上游切片与检索的修复，而这些吸收的是上游服务端已经离开的 v0.27.1 代码；
  收益只是不跑一个外部服务，RAGFlow 的多租户又可以靠单一服务账号避开。弃。
- **保留 `kbservice/` 作薄适配层**——多一个进程、一套 Python 工具链和一条跨服务契约，换来的只是把 HTTP 调用挪个地方。弃；S2b 的 agentic 环若需要代码，届时按 S2b 的结论放。
