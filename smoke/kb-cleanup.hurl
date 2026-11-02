# 知识库冒烟的清理（kb-cleanup.hurl）：`make smoke-kb` 在 smoke/kb.hurl 之前与它失败之后各执行一次
# （verification-harness「知识库真实端点冒烟」「失败后清理」）。只经 app-server 删除 zhangsan 名下名为 `smoke-kb` 与
# `smoke-kb-compile` 的知识库（含上一次中断留下的同名库）；不存在即跳过，所以两个都不在时照样成功。它的失败不改变
# `make smoke-kb` 的退出码。
#
# 名称在同一所有者下唯一（server/src/kb/bases.ts `isBaseNameTaken`），每个名字至多一个库。Hurl 没有条件分支：先由库列表
# 的原始正文算出「不在」标志（`"name":"<名>"` 出现即在；名字后紧跟引号，`smoke-kb` 不会命中 `smoke-kb-compile`），
# 再以它作为后两步的 `skip`，取 id 与删除只在库存在时执行。`DELETE /api/kb/bases/:id` → 204（server/src/kb/rest.ts）。

# 登录：同 smoke/chat.hurl。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"zhangsan","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u1","account":"zhangsan","role":"成员"}

# 两个库各自是否不在。
GET {{base_url}}/api/kb/bases
HTTP 200
[Captures]
kb_absent: body replaceRegex /(?s)^.*"name":"smoke-kb".*$/ "[false]" replaceRegex /(?s)^\{.*$/ "[true]" jsonpath "$[0]"
compile_absent: body replaceRegex /(?s)^.*"name":"smoke-kb-compile".*$/ "[false]" replaceRegex /(?s)^\{.*$/ "[true]" jsonpath "$[0]"

# smoke-kb 在时取 id 并删除。
GET {{base_url}}/api/kb/bases
[Options]
skip: {{kb_absent}}
HTTP 200
[Captures]
kb_id: jsonpath "$.bases[?(@.name=='smoke-kb')].id"

DELETE {{base_url}}/api/kb/bases/{{kb_id}}
[Options]
skip: {{kb_absent}}
HTTP 204

# smoke-kb-compile 在时取 id 并删除。
GET {{base_url}}/api/kb/bases
[Options]
skip: {{compile_absent}}
HTTP 200
[Captures]
compile_id: jsonpath "$.bases[?(@.name=='smoke-kb-compile')].id"

DELETE {{base_url}}/api/kb/bases/{{compile_id}}
[Options]
skip: {{compile_absent}}
HTTP 204

# 两个库都不在了。
GET {{base_url}}/api/kb/bases
HTTP 200
[Asserts]
jsonpath "$.bases[?(@.name=='smoke-kb' || @.name=='smoke-kb-compile')]" not exists

# 登出。
POST {{base_url}}/api/auth/logout
HTTP 204
