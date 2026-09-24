# 对话冒烟（chat.hurl）：从空 cookie store 独立可运行，不依赖 public/auth。
# 登录 → 创建201 → prompt202 → 仅 messages GET 有界重试至 captured assistant/session done。
# 正文匹配 content_pattern，bash 步骤 >= min_bash_steps，步骤全 done；他账号404；无 bearer 代理401。
# 两账号均登出，不留下 live authentication session。

# 成功登录：exact 200 Principal + 合规 session cookie。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"zhangsan","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u1","account":"zhangsan","role":"成员"}

# 创建会话：exact 201 idle、title null；捕获会话 id。
POST {{base_url}}/api/sessions
HTTP 201
[Captures]
session_id: jsonpath "$.id"
[Asserts]
jsonpath "$.title" == null
jsonpath "$.status" == "idle"

# 发送 prompt：exact 202；捕获 assistantMessageId。不重试本 POST。
POST {{base_url}}/api/sessions/{{session_id}}/prompt
Content-Type: application/json
{"message":"你好"}
HTTP 202
[Captures]
assistant_id: jsonpath "$.assistantMessageId"
[Asserts]
jsonpath "$.userMessageId" exists
jsonpath "$.assistantMessageId" exists

# 轮询 messages：仅本 GET 有界 retry，直到 captured assistant 与 session 均为 done。
GET {{base_url}}/api/sessions/{{session_id}}/messages
[Options]
retry: 40
retry-interval: 500ms
HTTP 200
[Asserts]
jsonpath "$.messages[?(@.id=={{assistant_id}})].status" == "done"
jsonpath "$.messages[?(@.id=={{assistant_id}})].content" matches "{{content_pattern}}"
jsonpath "$.messages[?(@.id=={{assistant_id}} && count(@.steps[?(@.name=='bash')]) >= {{min_bash_steps}})]" exists
jsonpath "$.messages[?(@.id=={{assistant_id}})].steps[?(@.status!='done')]" not exists
jsonpath "$.session.status" == "done"

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

# 他账号读该会话：exact 404 not_found。
GET {{base_url}}/api/sessions/{{session_id}}/messages
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# 他账号登出。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""

# 无 cookie、无 bearer 的模型代理：exact 401 unauthorized。
POST {{base_url}}/v1/chat/completions
Content-Type: application/json
{"messages":[]}
HTTP 401
{"error":{"code":"unauthorized","message":"请先登录"}}
