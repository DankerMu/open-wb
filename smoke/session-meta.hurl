# 会话元数据冒烟（session-meta.hurl）：从空 cookie store 独立可运行，不依赖 public/auth/chat/files。
# 登录 zhangsan → 创建/采用 smoke-sessions（201 或 409）→ 列表按 name 取 id
# → (1) 绑定创建 201 十四键（三项输入框设置为缺省有效值）+ session.bind 审计 → (2) 未知空间 404 / 多余键 400 且审计不变、无 body 创建 201
#     带临时空间（列表不含、tree 200 且为空、显式绑定 404）
# → (3) PATCH title/scene/pinned、多余键 400、列表反映、取消置顶
# → (3c) 输入框设置：options 逐字 → 档位改 yolo + session.permission 审计（恰新增一条）→ options 缺省档位为 yolo
#     → 无 body 新建沿用 yolo + 创建审计（from null）→ 非法档位 400 → 改回 write + 审计 → options 复原
#     → 删除该新建会话 → 其临时空间 tree 404
# → (4) WORKBUDDY_THINK prompt → 作答唯一 bash 审批 → 仅 messages GET 有界重试至 done
# → (5) thinking 逐字、bash 步骤 done、标题仍为 PATCH 所设
# → (6) GET /api/commands 恰两条内建 → /todo 回合：omp 原文、无步骤、无 thinking
#     → /session WORKBUDDY_THINK 冒烟 回合：正文按原样落库、固定回复、thinking 逐字（转义文本到了模型）、无步骤
# → (7) DELETE 204 + session.delete 审计 → messages 404 → 列表不含 → 再 DELETE 404
# → (8) lisi 绑定他人空间 / PATCH / DELETE 均 404 且 lisi 的会话数不变 → zhangsan 复核该会话
#     → 归档 200（archivedAt 非 null）→ prompt 409 session_archived → 恢复 200（archivedAt null）
#     → 删除该会话 → 其临时空间 tree 404 → 登出。
# 只由 make smoke 运行（smoke-live 不跑本文件），不使用 skip_turn_control。
# 可重跑：工作空间保留供下次采用，自建会话在文件内删除，不留下 live authentication session 与 running 回合。
# 三项输入框设置的逐键断言只在缺省单模型配置的服务上成立（未设 MODEL_CATALOG / MODEL_ID / MODEL_REASONING，
# APPROVAL_MAX_MODE 未设或为 write / yolo）。
# (3c) 只动 zhangsan 的最近选择里的档位一列，并在本遍内改回 write（不动模型与推理强度，lisi 的不碰）。
# 在 (3c) 的改档位与恢复之间失败的一遍，会把 zhangsan 的最近选择留在 yolo：库若保留，下一遍 (1) 的 approvalMode 断言即判红。
# 恢复办法：以 zhangsan 对自己的任一会话 PATCH {"approvalMode":"write"}，或换一个新库（连同 SANDBOX_ROOT）。
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

# (1) 绑定创建：exact 201，恰十四键且逐键点名，title null、idle、scene code、workspaceId 为捕获值、pinnedAt 与 archivedAt null、pendingApproval 与 temporaryWorkspace false、
# approvalMode write、modelId deepseek-v4.1-flash、reasoningEffort high（三列为 NULL 时缺省单模型配置下的有效值）；捕获会话 id。不重试。
POST {{base_url}}/api/sessions
Content-Type: application/json
{"workspaceId":"{{workspace_id}}","scene":"code"}
HTTP 201
[Captures]
session_id: jsonpath "$.id"
[Asserts]
jsonpath "$.*" count == 14
jsonpath "$.id" matches "^[0-9a-f]{32}$"
jsonpath "$.title" == null
jsonpath "$.status" == "idle"
jsonpath "$.createdAt" isInteger
jsonpath "$.updatedAt" isInteger
jsonpath "$.scene" == "code"
jsonpath "$.workspaceId" == "{{workspace_id}}"
jsonpath "$.pinnedAt" == null
jsonpath "$.archivedAt" == null
jsonpath "$.pendingApproval" == false
jsonpath "$.temporaryWorkspace" == false
jsonpath "$.approvalMode" == "write"
jsonpath "$.modelId" == "deepseek-v4.1-flash"
jsonpath "$.reasoningEffort" == "high"

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

