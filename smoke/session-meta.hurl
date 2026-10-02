# 会话元数据冒烟（session-meta.hurl）：从空 cookie store 独立可运行，不依赖 public/auth/chat/files。
# 登录 zhangsan → 创建/采用 smoke-sessions（201 或 409）→ 列表按 name 取 id
# → (1) 绑定创建 201 八键 + session.bind 审计 → (2) 未知空间 404 / 多余键 400 且审计不变、无 body 创建 201
# → (3) PATCH title/scene/pinned、多余键 400、列表反映、取消置顶
# → (4) WORKBUDDY_THINK prompt → 作答唯一 bash 审批 → 仅 messages GET 有界重试至 done
# → (5) thinking 逐字、bash 步骤 done、标题仍为 PATCH 所设
# → (6) DELETE 204 + session.delete 审计 → messages 404 → 列表不含 → 再 DELETE 404
# → (7) lisi 绑定他人空间 / PATCH / DELETE 均 404 且 lisi 的会话数不变 → zhangsan 复核并删除无绑定会话 → 登出。
# 只由 make smoke 运行（smoke-live 不跑本文件），不使用 skip_turn_control；slash 白名单步骤由后续 issue 追加。
# 可重跑：工作空间保留供下次采用，自建会话在文件内删除，不留下 live authentication session 与 running 回合。
# 库与 SANDBOX_ROOT 必须同生命周期：库在而空间目录被清掉时，创建仍成功，但 (4) 的回合会因空间根不存在而失败。

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
{"name":"smoke-sessions"}
HTTP *
[Asserts]
status toString matches /^(201|409)$/

# 列表按 name 取唯一 id。
GET {{base_url}}/api/workspaces
HTTP 200
[Captures]
workspace_id: jsonpath "$.workspaces[?(@.name=='smoke-sessions')].id"
[Asserts]
jsonpath "$.workspaces[?(@.name=='smoke-sessions' && count($.workspaces[?(@.name=='smoke-sessions')])==1)]" exists
jsonpath "$.workspaces[?(@.name=='smoke-sessions')].id" exists

# (1) 绑定创建：exact 201，恰八键且逐键点名，title null、idle、scene code、workspaceId 为捕获值、pinnedAt null；捕获会话 id。不重试。
POST {{base_url}}/api/sessions
Content-Type: application/json
{"workspaceId":"{{workspace_id}}","scene":"code"}
HTTP 201
[Captures]
session_id: jsonpath "$.id"
[Asserts]
jsonpath "$.*" count == 8
jsonpath "$.id" matches "^[0-9a-f]{32}$"
jsonpath "$.title" == null
jsonpath "$.status" == "idle"
jsonpath "$.createdAt" isInteger
jsonpath "$.updatedAt" isInteger
jsonpath "$.scene" == "code"
jsonpath "$.workspaceId" == "{{workspace_id}}"
jsonpath "$.pinnedAt" == null

# (1) 最新审计是本次会话的 session.bind（detail.sessionId 区分同库上一轮留下的同类事件）。
GET {{base_url}}/api/audit?limit=1
HTTP 200
[Asserts]
jsonpath "$.events" count == 1
jsonpath "$.events[0].kind" == "session.bind"
jsonpath "$.events[0].actorId" == "u1"
jsonpath "$.events[0].workspaceId" == "{{workspace_id}}"
jsonpath "$.events[0].detail.sessionId" == "{{session_id}}"

# (2) 格式合法但不存在的工作空间：exact 404 not_found。不重试。
POST {{base_url}}/api/sessions
Content-Type: application/json
{"workspaceId":"00000000000000000000000000000000","scene":"code"}
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (2) 多余键：exact 400 bad_request。不重试。
POST {{base_url}}/api/sessions
Content-Type: application/json
{"scene":"code","color":"red"}
HTTP 400
{"error":{"code":"bad_request","message":"请求格式不正确"}}

# (2) 两次被拒的创建都不写审计：最新一条仍是本次会话的 session.bind。
GET {{base_url}}/api/audit?limit=1
HTTP 200
[Asserts]
jsonpath "$.events" count == 1
jsonpath "$.events[0].kind" == "session.bind"
jsonpath "$.events[0].detail.sessionId" == "{{session_id}}"

