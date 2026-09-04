# 认证生命周期（auth.hurl）：从空 cookie store 独立可运行；Hurl in-file cookie store
# 完成 登录 → 已认证 404 → 登出 → 登出后 401 的单一 cookie 身份链。
# 失败（错误密码/停用账号）绝不建立 cookie；显式 forged cookie 在 public.hurl 边界内。

# 错误密码：exact 401 invalid_credentials 信封，且不发 session cookie。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"zhangsan","password":"wrong"}
HTTP 401
[Asserts]
header "Set-Cookie" not exists
{"error":{"code":"invalid_credentials","message":"账号或密码不正确"}}

# 停用账号（密码正确）：exact 403 account_disabled 信封，且不发 session cookie。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"wangwu","password":"demo"}
HTTP 403
[Asserts]
header "Set-Cookie" not exists
{"error":{"code":"account_disabled","message":"该账号已停用，请联系管理员"}}

# 成功登录：exact 200 Principal + 合规 session cookie（64 lowercase hex、HttpOnly、
# SameSite=Lax、Path=/、无 Domain/Expires/Max-Age）。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"zhangsan","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
cookie "workbuddy_session[HttpOnly]" exists
cookie "workbuddy_session[SameSite]" == "Lax"
cookie "workbuddy_session[Path]" == "/"
cookie "workbuddy_session[Domain]" not exists
cookie "workbuddy_session[Expires]" not exists
cookie "workbuddy_session[Max-Age]" not exists
header "Set-Cookie" matches "^workbuddy_session=[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Lax$"
{"id":"u1","account":"zhangsan","role":"成员"}

# 共享 in-file cookie 请求受保护 unknown API：exact 已认证 404 not_found 信封。
GET {{base_url}}/api/no-such
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# Bodyless POST 登出：exact 204、空 body、no-store、exact clear Set-Cookie。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Cache-Control" == "no-store"
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""

# 登出后受保护请求：exact 401 unauthorized。in-file cookie store 中 clear-cookie 已撤销身份。
GET {{base_url}}/api/no-such
HTTP 401
{"error":{"code":"unauthorized","message":"请先登录"}}