# (2) 无 body 创建现在带一个临时空间：exact 201，恰十四键且逐键点名，scene null、temporaryWorkspace true、三项输入框设置同 (1)、
# workspaceId 为 32 位十六进制；捕获该会话 id 与临时空间 id。bodyless：无 Content-Type、无 body；不重试。
POST {{base_url}}/api/sessions
HTTP 201
[Captures]
other_id: jsonpath "$.id"
temp_ws: jsonpath "$.workspaceId"
[Asserts]
jsonpath "$.*" count == 14
jsonpath "$.id" matches "^[0-9a-f]{32}$"
jsonpath "$.title" == null
jsonpath "$.status" == "idle"
jsonpath "$.createdAt" isInteger
jsonpath "$.updatedAt" isInteger
jsonpath "$.workspaceId" matches "^[0-9a-f]{32}$"
jsonpath "$.scene" == null
jsonpath "$.pinnedAt" == null
jsonpath "$.archivedAt" == null
jsonpath "$.pendingApproval" == false
jsonpath "$.temporaryWorkspace" == true
jsonpath "$.approvalMode" == "write"
jsonpath "$.modelId" == "deepseek-v4.1-flash"
jsonpath "$.reasoningEffort" == "high"

# (2) 工作空间列表不含该临时空间（采用的 smoke-sessions 仍在）。
GET {{base_url}}/api/workspaces
HTTP 200
[Asserts]
jsonpath "$.workspaces[?(@.id=='{{temp_ws}}')]" not exists
jsonpath "$.workspaces[?(@.id=='{{workspace_id}}')]" exists

# (2) 但按 id 可达：其目录树 exact 200，是一个空目录。
GET {{base_url}}/api/workspaces/{{temp_ws}}/tree
HTTP 200
[Asserts]
jsonpath "$.entries" count == 0

# (2) 临时空间不能被显式绑定：exact 404 not_found，与不存在的空间逐字相同。不重试。
POST {{base_url}}/api/sessions
Content-Type: application/json
{"workspaceId":"{{temp_ws}}"}
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (3) PATCH title/scene/pinned：exact 200，恰十四键且逐键点名，pinnedAt 为整数时间戳，id/status/workspaceId 与三项输入框设置不变。不重试。
PATCH {{base_url}}/api/sessions/{{session_id}}
Content-Type: application/json
{"title":"冒烟会话","scene":"design","pinned":true}
HTTP 200
[Asserts]
jsonpath "$.*" count == 14
jsonpath "$.id" == "{{session_id}}"
jsonpath "$.title" == "冒烟会话"
jsonpath "$.status" == "idle"
jsonpath "$.createdAt" isInteger
jsonpath "$.updatedAt" isInteger
jsonpath "$.scene" == "design"
jsonpath "$.pinnedAt" isInteger
jsonpath "$.workspaceId" == "{{workspace_id}}"
jsonpath "$.archivedAt" == null
jsonpath "$.pendingApproval" == false
jsonpath "$.temporaryWorkspace" == false
jsonpath "$.approvalMode" == "write"
jsonpath "$.modelId" == "deepseek-v4.1-flash"
jsonpath "$.reasoningEffort" == "high"

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

# (3c) 输入框设置的可选项：exact 200，body 逐字（缺省单模型配置：档位上界 yolo、推理开、上传 524288000 字节 / 10 个；
# 该账号的最近选择为空或 write）。请求不带 query：路由对任何 `?` 都回 400。
GET {{base_url}}/api/composer/options
HTTP 200
{"approvalModes":["always-ask","write","yolo"],"models":[{"id":"deepseek-v4.1-flash","name":"deepseek-v4.1-flash","reasoning":true,"vision":false,"efforts":["off","minimal","low","medium","high","xhigh","max"],"defaultEffort":"high"}],"defaults":{"approvalMode":"write","modelId":"deepseek-v4.1-flash","reasoningEffort":"high"},"upload":{"maxBytes":524288000,"maxFiles":10}}

# (3c) 改档位：exact 200，恰十四键，approvalMode yolo，title/scene 与另两项设置不变。不重试。
# 本文件不对非 write 的会话发 prompt：(4) 之前改回 write。
PATCH {{base_url}}/api/sessions/{{session_id}}
Content-Type: application/json
{"approvalMode":"yolo"}
HTTP 200
[Asserts]
jsonpath "$.*" count == 14
jsonpath "$.id" == "{{session_id}}"
jsonpath "$.approvalMode" == "yolo"
jsonpath "$.title" == "冒烟会话"
jsonpath "$.scene" == "design"
jsonpath "$.modelId" == "deepseek-v4.1-flash"
jsonpath "$.reasoningEffort" == "high"

