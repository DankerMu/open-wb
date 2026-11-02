# 知识库真实端点冒烟（kb.hurl）：只由 `make smoke-kb` 运行，对象是调用方已运行、已接上共用 RAGFlow 栈的服务
# （verification-harness「知识库真实端点冒烟」；change s2a-kb-ragflow 组 18）。从空 cookie store 独立可运行。
# 登录 zhangsan → 状态三位全真 → 采用夹具工作空间 smoke-kb（201 或 409）→ 列表按 name 取 id
# → 建 naive 库 smoke-kb → 从工作空间入库 notes.md 与 brief.pdf → 轮询到两份都 done 且切片数大于 0
# → 本地上传一个文本文件 → 轮询到它也 done → 移出它 → 列表只剩两份 → 删库
# → 建 naive 库 smoke-kb-compile（raptor 与 graph 都为真）→ 入库 notes.md → 轮询库列表到两种编译都 done → 删库
# → 库列表不含这两个库 → 登出。开编译的一段是 DSL 对真实 RAGFlow 的唯一验证。
#
# 端点与写法（读代码得出）：
# - `GET /api/kb/status` → 200 `{enabled, available, embeddingReady, compileReady, …}`（server/src/kb/rest.ts `statusOf`）。
# - `POST /api/kb/bases` body 只认 `name`、`template`、`raptor`、`graph`（server/src/kb/bases.ts `BODY_KEYS`），201 `BaseView`
#   `{id, name, template, raptor, graph, state, stateMessage, documents, compile, createdAt}`；新库开着的编译为 `pending`，
#   关着的为 `off`（`createdCompile`）。`GET /api/kb/bases` → 200 `{bases: BaseView[]}`；`DELETE /api/kb/bases/:id` → 204。
# - `POST /api/kb/bases/:id/documents` body 只认 `workspaceId`、`paths`（server/src/kb/documents.ts `BODY_KEYS`），
#   201 `{documents, rejected}`；`GET …/documents` → 200 `{documents: DocumentView[]}`，`status` 为 `done` 时才带
#   `chunkCount`；`DELETE …/documents?doc=<文档 id>` → 204。
# - `POST /api/kb/bases/:id/uploads?name=<文件名>`：裸 `application/octet-stream`，文件名走查询参数，不是 multipart
#   （server/src/kb/rest.ts `UPLOADS_ROUTE`、server/src/kb/uploads.ts `parseUploadFileName`），201 `DocumentView`。
# - 工作空间：同 smoke/files.hurl，`POST /api/workspaces {"name":"smoke-kb"}` 采用已复制进来的目录，再按 name 取 id。
#
# 轮询：`poll_retries` 由 Makefile 从 SMOKE_KB_POLL_SECONDS（缺省 300）按 5 s 一次折算，每段轮询各自计时；单次请求的
# 耗时不计入，所以上限是近似值。被移出的是上传的那份：它已 done，移出不会遇到停止解析中的 409。
# 中途失败留下的库由 Makefile 随后执行的 smoke/kb-cleanup.hurl 删除。
# 调用方须先：cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/

# 登录：同 smoke/chat.hurl。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"zhangsan","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u1","account":"zhangsan","role":"成员"}

# 状态：版本对、嵌入模型与知识库对话模型都已配置。
GET {{base_url}}/api/kb/status
HTTP 200
[Asserts]
jsonpath "$.enabled" == true
jsonpath "$.available" == true
jsonpath "$.embeddingReady" == true
jsonpath "$.compileReady" == true

# 采用夹具工作空间：仅 201 或 409；id 不从本响应读取。
POST {{base_url}}/api/workspaces
Content-Type: application/json
{"name":"smoke-kb"}
HTTP *
[Asserts]
status toString matches /^(201|409)$/

# 列表按 name 取唯一 id。
GET {{base_url}}/api/workspaces
HTTP 200
[Captures]
workspace_id: jsonpath "$.workspaces[?(@.name=='smoke-kb')].id"
[Asserts]
jsonpath "$.workspaces[?(@.name=='smoke-kb' && count($.workspaces[?(@.name=='smoke-kb')])==1)]" exists
jsonpath "$.workspaces[?(@.name=='smoke-kb')].id" exists

