# 文件冒烟（files.hurl）：从空 cookie store 独立可运行，不依赖 public/auth/chat。
# 登录 zhangsan → 创建/采用 smoke-fixture（201 或 409）→ 列表按 name 取 id → 树含三文件
# → mkdir out（201 或 409）→ 重复 mkdir 精确 409 → 越界前快照审计 → tree?path=../.. 403
# → 最新审计必须相对快照为新事件且关联本次 workspace/path/op → md/png/csv 预览
# → 上传 smoke-upload.txt 201 → 同名再传 201 且自动编号 → tree?path=uploads 列出两者
# → 越界名 ../escape.txt 403 且入审计 → application/json 上传 400
# → clip.wav 范围请求 206 → readme.md 附件下载 → 签发 preview-token
# → 隔离来源的 site/index.html（text/html + CSP sandbox）与 site/style.css → 伪造令牌 404
# → 主站对同一 html 仍是 text/plain
# → 登出 → lisi 外账号读树、下载、签发 preview-token、上传共四个 404 → 登出，
# 不留下 live authentication session。
# 上传的文件留在正式空间 uploads/ 里不清理，所以编号不写死，重跑稳定。
# 范围请求起的各步只读：不建不删条目；每跑一次多一条 file.download 审计，不清理。
# 预览来源的地址只取自签发响应的 base，本文件不写主机名与端口。
# 本文件只看响应头与字节，下面两件事不在它的证明范围内：预览来源不依赖 cookie
# （证据在 server/test/preview-app.test.ts）；浏览器里的不透明来源与 iframe 行为（要真实浏览器）。
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

# 上传 9 个内联字节：201，name 为原名或其编号形式，path 在 uploads/ 下，size 为所发字节数。
POST {{base_url}}/api/workspaces/{{workspace_id}}/uploads?name=smoke-upload.txt
Content-Type: application/octet-stream
hex,776f726b6275646479;
HTTP 201
[Captures]
upload_first: jsonpath "$.name"
[Asserts]
jsonpath "$.name" matches /^smoke-upload( \(\d+\))?\.txt$/
jsonpath "$.path" == "uploads/{{upload_first}}"
jsonpath "$.size" == 9

# 同名再传：201，自动编号，name 与第一次不同（不写死编号，重跑得到更大的编号）。
POST {{base_url}}/api/workspaces/{{workspace_id}}/uploads?name=smoke-upload.txt
Content-Type: application/octet-stream
hex,776f726b6275646479;
HTTP 201
[Captures]
upload_second: jsonpath "$.name"
[Asserts]
jsonpath "$.name" matches /^smoke-upload \(\d+\)\.txt$/
jsonpath "$.name" != "{{upload_first}}"
jsonpath "$.size" == 9

# uploads 目录树列出两次上传的文件。
GET {{base_url}}/api/workspaces/{{workspace_id}}/tree?path=uploads
HTTP 200
[Asserts]
jsonpath "$.entries[?(@.name=='{{upload_first}}' && @.type=='file')]" exists
jsonpath "$.entries[?(@.name=='{{upload_second}}' && @.type=='file')]" exists

# 越界上传前快照属主最新审计。
GET {{base_url}}/api/audit?limit=1
HTTP 200
[Captures]
upload_audit_before: body

# 字面 name=../escape.txt 必须原样到达服务：403 sandbox_denied。
POST {{base_url}}/api/workspaces/{{workspace_id}}/uploads?name=../escape.txt
Content-Type: application/octet-stream
hex,776f726b6275646479;
HTTP 403
{"error":{"code":"sandbox_denied","message":"目标路径不在你的沙箱内，操作已拒绝"}}

# 最新审计必须相对快照为新事件，且 kind/workspace/relPath/op 关联本次上传。
GET {{base_url}}/api/audit?limit=1
HTTP 200
[Asserts]
body != "{{upload_audit_before}}"
jsonpath "$.events" count == 1
jsonpath "$.events[0].kind" == "sandbox.reject"
jsonpath "$.events[0].actorId" == "u1"
jsonpath "$.events[0].workspaceId" == "{{workspace_id}}"
jsonpath "$.events[0].detail.relPath" == "uploads/../escape.txt"
jsonpath "$.events[0].detail.op" == "write"