# (3c) 恰新增一条审计：最新为本会话的 session.permission（write → yolo），其前一条仍是 (1) 的 session.bind
# （(2) 的无 body 创建与 (3) 的 PATCH 都不写审计；非管理员只见自己的事件）。捕获该审计 id。
GET {{base_url}}/api/audit?limit=2
HTTP 200
[Captures]
perm_audit_id: jsonpath "$.events[0].id"
[Asserts]
jsonpath "$.events" count == 2
jsonpath "$.events[0].kind" == "session.permission"
jsonpath "$.events[0].title" == "修改权限档位"
jsonpath "$.events[0].actorId" == "u1"
jsonpath "$.events[0].workspaceId" == "{{workspace_id}}"
jsonpath "$.events[0].detail.sessionId" == "{{session_id}}"
jsonpath "$.events[0].detail.from" == "write"
jsonpath "$.events[0].detail.to" == "yolo"
jsonpath "$.events[1].kind" == "session.bind"
jsonpath "$.events[1].detail.sessionId" == "{{session_id}}"

# (3c) 最近选择已记下：options 的缺省档位随之为 yolo。
GET {{base_url}}/api/composer/options
HTTP 200
[Asserts]
jsonpath "$.defaults.approvalMode" == "yolo"

# (3c) 无 body 新建的会话沿用最近选择：exact 201，恰十四键，approvalMode yolo，带临时空间；捕获会话 id 与临时空间 id。
# bodyless：无 Content-Type、无 body；不重试。该会话从不 prompt，本块结束前删除。
POST {{base_url}}/api/sessions
HTTP 201
[Captures]
composer_id: jsonpath "$.id"
composer_ws: jsonpath "$.workspaceId"
[Asserts]
jsonpath "$.*" count == 14
jsonpath "$.id" matches "^[0-9a-f]{32}$"
jsonpath "$.workspaceId" matches "^[0-9a-f]{32}$"
jsonpath "$.approvalMode" == "yolo"
jsonpath "$.temporaryWorkspace" == true
jsonpath "$.scene" == null

# (3c) 继承来的非缺省档在创建时写一条 session.permission（from null → yolo，workspaceId 为其临时空间）；
# 其前一条是上面那次改档位的审计（临时空间创建不写 workspace.create）。捕获该审计 id。
GET {{base_url}}/api/audit?limit=2
HTTP 200
[Captures]
create_audit_id: jsonpath "$.events[0].id"
[Asserts]
jsonpath "$.events" count == 2
jsonpath "$.events[0].kind" == "session.permission"
jsonpath "$.events[0].title" == "修改权限档位"
jsonpath "$.events[0].actorId" == "u1"
jsonpath "$.events[0].workspaceId" == "{{composer_ws}}"
jsonpath "$.events[0].detail.sessionId" == "{{composer_id}}"
jsonpath "$.events[0].detail.from" == null
jsonpath "$.events[0].detail.to" == "yolo"
jsonpath "$.events[1].id" == {{perm_audit_id}}

# (3c) 枚举外的档位：exact 400 bad_request。不重试。
PATCH {{base_url}}/api/sessions/{{session_id}}
Content-Type: application/json
{"approvalMode":"auto"}
HTTP 400
{"error":{"code":"bad_request","message":"请求格式不正确"}}

# (3c) 恢复：把档位（连同该账号的最近选择）改回 write：exact 200。不重试。
PATCH {{base_url}}/api/sessions/{{session_id}}
Content-Type: application/json
{"approvalMode":"write"}
HTTP 200
[Asserts]
jsonpath "$.*" count == 14
jsonpath "$.approvalMode" == "write"

# (3c) 最新审计是这次恢复（yolo → write）；其前一条是创建审计：被拒的 auto 没有写审计。
GET {{base_url}}/api/audit?limit=2
HTTP 200
[Asserts]
jsonpath "$.events" count == 2
jsonpath "$.events[0].kind" == "session.permission"
jsonpath "$.events[0].workspaceId" == "{{workspace_id}}"
jsonpath "$.events[0].detail.sessionId" == "{{session_id}}"
jsonpath "$.events[0].detail.from" == "yolo"
jsonpath "$.events[0].detail.to" == "write"
jsonpath "$.events[1].id" == {{create_audit_id}}

# (3c) 最近选择已恢复：options 的 body 与本块开头逐字相同（本遍内见证，不留给下一遍）。
GET {{base_url}}/api/composer/options
HTTP 200
{"approvalModes":["always-ask","write","yolo"],"models":[{"id":"deepseek-v4.1-flash","name":"deepseek-v4.1-flash","reasoning":true,"vision":false,"efforts":["off","minimal","low","medium","high","xhigh","max"],"defaultEffort":"high"}],"defaults":{"approvalMode":"write","modelId":"deepseek-v4.1-flash","reasoningEffort":"high"},"upload":{"maxBytes":524288000,"maxFiles":10}}

