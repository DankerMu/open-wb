# 公开面（public.hurl）：从空 cookie store 独立可运行，不产生/消费任何 cookie 状态。
# 深链 exact-byte 合同仅当服务以 STATIC_ROOT=<repo>/smoke/fixtures/static 启动时成立。

# healthz：exact 200 + exact body。
GET {{base_url}}/api/healthz
HTTP 200
{"status":"ok"}

# info：exact 200 + exact service identity。
GET {{base_url}}/api/info
HTTP 200
{"name":"workbuddy-app-server","version":"0.0.0"}

# 无 cookie 访问受保护 unknown API：exact 401 unauthorized 信封。
GET {{base_url}}/api/no-such
HTTP 401
{"error":{"code":"unauthorized","message":"请先登录"}}

# 显式伪造 64-lowercase-hex session cookie：同样 exact 401，且该 cookie 只属于本请求。
GET {{base_url}}/api/no-such
Cookie: workbuddy_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
HTTP 401
{"error":{"code":"unauthorized","message":"请先登录"}}

# 紧接的无显式 cookie 请求不含上文伪造值：证明 forged cookie 未进入共享 cookie store。
GET {{base_url}}/api/no-such
HTTP 401
{"error":{"code":"unauthorized","message":"请先登录"}}

# 深链 fallback：exact 200 + exact Content-Type + tracked fixture exact bytes。
GET {{base_url}}/files?smoke=deep-link
HTTP 200
[Asserts]
header "Content-Type" == "text/html; charset=utf-8"
file,fixtures/static/index.html;