# (2) 无 body 创建照旧可用：exact 201，恰八键且逐键点名，workspaceId null、scene null；捕获无绑定会话 id。
# bodyless：无 Content-Type、无 body；不重试。
POST {{base_url}}/api/sessions
HTTP 201
[Captures]
other_id: jsonpath "$.id"
[Asserts]
jsonpath "$.*" count == 8
jsonpath "$.id" matches "^[0-9a-f]{32}$"
jsonpath "$.title" == null
jsonpath "$.status" == "idle"
jsonpath "$.createdAt" isInteger
jsonpath "$.updatedAt" isInteger
jsonpath "$.workspaceId" == null
jsonpath "$.scene" == null
jsonpath "$.pinnedAt" == null

# (3) PATCH title/scene/pinned：exact 200，恰八键且逐键点名，pinnedAt 为整数时间戳，id/status/workspaceId 不变。不重试。
PATCH {{base_url}}/api/sessions/{{session_id}}
Content-Type: application/json
{"title":"冒烟会话","scene":"design","pinned":true}
HTTP 200
[Asserts]
jsonpath "$.*" count == 8
jsonpath "$.id" == "{{session_id}}"
jsonpath "$.title" == "冒烟会话"
jsonpath "$.status" == "idle"
jsonpath "$.createdAt" isInteger
jsonpath "$.updatedAt" isInteger
jsonpath "$.scene" == "design"
jsonpath "$.pinnedAt" isInteger
jsonpath "$.workspaceId" == "{{workspace_id}}"

# (3) PATCH 多余键：exact 400 bad_request。不重试。
PATCH {{base_url}}/api/sessions/{{session_id}}
Content-Type: application/json
{"color":"red"}
HTTP 400
{"error":{"code":"bad_request","message":"请求格式不正确"}}

# (3) 列表反映 title/scene/置顶/工作空间。
GET {{base_url}}/api/sessions
HTTP 200
[Asserts]
jsonpath "$.sessions[?(@.id=='{{session_id}}')].title" == "冒烟会话"
jsonpath "$.sessions[?(@.id=='{{session_id}}')].scene" == "design"
jsonpath "$.sessions[?(@.id=='{{session_id}}')].pinnedAt" != null
jsonpath "$.sessions[?(@.id=='{{session_id}}')].workspaceId" == "{{workspace_id}}"

# (3) 取消置顶：exact 200，pinnedAt null，title/scene 不变。不重试。
PATCH {{base_url}}/api/sessions/{{session_id}}
Content-Type: application/json
{"pinned":false}
HTTP 200
[Asserts]
jsonpath "$.pinnedAt" == null
jsonpath "$.title" == "冒烟会话"
jsonpath "$.scene" == "design"

# (4) 发送含 WORKBUDDY_THINK 标记的 prompt：exact 202；捕获 assistantMessageId。不重试本 POST。
POST {{base_url}}/api/sessions/{{session_id}}/prompt
Content-Type: application/json
{"message":"WORKBUDDY_THINK 会话元数据冒烟"}
HTTP 202
[Captures]
assistant_id: jsonpath "$.assistantMessageId"
[Asserts]
jsonpath "$.assistantMessageId" exists

# (4) 审批轮询：有界 retry（约 20s，须 < 60s 自动允许）直到 captured assistant 恰一条 pending bash 审批。
GET {{base_url}}/api/sessions/{{session_id}}/messages
[Options]
retry: 40
retry-interval: 500ms
HTTP 200
[Captures]
approval_id: jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals[0].id"
[Asserts]
jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals" count == 1
jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals[0].decision" == null
jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals[0].tool" == "bash"

# (4) 作答 allow：exact 200，不重试；409 即真实故障。
POST {{base_url}}/api/sessions/{{session_id}}/approvals/{{approval_id}}
Content-Type: application/json
{"decision":"allow"}
HTTP 200
[Asserts]
jsonpath "$.id" == {{approval_id}}
jsonpath "$.tool" == "bash"
jsonpath "$.decision" == "allow"