# (3c) 删除沿用 yolo 的那个会话（从未 prompt、未起进程）：exact 204、空 body。不重试。
DELETE {{base_url}}/api/sessions/{{composer_id}}
HTTP 204
[Asserts]
body == ""

# (3c) 它的临时空间随之消失：目录树 exact 404 not_found。
GET {{base_url}}/api/workspaces/{{composer_ws}}/tree
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

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

# (6) 命令目录：exact 200，恰两条内建，name 依次 compact、todo（冒烟状态目录不装 skill）。
GET {{base_url}}/api/commands
HTTP 200
[Asserts]
jsonpath "$.commands" count == 2
jsonpath "$.commands[0].name" == "compact"
jsonpath "$.commands[0].source" == "builtin"
jsonpath "$.commands[1].name" == "todo"
jsonpath "$.commands[1].source" == "builtin"

# (6) 白名单内的 /todo：exact 202；捕获用户与助手消息 id。不重试本 POST。
POST {{base_url}}/api/sessions/{{session_id}}/prompt
Content-Type: application/json
{"message":"/todo"}
HTTP 202
[Captures]
todo_assistant_id: jsonpath "$.assistantMessageId"
todo_user_id: jsonpath "$.userMessageId"
[Asserts]
jsonpath "$.userMessageId" exists
jsonpath "$.assistantMessageId" exists

# (6) 轮询 messages：仅 GET 有界 retry（约 20s；内建命令不经模型、没有审批），直到 /todo 的助手与 session 均为 done。
# 正文逐字为真 omp 的 command_output；steps、approvals 为空数组（按 id 过滤出唯一一条消息后，count 数的是该数组的元素，
# 消息或字段缺失时不通过）；thinking 为 null（没有经过模型）；用户正文 /todo；标题不被本回合改动。
GET {{base_url}}/api/sessions/{{session_id}}/messages
[Options]
retry: 40
retry-interval: 500ms
HTTP 200
[Asserts]
jsonpath "$.messages[?(@.id=={{todo_assistant_id}})].status" == "done"
jsonpath "$.messages[?(@.id=={{todo_assistant_id}})].content" == "No todos. Use /todo append <task> to start one."
jsonpath "$.messages[?(@.id=={{todo_assistant_id}})].steps" count == 0
jsonpath "$.messages[?(@.id=={{todo_assistant_id}})].approvals" count == 0
jsonpath "$.messages[?(@.id=={{todo_assistant_id}})].thinking" == null
jsonpath "$.messages[?(@.id=={{todo_user_id}})].content" == "/todo"
jsonpath "$.session.status" == "done"
jsonpath "$.session.title" == "冒烟会话"

# (6) 白名单外的 /session（omp 的真内建，不转义会被 omp 当命令执行），文本里带 WORKBUDDY_THINK 标记：exact 202；
# 捕获用户与助手消息 id。不重试本 POST。
POST {{base_url}}/api/sessions/{{session_id}}/prompt
Content-Type: application/json
{"message":"/session WORKBUDDY_THINK 冒烟"}
HTTP 202
[Captures]
session_cmd_assistant_id: jsonpath "$.assistantMessageId"
session_cmd_user_id: jsonpath "$.userMessageId"
[Asserts]
jsonpath "$.userMessageId" exists
jsonpath "$.assistantMessageId" exists

# (6) 轮询 messages：仅 GET 有界 retry（约 20s，须 < 60s 自动允许：出现待审批即失败），直到该助手与 session 均为 done。
# 用户正文按所发文本落库（无前导空格）；助手正文匹配 content_pattern（由模型作答，而非 omp 的 /session usage 文本）；
# 固定回复与输入无关，thinking 才是内容见证：受控上游只对最新用户消息里的 WORKBUDDY_THINK 给出这段思考，
# 逐字相等即转义后的文本连同标记到了模型。会话里已有 (4) 的工具结果，受控上游不再发工具轮：steps、approvals 为空数组。
GET {{base_url}}/api/sessions/{{session_id}}/messages
[Options]
retry: 40
retry-interval: 500ms
HTTP 200
[Asserts]
jsonpath "$.messages[?(@.id=={{session_cmd_user_id}})].content" == "/session WORKBUDDY_THINK 冒烟"
jsonpath "$.messages[?(@.id=={{session_cmd_assistant_id}})].status" == "done"
jsonpath "$.messages[?(@.id=={{session_cmd_assistant_id}})].content" matches "{{content_pattern}}"
jsonpath "$.messages[?(@.id=={{session_cmd_assistant_id}})].thinking" == "先读需求，再列要点，最后作答。"
jsonpath "$.messages[?(@.id=={{session_cmd_assistant_id}})].steps" count == 0
jsonpath "$.messages[?(@.id=={{session_cmd_assistant_id}})].approvals" count == 0
jsonpath "$.session.status" == "done"