# 以 application/json 上传：exact 400 bad_request。
POST {{base_url}}/api/workspaces/{{workspace_id}}/uploads?name=smoke-upload.txt
Content-Type: application/json
{}
HTTP 400
{"error":{"code":"bad_request","message":"请求格式不正确"}}

# 范围请求：clip.wav 的头 4 个字节，206 + Content-Range；总长不写死，字节为 RIFF。
GET {{base_url}}/api/workspaces/{{workspace_id}}/file?path=clip.wav
Range: bytes=0-3
HTTP 206
[Asserts]
header "Content-Type" == "audio/wav"
header "Content-Range" startsWith "bytes 0-3/"
bytes count == 4
bytes == hex,52494646;

# 下载 readme.md：200 附件，精确字节。写一条 file.download 审计，故不落在上面两段「快照 → 断言」之间。
GET {{base_url}}/api/workspaces/{{workspace_id}}/download?path=readme.md
HTTP 200
[Asserts]
header "Content-Type" == "application/octet-stream"
header "Content-Disposition" startsWith "attachment"
file,fixtures/sandbox/u1/smoke-fixture/readme.md;

# 签发预览令牌：不带 body（带 body 即 400）。base 形如 <来源>/w/<64 位十六进制>/，
# 形状不符则 preview_origin 捕获失败；base 不得落在主站来源之下（末尾的 / 防端口前缀误判）。
POST {{base_url}}/api/workspaces/{{workspace_id}}/preview-token
HTTP 200
[Captures]
preview_base: jsonpath "$.base"
preview_origin: jsonpath "$.base" regex /^(https?:\/\/[^\/]+)\/w\/[0-9a-f]{64}\/$/
[Asserts]
jsonpath "$.base" not startsWith "{{base_url}}/"

# 隔离来源的 html：text/html，CSP 含 sandbox 且不含 allow-same-origin，不下发 cookie，精确字节。
GET {{preview_base}}site/index.html
HTTP 200
[Asserts]
header "Content-Type" == "text/html; charset=utf-8"
header "Content-Security-Policy" contains "sandbox"
header "Content-Security-Policy" not contains "allow-same-origin"
header "Referrer-Policy" == "no-referrer"
header "Set-Cookie" not exists
file,fixtures/sandbox/u1/smoke-fixture/site/index.html;

# 隔离来源的相对样式表：text/css，精确字节。
GET {{preview_base}}site/style.css
HTTP 200
[Asserts]
header "Content-Type" == "text/css; charset=utf-8"
file,fixtures/sandbox/u1/smoke-fixture/site/style.css;

# 伪造令牌（令牌段换成 64 个 0）：404 纯文本，不带 CSP。
GET {{preview_origin}}/w/0000000000000000000000000000000000000000000000000000000000000000/site/index.html
HTTP 404
[Asserts]
header "Content-Type" == "text/plain; charset=utf-8"
header "Content-Security-Policy" not exists
body == "预览不存在或已过期"

# 主站对同一 html：200 text/plain + nosniff，精确字节（主站来源不把工作空间文件当网页发）。
GET {{base_url}}/api/workspaces/{{workspace_id}}/file?path=site/index.html
HTTP 200
[Asserts]
header "Content-Type" == "text/plain; charset=utf-8"
header "X-Content-Type-Options" == "nosniff"
file,fixtures/sandbox/u1/smoke-fixture/site/index.html;

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

# 外账号下载该工作空间的文件：exact 404 not_found。
GET {{base_url}}/api/workspaces/{{workspace_id}}/download?path=readme.md
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# 外账号为该工作空间签发预览令牌：exact 404 not_found。
POST {{base_url}}/api/workspaces/{{workspace_id}}/preview-token
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# 外账号向该工作空间上传：exact 404 not_found。
POST {{base_url}}/api/workspaces/{{workspace_id}}/uploads?name=smoke-upload.txt
Content-Type: application/octet-stream
hex,776f726b6275646479;
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# 他账号登出。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""