# (4)(5) 轮询 messages：仅 GET 有界 retry（≥90s，覆盖 60s 自动允许），直到 captured assistant 与 session 均为 done。
# done 快照：正文匹配 content_pattern，thinking 逐字为受控上游的三分片拼接，bash 步骤 done、步骤全 done，
# 审批为作答的 allow，首条 prompt 不覆盖 PATCH 设下的标题。
GET {{base_url}}/api/sessions/{{session_id}}/messages
[Options]
retry: 180
retry-interval: 500ms
HTTP 200
[Asserts]
jsonpath "$.messages[?(@.id=={{assistant_id}})].status" == "done"
jsonpath "$.messages[?(@.id=={{assistant_id}})].content" matches "{{content_pattern}}"
jsonpath "$.messages[?(@.id=={{assistant_id}})].thinking" == "先读需求，再列要点，最后作答。"
jsonpath "$.messages[?(@.id=={{assistant_id}})].steps[?(@.name=='bash')].status" == "done"
jsonpath "$.messages[?(@.id=={{assistant_id}})].steps[?(@.status!='done')]" not exists
jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals[0].decision" == "allow"
jsonpath "$.session.status" == "done"
jsonpath "$.session.title" == "冒烟会话"

# (6) 删除已 done 的会话：exact 204、空 body。不重试。
DELETE {{base_url}}/api/sessions/{{session_id}}
HTTP 204
[Asserts]
body == ""

# (6) 最新审计是本次会话的 session.delete。
GET {{base_url}}/api/audit?limit=1
HTTP 200
[Asserts]
jsonpath "$.events" count == 1
jsonpath "$.events[0].kind" == "session.delete"
jsonpath "$.events[0].actorId" == "u1"
jsonpath "$.events[0].detail.sessionId" == "{{session_id}}"

# (6) 删除后读该会话：exact 404 not_found。
GET {{base_url}}/api/sessions/{{session_id}}/messages
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (6) 列表不再含该会话。
GET {{base_url}}/api/sessions
HTTP 200
[Asserts]
jsonpath "$.sessions[?(@.id=='{{session_id}}')]" not exists

# (6) 再次删除：exact 404 not_found。不重试。
DELETE {{base_url}}/api/sessions/{{session_id}}
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (7) 本账号登出：exact 204 + clear cookie。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""

# (7) 他账号登录。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"lisi","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u3","account":"lisi","role":"管理员"}

# (7) 越权尝试之前：记下 lisi 自己的会话数（服务归调用方所有，不假定为 0）。
GET {{base_url}}/api/sessions
HTTP 200
[Captures]
lisi_session_count: jsonpath "$.sessions" count

# (7) 他账号绑定 zhangsan 的工作空间建会话：exact 404 not_found（他人空间与未知空间不可区分）。不重试。
POST {{base_url}}/api/sessions
Content-Type: application/json
{"workspaceId":"{{workspace_id}}"}
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (7) 他账号 PATCH zhangsan 的会话：exact 404 not_found。不重试。
PATCH {{base_url}}/api/sessions/{{other_id}}
Content-Type: application/json
{"title":"x"}
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (7) 他账号 DELETE zhangsan 的会话：exact 404 not_found。不重试。
DELETE {{base_url}}/api/sessions/{{other_id}}
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (7) 越权尝试之后：lisi 的会话数不变（被拒的绑定创建没有留下会话行）。
GET {{base_url}}/api/sessions
HTTP 200
[Asserts]
jsonpath "$.sessions" count == {{lisi_session_count}}

# (7) 他账号登出。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""

# (7) 属主重新登录。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"zhangsan","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u1","account":"zhangsan","role":"成员"}

# (7) 无绑定会话仍在且标题仍为 null：他账号的 PATCH/DELETE 没有生效。
GET {{base_url}}/api/sessions/{{other_id}}/messages
HTTP 200
[Asserts]
jsonpath "$.session.title" == null

# (7) 属主删除无绑定会话：exact 204、空 body。不重试。
DELETE {{base_url}}/api/sessions/{{other_id}}
HTTP 204
[Asserts]
body == ""

# (7) 属主登出：exact 204 + clear cookie。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""