# (7) 删除已 done 的会话：exact 204、空 body。不重试。
DELETE {{base_url}}/api/sessions/{{session_id}}
HTTP 204
[Asserts]
body == ""

# (7) 最新审计是本次会话的 session.delete。
GET {{base_url}}/api/audit?limit=1
HTTP 200
[Asserts]
jsonpath "$.events" count == 1
jsonpath "$.events[0].kind" == "session.delete"
jsonpath "$.events[0].actorId" == "u1"
jsonpath "$.events[0].detail.sessionId" == "{{session_id}}"

# (7) 删除后读该会话：exact 404 not_found。
GET {{base_url}}/api/sessions/{{session_id}}/messages
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (7) 列表不再含该会话。
GET {{base_url}}/api/sessions
HTTP 200
[Asserts]
jsonpath "$.sessions[?(@.id=='{{session_id}}')]" not exists

# (7) 再次删除：exact 404 not_found。不重试。
DELETE {{base_url}}/api/sessions/{{session_id}}
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (8) 本账号登出：exact 204 + clear cookie。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""

# (8) 他账号登录。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"lisi","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u3","account":"lisi","role":"管理员"}

# (8) 越权尝试之前：记下 lisi 自己的会话数（服务归调用方所有，不假定为 0）。
GET {{base_url}}/api/sessions
HTTP 200
[Captures]
lisi_session_count: jsonpath "$.sessions" count

# (8) 他账号绑定 zhangsan 的工作空间建会话：exact 404 not_found（他人空间与未知空间不可区分）。不重试。
POST {{base_url}}/api/sessions
Content-Type: application/json
{"workspaceId":"{{workspace_id}}"}
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (8) 他账号 PATCH zhangsan 的会话：exact 404 not_found。不重试。
PATCH {{base_url}}/api/sessions/{{other_id}}
Content-Type: application/json
{"title":"x"}
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (8) 他账号 DELETE zhangsan 的会话：exact 404 not_found。不重试。
DELETE {{base_url}}/api/sessions/{{other_id}}
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (8) 越权尝试之后：lisi 的会话数不变（被拒的绑定创建没有留下会话行）。
GET {{base_url}}/api/sessions
HTTP 200
[Asserts]
jsonpath "$.sessions" count == {{lisi_session_count}}

# (8) 他账号登出。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""

# (8) 属主重新登录。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"zhangsan","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u1","account":"zhangsan","role":"成员"}

# (8) 该会话仍在且标题仍为 null：他账号的 PATCH/DELETE 没有生效。
GET {{base_url}}/api/sessions/{{other_id}}/messages
HTTP 200
[Asserts]
jsonpath "$.session.title" == null

# (8) 属主归档该会话：exact 200，恰十四键，archivedAt 为整数时间戳。不重试。
PATCH {{base_url}}/api/sessions/{{other_id}}
Content-Type: application/json
{"archived":true}
HTTP 200
[Asserts]
jsonpath "$.*" count == 14
jsonpath "$.archivedAt" isInteger

# (8) 已归档的会话拒绝 prompt：exact 409 session_archived。不重试。
POST {{base_url}}/api/sessions/{{other_id}}/prompt
Content-Type: application/json
{"message":"hi"}
HTTP 409
{"error":{"code":"session_archived","message":"会话已归档，恢复后才能继续对话"}}

# (8) 属主恢复该会话：exact 200，archivedAt null。不重试。
PATCH {{base_url}}/api/sessions/{{other_id}}
Content-Type: application/json
{"archived":false}
HTTP 200
[Asserts]
jsonpath "$.archivedAt" == null

# (8) 属主删除该会话：exact 204、空 body。不重试。
DELETE {{base_url}}/api/sessions/{{other_id}}
HTTP 204
[Asserts]
body == ""

# (8) 临时空间随它的最后一个会话消失：目录树 exact 404 not_found。
GET {{base_url}}/api/workspaces/{{temp_ws}}/tree
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# (8) 属主登出：exact 204 + clear cookie。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""
