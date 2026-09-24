# 文件冒烟（files.hurl）：从空 cookie store 独立可运行，不依赖 public/auth/chat。
# 登录 zhangsan → 创建/采用 smoke-fixture（201 或 409）→ 列表按 name 取 id → 树含三文件
# → mkdir out（201 或 409）→ 重复 mkdir 精确 409 → 越界前快照审计 → tree?path=../.. 403
# → 最新审计必须相对快照为新事件且关联本次 workspace/path/op → md/png/csv 预览
# → 登出 → lisi 外账号 404 → 登出，不留下 live authentication session。
# 调用方须先：cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/

# 成功登录：exact 200 Principal + 合规 session cookie。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"zhangsan","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u1","account":"zhangsan","role":"成员"}

# 创建或采用工作空间：仅 201 或 409；id 不从本响应读取。
POST {{base_url}}/api/workspaces
Content-Type: application/json
{"name":"smoke-fixture"}
HTTP *
[Asserts]
status toString matches /^(201|409)$/

# 列表按 name 取唯一 id。
GET {{base_url}}/api/workspaces
HTTP 200
[Captures]
workspace_id: jsonpath "$.workspaces[?(@.name=='smoke-fixture')].id"
[Asserts]
jsonpath "$.workspaces[?(@.name=='smoke-fixture' && count($.workspaces[?(@.name=='smoke-fixture')])==1)]" exists
jsonpath "$.workspaces[?(@.name=='smoke-fixture')].id" exists

# 树的 file 类条目包含三夹具文件。
GET {{base_url}}/api/workspaces/{{workspace_id}}/tree
HTTP 200
[Asserts]
jsonpath "$.entries[?(@.name=='readme.md' && @.type=='file')]" exists
jsonpath "$.entries[?(@.name=='notes.csv' && @.type=='file')]" exists
jsonpath "$.entries[?(@.name=='logo.png' && @.type=='file')]" exists

# 首次或重跑建目录：仅 201 或 409。
POST {{base_url}}/api/workspaces/{{workspace_id}}/dirs
Content-Type: application/json
{"path":"out"}
HTTP *
[Asserts]
status toString matches /^(201|409)$/

# 故意重复建目录：精确 409 conflict。
POST {{base_url}}/api/workspaces/{{workspace_id}}/dirs
Content-Type: application/json
{"path":"out"}
HTTP 409
{"error":{"code":"conflict","message":"同名资源已存在"}}

# 越界前快照属主最新审计（含空 events）。
GET {{base_url}}/api/audit?limit=1
HTTP 200
[Captures]
audit_before: body

# 字面 path=../.. 必须原样到达服务：403 sandbox_denied。
GET {{base_url}}/api/workspaces/{{workspace_id}}/tree?path=../..
HTTP 403
{"error":{"code":"sandbox_denied","message":"目标路径不在你的沙箱内，操作已拒绝"}}

# 最新审计必须相对快照为新事件，且 kind/workspace/relPath/op 关联本次请求。
GET {{base_url}}/api/audit?limit=1
HTTP 200
[Asserts]
body != "{{audit_before}}"
jsonpath "$.events" count == 1
jsonpath "$.events[0].kind" == "sandbox.reject"
jsonpath "$.events[0].actorId" == "u1"
jsonpath "$.events[0].workspaceId" == "{{workspace_id}}"
jsonpath "$.events[0].detail.relPath" == "../.."
jsonpath "$.events[0].detail.op" == "list"

# readme.md 预览：200 精确字节 + text/plain utf-8 + nosniff。
GET {{base_url}}/api/workspaces/{{workspace_id}}/file?path=readme.md
HTTP 200
[Asserts]
header "Content-Type" == "text/plain; charset=utf-8"
header "X-Content-Type-Options" == "nosniff"
file,fixtures/sandbox/u1/smoke-fixture/readme.md;

# logo.png 预览：200 image/png。
GET {{base_url}}/api/workspaces/{{workspace_id}}/file?path=logo.png
HTTP 200
[Asserts]
header "Content-Type" == "image/png"
file,fixtures/sandbox/u1/smoke-fixture/logo.png;

# notes.csv 预览：200。
GET {{base_url}}/api/workspaces/{{workspace_id}}/file?path=notes.csv
HTTP 200
[Asserts]
header "Content-Type" == "text/plain; charset=utf-8"
file,fixtures/sandbox/u1/smoke-fixture/notes.csv;

# 本账号登出：exact 204 + clear cookie。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""

# 他账号登录。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"lisi","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u3","account":"lisi","role":"管理员"}

# 外账号读该工作空间树：exact 404 not_found。
GET {{base_url}}/api/workspaces/{{workspace_id}}/tree
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# 他账号登出。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""