# 建 naive 库 smoke-kb，两个编译开关都关。
POST {{base_url}}/api/kb/bases
Content-Type: application/json
{"name":"smoke-kb","template":"naive","raptor":false,"graph":false}
HTTP 201
[Captures]
kb_id: jsonpath "$.id"
[Asserts]
jsonpath "$.name" == "smoke-kb"
jsonpath "$.template" == "naive"
jsonpath "$.state" == "ready"
jsonpath "$.documents" == 0
jsonpath "$.compile.raptor" == "off"
jsonpath "$.compile.graph" == "off"

# 从工作空间入库两份：都受理，没有被拒的条目。
POST {{base_url}}/api/kb/bases/{{kb_id}}/documents
Content-Type: application/json
{"workspaceId":"{{workspace_id}}","paths":["notes.md","brief.pdf"]}
HTTP 201
[Asserts]
jsonpath "$.documents" count == 2
jsonpath "$.rejected" count == 0
jsonpath "$.documents[?(@.path=='notes.md')].source" == "workspace"
jsonpath "$.documents[?(@.path=='brief.pdf')].source" == "workspace"

# 轮询文档列表：两份都 done 且切片数大于 0。
GET {{base_url}}/api/kb/bases/{{kb_id}}/documents
[Options]
retry: {{poll_retries}}
retry-interval: 5000
HTTP 200
[Asserts]
jsonpath "$.documents" count == 2
jsonpath "$.documents[?(@.status=='done' && @.chunkCount > 0)]" count == 2

# 本地上传一个文本文件。
POST {{base_url}}/api/kb/bases/{{kb_id}}/uploads?name=smoke-kb-upload.txt
Content-Type: application/octet-stream
```
smoke-kb upload: the South Harbor dispatch desk lights the fog lamp when visibility drops below five hundred meters.
```
HTTP 201
[Captures]
upload_id: jsonpath "$.id"
[Asserts]
jsonpath "$.name" == "smoke-kb-upload.txt"
jsonpath "$.source" == "upload"
jsonpath "$.status" == "queued"

# 轮询到上传的那份也 done 且切片数大于 0。
GET {{base_url}}/api/kb/bases/{{kb_id}}/documents
[Options]
retry: {{poll_retries}}
retry-interval: 5000
HTTP 200
[Asserts]
jsonpath "$.documents" count == 3
jsonpath "$.documents[?(@.status=='done' && @.chunkCount > 0)]" count == 3

# 移出上传的那份。
DELETE {{base_url}}/api/kb/bases/{{kb_id}}/documents?doc={{upload_id}}
HTTP 204

# 列表只剩工作空间来源的两份。
GET {{base_url}}/api/kb/bases/{{kb_id}}/documents
HTTP 200
[Asserts]
jsonpath "$.documents" count == 2
jsonpath "$.documents[?(@.source=='workspace')]" count == 2

# 删库。
DELETE {{base_url}}/api/kb/bases/{{kb_id}}
HTTP 204

# 建开编译的 naive 库 smoke-kb-compile：两种编译新建时都是 pending。
POST {{base_url}}/api/kb/bases
Content-Type: application/json
{"name":"smoke-kb-compile","template":"naive","raptor":true,"graph":true}
HTTP 201
[Captures]
compile_id: jsonpath "$.id"
[Asserts]
jsonpath "$.name" == "smoke-kb-compile"
jsonpath "$.raptor" == true
jsonpath "$.graph" == true
jsonpath "$.state" == "ready"
jsonpath "$.compile.raptor" == "pending"
jsonpath "$.compile.graph" == "pending"

# 入库 Markdown 文件。
POST {{base_url}}/api/kb/bases/{{compile_id}}/documents
Content-Type: application/json
{"workspaceId":"{{workspace_id}}","paths":["notes.md"]}
HTTP 201
[Asserts]
jsonpath "$.documents" count == 1
jsonpath "$.rejected" count == 0

# 轮询库列表：该库两种编译都 done（单独计时）。
GET {{base_url}}/api/kb/bases
[Options]
retry: {{poll_retries}}
retry-interval: 5000
HTTP 200
[Asserts]
jsonpath "$.bases[?(@.id=='{{compile_id}}' && @.compile.raptor=='done' && @.compile.graph=='done')]" exists

# 删库。
DELETE {{base_url}}/api/kb/bases/{{compile_id}}
HTTP 204

# 库列表不含这两个库。
GET {{base_url}}/api/kb/bases
HTTP 200
[Asserts]
jsonpath "$.bases[?(@.name=='smoke-kb' || @.name=='smoke-kb-compile')]" not exists

# 登出：exact 204 + clear cookie。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""
